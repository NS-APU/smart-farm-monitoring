/**
 * 取り込み設定・状況のユースケース（UC-15、UC-16。FR-1.4〜1.8、FR-8.3）。
 * 取り込み元ごとの有効／無効の設定、設備ごとの接続・認証情報（Issue #367。ADR-0026。取得間隔は、設備ごと）、設定と状況（解釈に使う仕様の版・状態、最終の取得）、
 * 取り込みのログと連携の結果の参照。認証情報の値は、扱わない・返さない（NFR-5.4）。
 */

import { AppError, validationError } from '@smart-farm/shared/errors';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { toIsoOrNull } from '@smart-farm/shared/time';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import { staleThresholdMinutesOf, type Equipment } from '@smart-farm/shared/schemas/equipment';
import { SOURCE_FILE_MAX_BYTES } from '@smart-farm/shared/schemas/ingestion';
import type {
  ConnectionTestResponse,
  EquipmentConnectionResponse,
  FederationLogListResponse,
  IngestionLogListResponse,
  IngestionSettingsResponse,
  IngestionSettingsUpdateRequest,
  FileServerConnection,
  IngestionCredentialStatus,
  IngestionCredentialsInput,
  IngestionSource,
  SourceFileInspection,
  SourceFilePlaced,
} from '@smart-farm/shared/schemas/ingestion';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import { requireActiveEquipment } from '../equipment/require-active-equipment.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { FormatProfileRegistry } from '../ports/format-profile.ts';
import type { HostedFileStorePort } from '../ports/hosted-file-store-port.ts';
import type {
  EquipmentRepository,
  FederationRepository,
  IngestionRepository,
} from '../ports/repositories.ts';
import type { SecretPort } from '../ports/secret-port.ts';
import type { EquipmentConnections } from './equipment-connections.ts';
import {
  credentialsSecretValue,
  fileServerEquipmentSecretReference,
} from './file-server-credentials.ts';
import type { IngestionService } from './ingestion-service.ts';
import { INGESTION_SETTINGS_KEY, type IngestionSettings } from './ingestion-settings.ts';

const INGESTION_SETTINGS_TARGET_TYPE = 'ingestion-settings' satisfies AuditTargetType;

const INTERNAL_ADDRESS_MESSAGE =
  '内部のアドレス（ループバック・プライベート・リンクローカルなど）は、接続先に指定できません';

