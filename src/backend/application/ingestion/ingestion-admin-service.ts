/**
 * 取り込み設定・状況のユースケース（UC-15、UC-16。FR-1.4〜1.8、FR-8.3）。
 * 取り込み元ごとの接続先（参照名）・取得間隔・有効／無効の設定、設定と状況（解釈に使う仕様の版・状態、最終の取得）、
 * 取り込みのログと連携の結果の参照。認証情報の値は、扱わない・返さない（NFR-5.4）。
 */

import { AppError, validationError } from '@smart-farm/shared/errors';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { toIsoOrNull } from '@smart-farm/shared/time';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  FederationLogListResponse,
  IngestionLogListResponse,
  IngestionSettingsResponse,
  IngestionSettingsUpdateRequest,
  FileServerConnection,
  IngestionCredentialStatus,
  IngestionCredentialsInput,
  IngestionSource,
} from '@smart-farm/shared/schemas/ingestion';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import type { FormatProfileRegistry } from '../ports/format-profile.ts';
import type { FederationRepository, IngestionRepository } from '../ports/repositories.ts';
import type { SecretPort } from '../ports/secret-port.ts';
import { credentialsSecretValue, fileServerSecretReference } from './file-server-credentials.ts';
import type { IngestionService } from './ingestion-service.ts';
import { INGESTION_SETTINGS_KEY, type IngestionSettings } from './ingestion-settings.ts';

const INGESTION_SETTINGS_TARGET_TYPE = 'ingestion-settings' satisfies AuditTargetType;

export interface IngestionAdminService {
  describe(): Promise<IngestionSettingsResponse>;
  update(input: IngestionSettingsUpdateRequest, actor: UserId): Promise<IngestionSettingsResponse>;
  /** 認証情報を登録・上書きする（書き込み専用。値は、返さない・記録しない。Issue #207）。 */
  setCredentials(
    sourceId: string,
    input: IngestionCredentialsInput,
    actor: UserId,
  ): Promise<IngestionCredentialStatus>;
  listLogs(query: {
    sourceId?: string | undefined;
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
  readonly ingestion: IngestionRepository;
  readonly federation: FederationRepository;
  readonly ingestionService: Pick<IngestionService, 'isRunning'>;
  readonly profiles: FormatProfileRegistry;
  readonly audit: AuditService;
  /** 秘密情報の保管先（認証情報の値の保存と、状態の確認）。 */
  readonly secrets: SecretPort;
  /** 接続設定の接続先が、許可されるか（内部のアドレスを拒否する。Issue #172）。省略は、すべて許可。 */
  readonly isConnectionAllowed?: (connection: FileServerConnection) => boolean;
}

export function createIngestionAdminService(
  deps: IngestionAdminServiceDeps,
): IngestionAdminService {
  const { ingestionSettings, ingestion, federation, ingestionService, profiles, audit } = deps;
  const { secrets } = deps;
  const isConnectionAllowed = deps.isConnectionAllowed ?? (() => true);

  /** 認証情報の状態（値は、読まない・返さない）。保管先の障害は、UNAVAILABLE にして、設定の取得を止めない。 */
  async function credentialStatusOf(source: IngestionSource): Promise<IngestionCredentialStatus> {
    if (source.connection.type !== 'HTTP' || source.connection.authMethod === 'NONE') {
      return { state: 'NOT_REQUIRED' };
    }
    try {
      const status = await secrets.status(fileServerSecretReference(source.sourceId));
      return status.configured
        ? { state: 'CONFIGURED', ...omitUndefined({ updatedAt: status.updatedAt }) }
        : { state: 'NOT_CONFIGURED' };
    } catch {
      return { state: 'UNAVAILABLE' };
    }
  }

  async function describe(): Promise<IngestionSettingsResponse> {
    const sources = await ingestionSettings.listSources();
    return {
      sources: await Promise.all(
        sources.map(async (source) => {
          const profile = profiles.get(source.profileId);
          const lastStartedAt = await ingestion.lastStartedAt(source.sourceId);
          const lastSucceededAt = await ingestion.lastSucceededAt(source.sourceId);
          return {
            ...source,
            formatProfile: {
              versionLabel: profile?.versionLabel ?? source.profileId,
              status: profile?.status ?? 'PROVISIONAL',
            },
            lastStartedAt: toIsoOrNull(lastStartedAt),
            lastSuccessAt: toIsoOrNull(lastSucceededAt),
            isRunning: ingestionService.isRunning(source.sourceId),
            credentials: await credentialStatusOf(source),
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
        if (change.connection !== undefined && !isConnectionAllowed(change.connection)) {
          throw validationError([
            {
              name: `sources.${String(index)}.connection.host`,
              message:
                '内部のアドレス（ループバック・プライベート・リンクローカルなど）は、接続先に指定できません',
            },
          ]);
        }
        updated.push({
          ...source,
          connectionRef: change.connectionRef,
          connection: change.connection ?? source.connection,
          isEnabled: change.isEnabled,
        });
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

    async setCredentials(sourceId, input, actor) {
      const source = (await ingestionSettings.listSources()).find(
        (candidate) => candidate.sourceId === sourceId,
      );
      if (source === undefined) {
        throw new AppError('NOT_FOUND', '取り込み元が見つかりません');
      }
      const { connection } = source;
      if (connection.type !== 'HTTP' || connection.authMethod === 'NONE') {
        throw validationError([
          {
            name: 'authMethod',
            message:
              'この取り込み元は、認証情報が不要です（認証方式を設定してから、登録してください）',
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
        await secrets.set(fileServerSecretReference(sourceId), credentialsSecretValue(input));
      } catch {
        // 保管先のエラーの内容・原因は、値を含みうるため、引き継がない（ログ・応答に出さない）
        throw new AppError('SERVICE_UNAVAILABLE', '認証情報を保存できませんでした');
      }
      await audit.record({
        operation: 'UPDATE',
        targetType: INGESTION_SETTINGS_TARGET_TYPE,
        targetId: `credentials/${sourceId}`,
        actor,
        after: { credentialsUpdated: true, authMethod: input.authMethod },
      });
      return credentialStatusOf(source);
    },

    async listLogs(query) {
      const page = await ingestion.listLogs(omitUndefined({ sourceId: query.sourceId }), {
        limit: query.limit,
        cursor: query.cursor,
      });
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
