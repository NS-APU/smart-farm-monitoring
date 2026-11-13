/**
 * 連携先の設定のユースケース（SC-11。ADR-0024。Issue #177 の PR 3）の単体テスト。
 * 設定の取得・更新（変更履歴。接続先の値は、残さない）、連携を有効にしたとき既存の設備を積む、接続の確認。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createFederationAdminService,
  type FederationAdminDeps,
} from '../../../../src/backend/application/federation/federation-admin-service.ts';
import { createFederationConnectionStore } from '../../../../src/backend/application/federation/federation-connection-store.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import { toUserId } from '../../../../src/shared/schemas/common.ts';
import type { FederationMode } from '../../../../src/shared/schemas/federation-connection.ts';

const ACTOR = toUserId('admin-1');
const ENDPOINT = 'https://platform.example.test/api/orion/ngsi-ld/v1';
const SETTINGS = {
  tenant: 'smart_farm_monitoring',
  contextUrl: 'https://example.test/context.jsonld',
  enabled: true,
};

function build(options: { mode?: FederationMode; probeOk?: boolean } = {}) {
  const { repositories } = createLocalRepositories();
  const store = createFederationConnectionStore({
    settings: repositories.settings,
    secrets: createMemorySecretPort(),
  });
  const audit = { record: vi.fn().mockResolvedValue(undefined), list: vi.fn() };
  const enqueueAllEquipment = vi.fn().mockResolvedValue(3);
  const probe = vi.fn().mockResolvedValue({
    ok: options.probeOk ?? true,
    message: '確認の結果',
  });
  const deps: FederationAdminDeps = {
    store,
    federation: { enqueueAllEquipment },
    audit,
    mode: options.mode ?? 'ngsi-ld',
    probe,
  };
  return { service: createFederationAdminService(deps), store, audit, enqueueAllEquipment, probe };
}

describe('連携先の設定の取得', () => {
  it('方式・既定の設定（無効）・接続先の状態（未設定）を返す', async () => {
    const { service } = build();

    expect(await service.describe()).toEqual({
      mode: 'ngsi-ld',
      settings: {
        tenant: 'smart_farm_monitoring',
        contextUrl: expect.stringContaining('ngsi-ld-context.jsonld') as unknown,
        enabled: false,
      },
      endpoint: { configured: false },
    });
  });

  it('接続先を保存したあとは、設定済みと更新日時だけを返す（値は、返さない）', async () => {
    const { service } = build();
    await service.update({ settings: SETTINGS, endpoint: ENDPOINT }, ACTOR);

    const described = await service.describe();

    expect(described.endpoint.configured).toBe(true);
    expect(JSON.stringify(described)).not.toContain('platform.example.test');
  });
});

describe('連携先の設定の更新', () => {
  it('設定と接続先を保存し、更新後の内容を返す。接続先を省略すると、保存済みの接続先を保つ', async () => {
    const { service, store } = build();
    await service.update({ settings: SETTINGS, endpoint: ENDPOINT }, ACTOR);

    const updated = await service.update(
      { settings: { ...SETTINGS, tenant: 'other_tenant' } },
      ACTOR,
    );

    expect(updated.settings.tenant).toBe('other_tenant');
    expect(updated.endpoint.configured).toBe(true);
    expect((await store.get())?.endpoint.host).toBe('platform.example.test');
  });

  it('変更履歴に、設定の変更前後と、接続先を更新したこと（値は、含めない）を残す', async () => {
    const { service, audit } = build();

    await service.update({ settings: SETTINGS, endpoint: ENDPOINT }, ACTOR);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'UPDATE',
        targetType: 'ingestion-settings',
        targetId: 'federation/settings',
        actor: ACTOR,
        before: expect.objectContaining({ enabled: false }) as unknown,
        after: expect.objectContaining({
          enabled: true,
          tenant: 'smart_farm_monitoring',
        }) as unknown,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'federation/endpoint',
        after: { endpointUpdated: true },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('platform.example.test');
  });

  it('接続先を省略したときは、接続先の変更履歴を残さない', async () => {
    const { service, audit } = build();
    await service.update({ settings: { ...SETTINGS, enabled: false }, endpoint: ENDPOINT }, ACTOR);
    audit.record.mockClear();

    await service.update({ settings: { ...SETTINGS, enabled: false, tenant: 'other' } }, ACTOR);

    expect(
      audit.record.mock.calls.map(([entry]) => (entry as { targetId: string }).targetId),
    ).toEqual(['federation/settings']);
  });

  it('接続先が未設定のままでは、有効にできない（検証エラー）', async () => {
    const { service } = build();

    await expect(service.update({ settings: SETTINGS }, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: [expect.objectContaining({ name: 'settings.enabled' }) as unknown],
    });
  });

  it('無効のままなら、接続先がなくても、保存できる', async () => {
    const { service } = build();

    const updated = await service.update({ settings: { ...SETTINGS, enabled: false } }, ACTOR);

    expect(updated.settings.enabled).toBe(false);
  });

  it('連携を無効 → 有効にしたとき、既存の設備を連携キューに積む。すでに有効・無効にするときは、積まない', async () => {
    const { service, enqueueAllEquipment, audit } = build();

    await service.update({ settings: SETTINGS, endpoint: ENDPOINT }, ACTOR);
    expect(enqueueAllEquipment).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'federation/settings',
        after: expect.objectContaining({ equipmentEnqueued: 3 }) as unknown,
      }),
    );

    await service.update({ settings: { ...SETTINGS, tenant: 'other' } }, ACTOR);
    await service.update({ settings: { ...SETTINGS, enabled: false } }, ACTOR);
    expect(enqueueAllEquipment).toHaveBeenCalledTimes(1);

    await service.update({ settings: SETTINGS }, ACTOR);
    expect(enqueueAllEquipment).toHaveBeenCalledTimes(2);
  });

  it('不正な接続先は、検証エラー（保存しない。値は、メッセージに含めない）', async () => {
    const { service, store } = build();

    await expect(
      service.update(
        { settings: { ...SETTINGS, enabled: false }, endpoint: 'secret-not-a-url' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await store.describe()).endpoint.configured).toBe(false);
  });
});

describe('接続の確認', () => {
  it('保存済みの接続先・テナント・context で、確認する（無効のときも、確認できる）', async () => {
    const { service, probe } = build();
    await service.update({ settings: { ...SETTINGS, enabled: false }, endpoint: ENDPOINT }, ACTOR);

    const result = await service.test();

    expect(result).toEqual({ ok: true, message: '確認の結果' });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: 'smart_farm_monitoring',
        endpoint: expect.objectContaining({ host: 'platform.example.test' }) as unknown,
      }),
    );
  });

  it('確認の失敗は、そのまま（失敗の理由）返す', async () => {
    const { service } = build({ probeOk: false });
    await service.update({ settings: { ...SETTINGS, enabled: false }, endpoint: ENDPOINT }, ACTOR);

    expect((await service.test()).ok).toBe(false);
  });

  it('接続先が未設定なら、確認せずに、その旨を返す', async () => {
    const { service, probe } = build();

    const result = await service.test();

    expect(result).toEqual({ ok: false, message: '接続先が設定されていません' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('モックの環境では、確認せずに、その旨を返す', async () => {
    const { service, probe } = build({ mode: 'mock' });
    await service.update({ settings: { ...SETTINGS, enabled: false }, endpoint: ENDPOINT }, ACTOR);

    const result = await service.test();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('モック');
    expect(probe).not.toHaveBeenCalled();
  });
});