export interface IngestionAdminService {
  describe(): Promise<IngestionSettingsResponse>;
  update(input: IngestionSettingsUpdateRequest, actor: UserId): Promise<IngestionSettingsResponse>;
  /**
   * 設備ごとの接続を保存する（Issue #367。ADR-0026）。ロボット・センサーだけ。内部のアドレスは拒否する。
   * 認証情報の値は、含めない（`setEquipmentCredentials` で、別に登録する）。
   */
  setEquipmentConnection(
    equipmentId: EquipmentId,
    connection: FileServerConnection,
    actor: UserId,
  ): Promise<EquipmentConnectionResponse>;
  /** 設備ごとの接続を削除する（未設定に戻る）。応答は、削除後の状態。 */
  clearEquipmentConnection(
    equipmentId: EquipmentId,
    actor: UserId,
  ): Promise<EquipmentConnectionResponse>;
  /** 設備ごとの認証情報を登録・上書きする（書き込み専用。値は、返さない・記録しない）。設備ごとの接続の保存が先に必要。 */
  setEquipmentCredentials(
    equipmentId: EquipmentId,
    input: IngestionCredentialsInput,
    actor: UserId,
  ): Promise<IngestionCredentialStatus>;
  /** 設備 1 つの接続テスト（設備がなければ NOT_FOUND）。 */
  testEquipmentConnection(equipmentId: EquipmentId): Promise<ConnectionTestResponse>;
  /**
   * 設備のファイルを、置く前に検査する（取り込みと同じ解釈。何も保存しない。Issue #565）。設備がなければ NOT_FOUND。
   * ハウス・ファイルのパスがない設備は、検証エラー。内容が置けないときは、ok: false と理由を返す（エラーにしない）。
   */
  checkSourceFile(equipmentId: EquipmentId, content: string): Promise<SourceFileInspection>;
  /**
   * 設備のファイルを置く（検査して、設備の `sourceFilePath` の場所へ。ロボットの `PUT` と同じ場所。置き換える）。
   * 置けない内容は、検証エラー（置かない）。保管先がない・障害のときは SERVICE_UNAVAILABLE。内容は、変更履歴・ログに残さない（大きさと計測日時だけ）。
   */
  placeSourceFile(
    equipmentId: EquipmentId,
    content: string,
    actor: UserId,
  ): Promise<SourceFilePlaced>;
  /** 取り込みログ（新しい順）。絞り込み: 取り込み元・設備・結果（成功／失敗）・期間（開始日時。両端を含む）。 */
  listLogs(query: {
    sourceId?: string | undefined;
    equipmentId?: string | undefined;
    result?: 'SUCCESS' | 'FAILURE' | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<IngestionLogListResponse>;
  listFederationLogs(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<FederationLogListResponse>;
}

export interface IngestionAdminServiceDeps {
  readonly ingestionSettings: IngestionSettings;
  /** 設備ごとの接続（Issue #367。ADR-0026）。 */
  readonly equipmentConnections: EquipmentConnections;
  readonly ingestion: IngestionRepository;
  /** 設備（取り込み元の最終の実行を、その種別の設備の最終の実行から求める。Issue #201）。 */
  readonly equipment: Pick<EquipmentRepository, 'list' | 'get'>;
  readonly federation: FederationRepository;
  readonly ingestionService: Pick<
    IngestionService,
    'isRunning' | 'testEquipmentConnection' | 'inspectFile'
  >;
  readonly profiles: FormatProfileRegistry;
  readonly audit: AuditService;
  /** 秘密情報の保管先（認証情報の値の保存と、状態の確認）。 */
  readonly secrets: SecretPort;
  /** 画面から置くファイルの保管先（Issue #565）。未設定は、置く機能が使えない（SERVICE_UNAVAILABLE）。 */
  readonly hostedFileStore?: HostedFileStorePort | undefined;
  readonly clock: ClockPort;
  /** 接続設定の接続先が、許可されるか（内部のアドレスを拒否する。Issue #172）。省略は、すべて許可。 */
  readonly isConnectionAllowed?: (connection: FileServerConnection) => boolean;
  /** 「データが古い」の基準の倍数（STALE_AFTER_INTERVALS。ダッシュボードと同じ）。設備ごとの基準（分）を返すのに使う。 */
  readonly staleAfterIntervals: number;
}

/** 日時のうち、最も新しいもの。なければ null。 */
function latestDate(dates: readonly Date[]): Date | null {
  return dates.reduce<Date | null>(
    (latest, date) => (latest === null || date.getTime() > latest.getTime() ? date : latest),
    null,
  );
}

export function createIngestionAdminService(
  deps: IngestionAdminServiceDeps,
): IngestionAdminService {
  const { ingestionSettings, ingestion, federation, ingestionService, profiles, audit } = deps;
  const equipmentRepository = deps.equipment;
  const { secrets, equipmentConnections } = deps;
  const isConnectionAllowed = deps.isConnectionAllowed ?? (() => true);
  const { staleAfterIntervals } = deps;

  /** 認証情報の状態（値は、読まない・返さない）。保管先の障害は、UNAVAILABLE にして、設定の取得を止めない。 */
  async function credentialStatusOfConnection(
    connection: FileServerConnection | undefined,
    reference: string,
  ): Promise<IngestionCredentialStatus> {
    if (connection === undefined || connection.authMethod === 'NONE') {
      return { state: 'NOT_REQUIRED' };
    }
    try {
      const status = await secrets.status(reference);
      return status.configured
        ? { state: 'CONFIGURED', ...omitUndefined({ updatedAt: status.updatedAt }) }
        : { state: 'NOT_CONFIGURED' };
    } catch {
      return { state: 'UNAVAILABLE' };
    }
  }

  /** 設備ごとの認証情報の状態。 */
  const equipmentCredentialStatusOf = (
    equipmentId: EquipmentId,
    connection: FileServerConnection | undefined,
  ): Promise<IngestionCredentialStatus> =>
    credentialStatusOfConnection(connection, fileServerEquipmentSecretReference(equipmentId));

  /** 設備の取り込み元（設備の種別と同じ種別の取り込み元）。登録のない設備は undefined。 */
  async function sourceIdOfEquipment(equipmentId: string): Promise<string | undefined> {
    const found = (await equipmentRepository.list()).find(
      (item) => item.equipmentId === equipmentId,
    );
    if (found === undefined) {
      return undefined;
    }
    return (await ingestionSettings.listSources()).find(
      (source) => source.kind === found.equipmentType,
    )?.sourceId;
  }

  /** ファイルを置ける設備（ロボット・センサーで、ファイルのパスがある）と、その取り込み元・パス。 */
  async function requireFileTarget(
    equipmentId: EquipmentId,
  ): Promise<{ sourceId: string; path: string }> {
    const equipment = await requireConnectableEquipment(equipmentId);
    const sourceId = await sourceIdOfEquipment(equipmentId);
    if (equipment.sourceFilePath === undefined || sourceId === undefined) {
      throw validationError([
        {
          name: 'sourceFilePath',
          message:
            'ファイルのパスが設定されていません（設備のダイアログで設定してから、置いてください）',
        },
      ]);
    }
    return { sourceId, path: equipment.sourceFilePath };
  }

  /** 大きさの上限（API の本文の上限と同じ）の内側で、取り込みと同じ解釈の検査をする。 */
  async function inspectSourceFile(
    sourceId: string,
    equipmentId: EquipmentId,
    content: string,
  ): Promise<SourceFileInspection> {
    if (Buffer.byteLength(content, 'utf8') > SOURCE_FILE_MAX_BYTES) {
      throw validationError([{ name: 'content', message: 'ファイルは 1 MiB 以内にしてください' }]);
    }
    return ingestionService.inspectFile(sourceId, equipmentId, content);
  }

  /** 接続を設定できる設備（ロボット・センサー）。なければ NOT_FOUND（削除済みを含む）。ハウスは、検証エラー。 */
  async function requireConnectableEquipment(equipmentId: EquipmentId): Promise<Equipment> {
    const found = await requireActiveEquipment(equipmentRepository, equipmentId);
    if (found.equipmentType === 'FACILITY') {
      throw validationError([
        { name: 'equipmentId', message: '接続は、ロボット・センサーだけに設定できます' },
      ]);
    }
    return found;
  }

  /** 設備の保存・削除のあとの、設備の接続の状態（接続・認証情報の状態）。接続がなければ、接続は省略。 */
  async function connectionStateOf(equipment: Equipment): Promise<EquipmentConnectionResponse> {
    const own = (await equipmentConnections.list()).get(equipment.equipmentId);
    return {
      equipmentId: equipment.equipmentId,
      ...omitUndefined({ connection: own }),
      credentials: await equipmentCredentialStatusOf(equipment.equipmentId, own),
    };
  }

  async function describe(): Promise<IngestionSettingsResponse> {
    const sources = await ingestionSettings.listSources();
    // 取り込み元の最終の実行・最終の成功は、その種別の設備の、最終の実行から求める（設備ごとに持つ。Issue #201）
    const [equipment, runs, ownConnections] = await Promise.all([
      equipmentRepository.list(),
      ingestion.listEquipmentRuns(),
      equipmentConnections.list(),
    ]);
    return {
      sources: await Promise.all(
        sources.map(async (source) => {
          const profile = profiles.get(source.profileId);
          const members = equipment.filter((item) => item.equipmentType === source.kind);
          const memberRuns = members.flatMap((item) => runs.get(item.equipmentId) ?? []);
          const lastStartedAt =
            latestDate(memberRuns.map((run) => run.startedAt)) ??
            (await ingestion.lastStartedAt(source.sourceId));
          const lastSucceededAt = latestDate(
            memberRuns.flatMap((run) => run.lastSucceededAt ?? []),
          );
          return {
            ...source,
            formatProfile: {
              versionLabel: profile?.versionLabel ?? source.profileId,
              status: profile?.status ?? 'PROVISIONAL',
            },
            lastStartedAt: toIsoOrNull(lastStartedAt),
            lastSuccessAt: toIsoOrNull(lastSucceededAt),
            equipment: await Promise.all(
              members.map(async (item) => {
                const run = runs.get(item.equipmentId);
                const own = ownConnections.get(item.equipmentId);
                return {
                  equipmentId: item.equipmentId,
                  name: item.name,
                  ...omitUndefined({
                    sourceFilePath: item.sourceFilePath,
                    connection: own,
                    staleThresholdMinutes: staleThresholdMinutesOf(item, staleAfterIntervals),
                  }),
                  credentials: await equipmentCredentialStatusOf(item.equipmentId, own),
                  lastStartedAt: toIsoOrNull(run?.startedAt ?? null),
                  lastResult: run?.result ?? null,
                  lastSuccessAt: toIsoOrNull(run?.lastSucceededAt ?? null),
                  lastDataAt: toIsoOrNull(run?.lastDataAt ?? null),
                };
              }),
            ),
            isRunning: ingestionService.isRunning(source.sourceId),
          };
        }),
      ),
    };
  }

  return {
    describe,

    async update(input, actor) {
      const current = await ingestionSettings.listSources();
      const seen = new Set<string>();
      const updated: IngestionSource[] = [];
      for (const [index, change] of input.sources.entries()) {
        const source = current.find((candidate) => candidate.sourceId === change.sourceId);
        if (source === undefined || seen.has(change.sourceId)) {
          throw validationError([
            {
              name: `sources.${String(index)}.sourceId`,
              message: '取り込み元が見つからない、または重複しています',
            },
          ]);
        }
        seen.add(change.sourceId);
        updated.push({ ...source, isEnabled: change.isEnabled });
      }
      // 指定がなかった取り込み元は、そのまま残す
      const next = current.map(
        (source) => updated.find((candidate) => candidate.sourceId === source.sourceId) ?? source,
      );
      await ingestionSettings.saveSources(next);
      await audit.record({
        operation: 'UPDATE',
        targetType: INGESTION_SETTINGS_TARGET_TYPE,
        targetId: INGESTION_SETTINGS_KEY,
        actor,
        before: current,
        after: next,
      });
      return describe();
    },

    async setEquipmentConnection(equipmentId, connection, actor) {
      const target = await requireConnectableEquipment(equipmentId);
      if (!isConnectionAllowed(connection)) {
        throw validationError([{ name: 'connection.host', message: INTERNAL_ADDRESS_MESSAGE }]);
      }
      const before = (await equipmentConnections.list()).get(equipmentId);
      await equipmentConnections.save(equipmentId, connection);
      // 接続先（認証情報の値は、持たない）を記録する
      await audit.record({
        operation: before === undefined ? 'CREATE' : 'UPDATE',
        targetType: INGESTION_SETTINGS_TARGET_TYPE,
        targetId: `equipment-connections/${equipmentId}`,
        actor,
        ...(before === undefined ? {} : { before }),
        after: connection,
      });
      return connectionStateOf(target);
    },

    async clearEquipmentConnection(equipmentId, actor) {
      const target = await requireConnectableEquipment(equipmentId);
      const before = (await equipmentConnections.list()).get(equipmentId);
      if (before !== undefined) {
        await equipmentConnections.remove(equipmentId);
        await audit.record({
          operation: 'DELETE',
          targetType: INGESTION_SETTINGS_TARGET_TYPE,
          targetId: `equipment-connections/${equipmentId}`,
          actor,
          before,
        });
      }
      return connectionStateOf(target);
    },

    async setEquipmentCredentials(equipmentId, input, actor) {
      await requireConnectableEquipment(equipmentId);
      const connection = (await equipmentConnections.list()).get(equipmentId);
      if (connection === undefined) {
        throw validationError([
          {
            name: 'authMethod',
            message: '接続先が設定されていません（先に接続設定を保存してから、登録してください）',
          },
        ]);
      }
      if (connection.authMethod === 'NONE') {
        throw validationError([
          {
            name: 'authMethod',
            message: 'この設備は、認証情報が不要です（認証方式を設定してから、登録してください）',
          },
        ]);
      }
      if (connection.authMethod !== input.authMethod) {
        throw validationError([
          {
            name: 'authMethod',
            message:
              '認証方式が、保存済みの設定と違います。先に設定を保存してから、登録してください',
          },
        ]);
      }
      // 値は、保管先へ渡すだけ。例外にも、変更履歴にも、含めない
      try {
        await secrets.set(
          fileServerEquipmentSecretReference(equipmentId),
          credentialsSecretValue(input),
        );
      } catch {
        // 保管先のエラーの内容・原因は、値を含みうるため、引き継がない（ログ・応答に出さない）
        throw new AppError('SERVICE_UNAVAILABLE', '認証情報を保存できませんでした');
      }
      await audit.record({
        operation: 'UPDATE',
        targetType: INGESTION_SETTINGS_TARGET_TYPE,
        targetId: `credentials/equipment/${equipmentId}`,
        actor,
        after: { credentialsUpdated: true, authMethod: input.authMethod },
      });
      return equipmentCredentialStatusOf(equipmentId, connection);
    },

    async testEquipmentConnection(equipmentId) {
      await requireActiveEquipment(equipmentRepository, equipmentId);
      return ingestionService.testEquipmentConnection(equipmentId);
    },

    async checkSourceFile(equipmentId, content) {
      const target = await requireFileTarget(equipmentId);
      return inspectSourceFile(target.sourceId, equipmentId, content);
    },

    async placeSourceFile(equipmentId, content, actor) {
      const target = await requireFileTarget(equipmentId);
      const inspection = await inspectSourceFile(target.sourceId, equipmentId, content);
      if (!inspection.ok) {
        throw validationError(inspection.problems.map((message) => ({ name: 'content', message })));
      }
      if (deps.hostedFileStore === undefined) {
        throw new AppError('SERVICE_UNAVAILABLE', 'ファイルを置く機能は、設定されていません');
      }
      try {
        await deps.hostedFileStore.put(target.path, content);
      } catch {
        // 保管先のエラーの内容・パスは、応答に出さない
        throw new AppError('SERVICE_UNAVAILABLE', 'ファイルを置けませんでした');
      }
      await audit.record({
        operation: 'UPDATE',
        targetType: INGESTION_SETTINGS_TARGET_TYPE,
        targetId: `source-file/equipment/${equipmentId}`,
        actor,
        after: omitUndefined({ size: inspection.size, observedAt: inspection.observedAt }),
      });
      return { ...inspection, placedAt: deps.clock.now().toISOString() };
    },

    async listLogs(query) {
      // 設備を指定すると、その設備のログと、その設備の取り込み元（種別が同じ）の、設備に結びつかないログ。
      // 登録のない設備（削除済みを含む）は、その設備のログだけ
      const equipment =
        query.equipmentId === undefined
          ? undefined
          : {
              equipmentId: query.equipmentId,
              sourceId: await sourceIdOfEquipment(query.equipmentId),
            };
      const page = await ingestion.listLogs(
        omitUndefined({
          sourceId: query.sourceId,
          equipment,
          result: query.result,
          from: query.from,
          to: query.to,
        }),
        { limit: query.limit, cursor: query.cursor },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    },

    async listFederationLogs(query) {
      const page = await federation.listLogs({ limit: query.limit, cursor: query.cursor });
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        queue: await federation.countByStatus(),
      };
    },
  };
}
