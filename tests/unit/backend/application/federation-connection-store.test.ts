/**
 * 農業情報基盤の連携先の設定の保管（ADR-0024。Issue #177 の PR 1）の単体テスト。
 * 接続先は、書き込み専用の秘密情報（SecretPort）。テナント名・context の URL・有効／無効は、通常の設定。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEDERATION_CONTEXT_URL,
  FEDERATION_ENDPOINT_SECRET_REFERENCE,
  createFederationConnectionStore,
} from '../../../../src/backend/application/federation/federation-connection-store.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import { DEFAULT_FEDERATION_TENANT } from '../../../../src/shared/schemas/federation-connection.ts';

function build() {
  const { repositories } = createLocalRepositories();
  const secrets = createMemorySecretPort();
  const store = createFederationConnectionStore({ settings: repositories.settings, secrets });
  return { store, secrets, settings: repositories.settings };
}

describe('連携先の設定の保管', () => {
  it('何も設定していなければ、接続先がなく（undefined）、設定は、既定（テナント smart_farm_monitoring・無効）', async () => {
    const { store } = build();

    expect(await store.get()).toBeUndefined();
    expect(await store.describe()).toEqual({
      settings: {
        tenant: DEFAULT_FEDERATION_TENANT,
        contextUrl: DEFAULT_FEDERATION_CONTEXT_URL,
        enabled: false,
      },
      endpoint: { configured: false },
    });
  });

  it('接続先は、秘密情報として保管し、設定の保管（通常の設定）には、含めない。状態には、設定済みかだけを示す（値は、返さない）', async () => {
    const { store, secrets, settings } = build();

    await store.saveEndpoint('https://platform.example.test/api/orion/ngsi-ld/v1/');

    expect(await secrets.get(FEDERATION_ENDPOINT_SECRET_REFERENCE)).toBe(
      'https://platform.example.test/api/orion/ngsi-ld/v1',
    );
    expect(JSON.stringify((await settings.get('federation.settings')) ?? {})).not.toContain(
      'platform',
    );
    const described = await store.describe();
    expect(described.endpoint.configured).toBe(true);
    expect(JSON.stringify(described)).not.toContain('platform.example.test');
  });

  it('接続先と設定がそろえば、接続を返す（接続先は、プロトコル・ホスト・ポート・基準のパスに分ける）', async () => {
    const { store } = build();
    await store.saveEndpoint('http://platform.example.test:1026/ngsi-ld/v1');
    await store.saveSettings({
      tenant: 'my_tenant',
      contextUrl: 'https://example.test/context.jsonld',
      enabled: true,
    });

    expect(await store.get()).toEqual({
      endpoint: {
        protocol: 'HTTP',
        host: 'platform.example.test',
        port: 1026,
        basePath: '/ngsi-ld/v1',
      },
      tenant: 'my_tenant',
      contextUrl: 'https://example.test/context.jsonld',
      enabled: true,
    });
  });

  it('無効のときも、接続先と設定を返す（enabled: false。送るかは、アダプタが決める）', async () => {
    const { store } = build();
    await store.saveEndpoint('https://platform.example.test/v1');

    expect(await store.get()).toMatchObject({ enabled: false });
  });

  it('不正な接続先・設定は、保存しない（検証エラー）', async () => {
    const { store, secrets } = build();

    await expect(store.saveEndpoint('not-a-url')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      store.saveSettings({
        tenant: 'Bad Tenant',
        contextUrl: 'https://example.test/c',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await secrets.get(FEDERATION_ENDPOINT_SECRET_REFERENCE)).toBeUndefined();
  });

  it('保管した接続先が読めない形（壊れている）なら、接続なし（undefined）として扱う', async () => {
    const { store, secrets } = build();
    await secrets.set(FEDERATION_ENDPOINT_SECRET_REFERENCE, 'broken value');

    expect(await store.get()).toBeUndefined();
  });

  it('保管した設定が読めない形なら、既定に戻して扱う', async () => {
    const { store, settings } = build();
    await settings.set('federation.settings', { tenant: 5 });

    expect((await store.describe()).settings).toEqual({
      tenant: DEFAULT_FEDERATION_TENANT,
      contextUrl: DEFAULT_FEDERATION_CONTEXT_URL,
      enabled: false,
    });
  });
});
