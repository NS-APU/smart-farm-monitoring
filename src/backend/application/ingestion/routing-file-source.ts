/**
 * 接続方式で振り分けるファイルソース（Issue #172・#119。ADR-0022・ADR-0023）。
 * 取り込み元の接続設定（connection）が MOCK のときは、これまでのファイルソース（モック・S3）へ渡す。
 * HTTP のときは、秘密情報（SecretPort）から認証のヘッダーを組み立て、**設備ごとのファイルパス**（設備の `sourceFilePath`）に、
 * 接続テスト・一覧（メタデータ）・取得のリクエストを送る。取り込み元の種別（ロボット・センサー）に合う、有効な設備が対象。
 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { HttpFileServerConnection } from '@smart-farm/shared/schemas/ingestion';
import {
  FileSourceFailure,
  type FileMeta,
  type FileSourcePort,
} from '../ports/file-source-port.ts';
import type { EquipmentRepository } from '../ports/repositories.ts';
import type { SecretPort } from '../ports/secret-port.ts';
import { buildAuthHeaders, fileServerSecretReference } from './file-server-credentials.ts';
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
  /** 接続方式が MOCK の取り込み元、および、設定にない取り込み元の、ファイルソース。 */
  readonly base: FileSourcePort;
  readonly ingestionSettings: Pick<IngestionSettings, 'listSources'>;
  readonly equipment: Pick<EquipmentRepository, 'list'>;
  readonly secrets: SecretPort;
  readonly http: HttpFileClient;
  /** 取得するファイルの大きさの上限（バイト）。 */
  readonly maxFileBytes: number;
}

/** 更新日時を示さないサーバーのファイルの更新日時。「書き換えの直後」とみなされないよう、古い日時にする（D-08）。 */
const UNKNOWN_MODIFIED_AT = new Date(0);

interface HttpSource {
  readonly connection: HttpFileServerConnection;
  readonly kind: Equipment['equipmentType'];
}

interface Target {
  readonly path: string;
}

export function createRoutingFileSource(deps: RoutingFileSourceDeps): FileSourcePort {
  const { base, ingestionSettings, equipment, secrets, http, maxFileBytes } = deps;

  async function httpSourceOf(sourceId: string): Promise<HttpSource | undefined> {
    const sources = await ingestionSettings.listSources();
    const source = sources.find((candidate) => candidate.sourceId === sourceId);
    return source?.connection.type === 'HTTP'
      ? { connection: source.connection, kind: source.kind }
      : undefined;
  }

  /**
   * 取得の対象（取り込み元の種別に合う、有効な設備の、ファイルパス）。設備 ID の順。
   * `paths` を指定すると、そのパスの設備だけ（設備ごとの取得間隔。Issue #197）。
   */
  async function targetsOf(kind: HttpSource['kind'], paths?: readonly string[]): Promise<Target[]> {
    const wanted = paths === undefined ? undefined : new Set(paths);
    return (await equipment.list())
      .filter(
        (item) =>
          item.equipmentType === kind &&
          item.sourceFilePath !== undefined &&
          (wanted === undefined || wanted.has(item.sourceFilePath)),
      )
      .sort((left, right) => left.equipmentId.localeCompare(right.equipmentId))
      .map((item) => ({ path: item.sourceFilePath ?? '' }));
  }

  /** 認証情報を読む。保管先の障害は、理由だけを伝える（内部の情報を、利用者に見せない）。 */
  async function readSecret(sourceId: string, refresh: boolean): Promise<string | undefined> {
    try {
      return await secrets.get(
        fileServerSecretReference(sourceId),
        refresh ? { refresh } : undefined,
      );
    } catch (cause) {
      throw new FileSourceFailure('CREDENTIALS_UNAVAILABLE', { cause });
    }
  }

  /**
   * 認証のヘッダーを付けて、操作を実行する。認証に失敗したときは、キャッシュを使わずに秘密情報を取り直し、値が変わっていれば、
   * 1 度だけ再試行する（認証情報の更新が、キャッシュの期間（5 分）の間に、反映されないのを避ける）。
   */
  async function withAuth<T>(
    sourceId: string,
    connection: HttpFileServerConnection,
    operation: (headers: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    if (connection.authMethod === 'NONE') {
      return operation({});
    }
    const value = await readSecret(sourceId, false);
    try {
      return await operation(buildAuthHeaders(connection, value));
    } catch (error) {
      if (!(error instanceof FileSourceFailure) || error.reason !== 'AUTH_FAILED') {
        throw error;
      }
      const fresh = await readSecret(sourceId, true);
      if (fresh === value) {
        throw error;
      }
      return operation(buildAuthHeaders(connection, fresh));
    }
  }

  async function testHttp(sourceId: string, source: HttpSource): Promise<void> {
    const [first] = await targetsOf(source.kind);
    if (first === undefined) {
      throw new FileSourceFailure('NO_FILE_PATH');
    }
    await withAuth(sourceId, source.connection, (headers) =>
      http.probe({ connection: source.connection, path: first.path, headers }),
    );
  }

  async function listHttp(
    sourceId: string,
    source: HttpSource,
    paths: readonly string[] | undefined,
  ): Promise<FileMeta[]> {
    const files: FileMeta[] = [];
    for (const target of await targetsOf(source.kind, paths)) {
      try {
        const stat = await withAuth(sourceId, source.connection, (headers) =>
          http.stat({ connection: source.connection, path: target.path, headers }),
        );
        files.push({
          fileId: target.path,
          name: target.path.slice(target.path.lastIndexOf('/') + 1),
          modifiedAt: stat.modifiedAt ?? UNKNOWN_MODIFIED_AT,
          sizeBytes: stat.sizeBytes ?? 0,
        });
      } catch (error) {
        // まだ置かれていない（見つからない）ファイルは、一覧に含めない。ほかの失敗（認証・接続など）は、取り込み元の失敗として伝える
        if (!(error instanceof FileSourceFailure) || error.reason !== 'NOT_FOUND') {
          throw error;
        }
      }
    }
    return files.sort(
      (left, right) =>
        left.modifiedAt.getTime() - right.modifiedAt.getTime() ||
        left.fileId.localeCompare(right.fileId),
    );
  }

  async function readHttp(sourceId: string, source: HttpSource, fileId: string): Promise<string> {
    // 設備に設定されたファイルパスだけを取得する（任意のパスを、取得させない）
    if (!(await targetsOf(source.kind)).some((target) => target.path === fileId)) {
      throw new FileSourceFailure('NOT_FOUND');
    }
    return withAuth(sourceId, source.connection, (headers) =>
      http.read({
        connection: source.connection,
        path: fileId,
        headers,
        maxBytes: maxFileBytes,
      }),
    );
  }

  return {
    async testConnection(sourceId) {
      const source = await httpSourceOf(sourceId);
      if (source === undefined) {
        return base.testConnection(sourceId);
      }
      return testHttp(sourceId, source);
    },

    async listFiles(sourceId, options) {
      const source = await httpSourceOf(sourceId);
      if (source === undefined) {
        // モック・S3 は、1 つのファイルに複数の設備が入るため、ファイルパスの指定を使わない
        return base.listFiles(sourceId);
      }
      return listHttp(sourceId, source, options?.paths);
    },

    async readFile(sourceId, fileId) {
      const source = await httpSourceOf(sourceId);
      if (source === undefined) {
        return base.readFile(sourceId, fileId);
      }
      return readHttp(sourceId, source, fileId);
    },
  };
}
