/**
 * HTTP のファイルサーバーのファイルソース（Issue #172・#119・#344・#367。ADR-0022・ADR-0023・ADR-0025・ADR-0026）。
 * 接続設定（HTTP）に従い、秘密情報（SecretPort）から認証のヘッダーを組み立て、**設備ごとのファイルパス**（設備の `sourceFilePath`）に、
 * 接続テスト・一覧（メタデータ）・取得のリクエストを送る。取り込み元の種別（ロボット・センサー）に合う、有効な設備が対象。
 * 接続は、**設備ごと**だけ（認証情報も、設備ごと）。接続がない設備は、「接続先が設定されていません」の失敗にする
 * （取得の対象の設備がなければ、何もしない。一覧は空）。
 * 一覧は、設備ごとに、その設備の接続で問い合わせる。`onFailure` があれば、設備ごとの失敗を、投げずに渡して、ほかの設備を続ける
 * （1 つの設備の接続の失敗が、ほかの設備の取り込みを止めない）。
 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { HttpFileServerConnection } from '@smart-farm/shared/schemas/ingestion';
import {
  FileSourceFailure,
  FileSourceUnavailableError,
  type FileMeta,
  type FileSourcePort,
} from '../ports/file-source-port.ts';
import type { EquipmentRepository } from '../ports/repositories.ts';
import type { SecretPort } from '../ports/secret-port.ts';
import { buildAuthHeaders, fileServerEquipmentSecretReference } from './file-server-credentials.ts';
import type { EquipmentConnections } from './equipment-connections.ts';
import type { IngestionSettings } from './ingestion-settings.ts';

/** HTTP のリクエストの指定（接続先・ファイルのパス・認証のヘッダー）。 */
export interface HttpFileRequest {
  readonly connection: HttpFileServerConnection;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** HTTP のファイルのメタデータ。サーバーが示さない項目は、undefined。 */
export interface HttpFileStat {
  readonly sizeBytes?: number;
  readonly modifiedAt?: Date;
}

/** HTTP のファイルへのアクセス（インフラの実装を、差し込む）。失敗は、FileSourceFailure。 */
export interface HttpFileClient {
  /** ファイルがあることを確かめる（接続テスト）。 */
  probe(request: HttpFileRequest): Promise<void>;
  /** ファイルの大きさ・更新日時を得る。 */
  stat(request: HttpFileRequest): Promise<HttpFileStat>;
  /** ファイルの内容（UTF-8）を得る。`maxBytes` を超える大きさは、TOO_LARGE で失敗する。 */
  read(request: HttpFileRequest & { readonly maxBytes: number }): Promise<string>;
}

export interface RoutingFileSourceDeps {
  readonly ingestionSettings: Pick<IngestionSettings, 'listSources'>;
  /** 設備ごとの接続（Issue #367。ADR-0026）。設備に接続がなければ、「接続先が設定されていません」の失敗にする。 */
  readonly equipmentConnections: Pick<EquipmentConnections, 'list'>;
  readonly equipment: Pick<EquipmentRepository, 'list'>;
  readonly secrets: SecretPort;
  readonly http: HttpFileClient;
  /** 取得するファイルの大きさの上限（バイト）。 */
  readonly maxFileBytes: number;
}

/** 更新日時を示さないサーバーのファイルの更新日時。「書き換えの直後」とみなされないよう、古い日時にする（D-08）。 */
const UNKNOWN_MODIFIED_AT = new Date(0);

interface HttpSource {
  readonly sourceId: string;
  readonly kind: Equipment['equipmentType'];
}

/** 取得の対象（設備のファイル）。接続は、設備ごとに解決済み。 */
interface Target {
  readonly equipmentId: string;
  readonly path: string;
  /** 設備の接続。なければ、undefined。 */
  readonly connection: HttpFileServerConnection | undefined;
  /** 認証情報の、秘密情報の参照名（設備ごと）。接続がなければ、undefined。 */
  readonly secretReference: string | undefined;
}

/** 接続が解決できた対象。 */
type ConnectedTarget = Target & {
  readonly connection: HttpFileServerConnection;
  readonly secretReference: string;
};

function isConnected(target: Target): target is ConnectedTarget {
  return target.connection !== undefined && target.secretReference !== undefined;
}

function sortFiles(files: FileMeta[]): FileMeta[] {
  return files.sort(
    (left, right) =>
      left.modifiedAt.getTime() - right.modifiedAt.getTime() ||
      left.fileId.localeCompare(right.fileId),
  );
}

/** 設備 1 つの接続の解決（設備の接続だけ）と、認証情報の参照名。 */
function resolveConnection(
  equipmentId: string,
  own: ReadonlyMap<string, HttpFileServerConnection>,
): Pick<Target, 'connection' | 'secretReference'> {
  const connection = own.get(equipmentId);
  return connection === undefined
    ? { connection: undefined, secretReference: undefined }
    : { connection, secretReference: fileServerEquipmentSecretReference(equipmentId) };
}

export function createRoutingFileSource(deps: RoutingFileSourceDeps): FileSourcePort {
  const { ingestionSettings, equipmentConnections, equipment, secrets, http, maxFileBytes } = deps;

  /** 取り込み元の設定。取り込み元がなければ、利用できない旨の失敗にする。 */
  async function sourceOf(sourceId: string): Promise<HttpSource> {
    const sources = await ingestionSettings.listSources();
    const source = sources.find((candidate) => candidate.sourceId === sourceId);
    if (source === undefined) {
      throw new FileSourceUnavailableError('取り込み元がありません');
    }
    return { sourceId, kind: source.kind };
  }

  /**
   * 取得の対象（取り込み元の種別に合う、有効な設備の、ファイルパスと、解決した接続）。設備 ID の順。
   * `paths` を指定すると、そのパスの設備だけ（設備ごとの取得間隔。Issue #197）。設備ごとの接続は、1 回の操作で 1 回だけ読む。
   */
  async function targetsOf(source: HttpSource, paths?: readonly string[]): Promise<Target[]> {
    const wanted = paths === undefined ? undefined : new Set(paths);
    const items = (await equipment.list())
      .filter(
        (item) =>
          item.equipmentType === source.kind &&
          item.sourceFilePath !== undefined &&
          (wanted === undefined || wanted.has(item.sourceFilePath)),
      )
      .sort((left, right) => left.equipmentId.localeCompare(right.equipmentId));
    if (items.length === 0) {
      return [];
    }
    const own = await equipmentConnections.list();
    return items.map((item) => ({
      equipmentId: item.equipmentId,
      path: item.sourceFilePath ?? '',
      ...resolveConnection(item.equipmentId, own),
    }));
  }

  /** 認証情報を読む。保管先の障害は、理由だけを伝える（内部の情報を、利用者に見せない）。 */
  async function readSecret(reference: string, refresh: boolean): Promise<string | undefined> {
    try {
      return await secrets.get(reference, refresh ? { refresh } : undefined);
    } catch (cause) {
      throw new FileSourceFailure('CREDENTIALS_UNAVAILABLE', { cause });
    }
  }

  /**
   * 認証のヘッダーを付けて、操作を実行する。認証に失敗したときは、キャッシュを使わずに秘密情報を取り直し、値が変わっていれば、
   * 1 度だけ再試行する（認証情報の更新が、キャッシュの期間（5 分）の間に、反映されないのを避ける）。認証情報は、設備ごとの参照名で読む。
   */
  async function withAuth<T>(
    target: ConnectedTarget,
    operation: (headers: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const { connection, secretReference } = target;
    if (connection.authMethod === 'NONE') {
      return operation({});
    }
    const value = await readSecret(secretReference, false);
    try {
      return await operation(buildAuthHeaders(connection, value));
    } catch (error) {
      if (!(error instanceof FileSourceFailure) || error.reason !== 'AUTH_FAILED') {
        throw error;
      }
      const fresh = await readSecret(secretReference, true);
      if (fresh === value) {
        throw error;
      }
      return operation(buildAuthHeaders(connection, fresh));
    }
  }

  function probeTarget(target: ConnectedTarget): Promise<void> {
    return withAuth(target, (headers) =>
      http.probe({ connection: target.connection, path: target.path, headers }),
    );
  }

  async function statTarget(target: Target): Promise<FileMeta> {
    if (!isConnected(target)) {
      throw new FileSourceFailure('NOT_CONFIGURED');
    }
    const stat = await withAuth(target, (headers) =>
      http.stat({ connection: target.connection, path: target.path, headers }),
    );
    return {
      fileId: target.path,
      name: target.path.slice(target.path.lastIndexOf('/') + 1),
      modifiedAt: stat.modifiedAt ?? UNKNOWN_MODIFIED_AT,
      sizeBytes: stat.sizeBytes ?? 0,
    };
  }

  return {
    async testEquipment(equipmentId) {
      const found = (await equipment.list()).find((item) => item.equipmentId === equipmentId);
      if (found === undefined || found.isDeleted) {
        throw new FileSourceUnavailableError('設備がありません');
      }
      const { equipmentType, sourceFilePath } = found;
      if (
        (equipmentType !== 'ROBOT' && equipmentType !== 'SENSOR') ||
        sourceFilePath === undefined
      ) {
        throw new FileSourceFailure('NO_FILE_PATH');
      }
      const target: Target = {
        equipmentId: found.equipmentId,
        path: sourceFilePath,
        ...resolveConnection(found.equipmentId, await equipmentConnections.list()),
      };
      if (!isConnected(target)) {
        throw new FileSourceFailure('NOT_CONFIGURED');
      }
      await probeTarget(target);
    },

    async listFiles(sourceId, options) {
      const source = await sourceOf(sourceId);
      const files: FileMeta[] = [];
      for (const target of await targetsOf(source, options?.paths)) {
        try {
          files.push(await statTarget(target));
        } catch (error) {
          // まだ置かれていない（見つからない）ファイルは、一覧に含めない
          if (error instanceof FileSourceFailure && error.reason === 'NOT_FOUND') {
            continue;
          }
          // ほかの失敗（認証・接続・未設定など）は、設備ごとの失敗の受け取りがあれば、その設備を飛ばして続ける。なければ、最初の失敗を投げる
          if (!(error instanceof FileSourceUnavailableError) || options?.onFailure === undefined) {
            throw error;
          }
          options.onFailure({ path: target.path, error });
        }
      }
      return sortFiles(files);
    },

    async readFile(sourceId, fileId) {
      const source = await sourceOf(sourceId);
      // 設備に設定されたファイルパスだけを取得する（任意のパスを、取得させない）。接続が解決できない設備も、見つからないものとして扱う
      const target = (await targetsOf(source)).find(
        (candidate) => candidate.path === fileId && isConnected(candidate),
      );
      if (target === undefined || !isConnected(target)) {
        throw new FileSourceFailure('NOT_FOUND');
      }
      return withAuth(target, (headers) =>
        http.read({
          connection: target.connection,
          path: fileId,
          headers,
          maxBytes: maxFileBytes,
        }),
      );
    },
  };
}
