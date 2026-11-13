/**
 * 連携先の設定のユースケース（SC-11。UC-15。ADR-0024。Issue #177）。
 * 設定の取得・更新・接続の確認。接続先は書き込み専用（値は、応答・変更履歴・ログに出さない）。
 * 連携を、無効 → 有効にしたとき、既存の設備の名前・ID を、連携キューに積む（D-35）。
 */

import { validationError } from '@smart-farm/shared/errors';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  FederationMode,
  FederationSettingsResponse,
  FederationSettingsUpdateRequest,
  FederationTestResponse,
} from '@smart-farm/shared/schemas/federation-connection';
import type { AuditService } from '../audit/audit-service.ts';
import type {
  FederationConnection,
  FederationConnectionStore,
} from './federation-connection-store.ts';
import type { FederationService } from './federation-service.ts';

/** 変更履歴の対象の種類（取り込み設定と同じ。対象の識別子で区別する）。 */
const TARGET_TYPE = 'ingestion-settings' satisfies AuditTargetType;

export interface FederationAdminService {
  describe(): Promise<FederationSettingsResponse>;
  update(
    input: FederationSettingsUpdateRequest,
    actor: UserId,
  ): Promise<FederationSettingsResponse>;
  /** 接続の確認（読み取りだけ。書き込みはしない）。 */
  test(): Promise<FederationTestResponse>;
}

export interface FederationAdminDeps {
  readonly store: FederationConnectionStore;
  readonly federation: Pick<FederationService, 'enqueueAllEquipment'>;
  readonly audit: AuditService;
  readonly mode: FederationMode;
  /** 接続の確認の実行（NGSI-LD のアダプタが、読み取りの要求を送る）。 */
  readonly probe: (connection: FederationConnection) => Promise<FederationTestResponse>;
}

export function createFederationAdminService(deps: FederationAdminDeps): FederationAdminService {
  const { store, federation, audit, mode, probe } = deps;

  async function describe(): Promise<FederationSettingsResponse> {
    const { settings, endpoint } = await store.describe();
    return {
      mode,
      settings,
      endpoint: {
        configured: endpoint.configured,
        ...(endpoint.updatedAt === undefined ? {} : { updatedAt: endpoint.updatedAt }),
      },
    };
  }

  return {
    describe,

    async update(input, actor) {
      const before = await store.describe();
      const endpointConfigured = before.endpoint.configured || input.endpoint !== undefined;
      if (input.settings.enabled && !endpointConfigured) {
        throw validationError([
          { name: 'settings.enabled', message: '接続先を設定してから、有効にしてください' },
        ]);
      }
      // 接続先（書き込み専用）を先に保存する（不正なら、設定は、保存しない）
      if (input.endpoint !== undefined) {
        await store.saveEndpoint(input.endpoint);
      }
      await store.saveSettings(input.settings);
      // 連携を、無効 → 有効にしたとき、既存の設備を連携キューに積む（以後の登録・修正は、設備のサービスが積む）
      const enabling = input.settings.enabled && !before.settings.enabled;
      const equipmentEnqueued = enabling ? await federation.enqueueAllEquipment() : undefined;
      await audit.record({
        operation: 'UPDATE',
        targetType: TARGET_TYPE,
        targetId: 'federation/settings',
        actor,
        before: before.settings,
        after: {
          ...input.settings,
          ...(equipmentEnqueued === undefined ? {} : { equipmentEnqueued }),
        },
      });
      if (input.endpoint !== undefined) {
        // 接続先の値は、残さない（更新したことだけ）
        await audit.record({
          operation: 'UPDATE',
          targetType: TARGET_TYPE,
          targetId: 'federation/endpoint',
          actor,
          after: { endpointUpdated: true },
        });
      }
      return describe();
    },

    async test() {
      if (mode === 'mock') {
        return {
          ok: false,
          message: 'この環境は、モックの連携先で動いているため、接続を確認できません',
        };
      }
      const connection = await store.get();
      if (connection === undefined) {
        return { ok: false, message: '接続先が設定されていません' };
      }
      return probe(connection);
    },
  };
}
