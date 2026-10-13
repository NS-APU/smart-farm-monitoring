/**
 * 取り込み設定・状況のユースケース（UC-15、UC-16。FR-1.4〜1.8、FR-8.3）。
 * 取り込み元ごとの接続先（参照名）・取得間隔・有効／無効の設定、設定と状況（解釈に使う仕様の版・状態、最終の取得）、
 * 取り込みのログと連携の結果の参照。認証情報の値は、扱わない・返さない（NFR-5.4）。
 */

import { validationError } from '@smart-farm/shared/errors';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { toIsoOrNull } from '@smart-farm/shared/time';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  FederationLogListResponse,
  IngestionLogListResponse,
  IngestionSettingsResponse,
  IngestionSettingsUpdateRequest,
  IngestionSource,
} from '@smart-farm/shared/schemas/ingestion';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import type { FormatProfileRegistry } from '../ports/format-profile.ts';
import type { FederationRepository, IngestionRepository } from '../ports/repositories.ts';
import type { IngestionService } from './ingestion-service.ts';
import { INGESTION_SETTINGS_KEY, type IngestionSettings } from './ingestion-settings.ts';

const INGESTION_SETTINGS_TARGET_TYPE = 'ingestion-settings' satisfies AuditTargetType;

export interface IngestionAdminService {
  describe(): Promise<IngestionSettingsResponse>;
  update(input: IngestionSettingsUpdateRequest, actor: UserId): Promise<IngestionSettingsResponse>;
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
}

export function createIngestionAdminService(
  deps: IngestionAdminServiceDeps,
): IngestionAdminService {
  const { ingestionSettings, ingestion, federation, ingestionService, profiles, audit } = deps;

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
        updated.push({
          ...source,
          connectionRef: change.connectionRef,
          intervalMinutes: change.intervalMinutes,
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
