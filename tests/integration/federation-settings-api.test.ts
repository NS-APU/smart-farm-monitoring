/**
 * 連携先の設定の API（SC-11。UC-15。ADR-0024。Issue #177 の PR 3）の結合テスト。
 * GET・PUT /federation/settings、POST /federation/test。接続先は書き込み専用（応答・変更履歴に出さない）。
 * 送信・確認は、偽の transport で確かめる（実際の接続先に依存しない）。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import {
  FederationSettingsResponseSchema,
  FederationTestResponseSchema,
} from '@smart-farm/shared/schemas/federation-connection';
import type {
  NgsiLdRequest,
  NgsiLdTransport,
} from '../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import { ROBOT_ID } from '../support/builders.ts';
import { errorOf, withEquipment, type TestContext } from '../support/test-context.ts';

const ENDPOINT = 'https://platform.example.test/api/orion/ngsi-ld/v1';
const SETTINGS = {
  tenant: 'smart_farm_monitoring',
  contextUrl: 'https://example.test/context.jsonld',
  enabled: true,
};
const DAY_MS = 24 * 60 * 60_000;

function send(context: TestContext, method: string, path: string, body?: unknown) {
  return context.request(path, { method, ...(body === undefined ? {} : { body }) });
}

async function ngsiLdContext(status = 200) {
  const requests: NgsiLdRequest[] = [];
  const transport: NgsiLdTransport = (request) => {
    requests.push(request);
    return Promise.resolve({ status, body: '[]' });
  };
  const context = await withEquipment({
    env: { FEDERATION_MODE: 'ngsi-ld' },
    federationTransport: transport,
  });
  return { context, requests };
}

describe('GET /federation/settings', () => {
  it('方式（既定は mock）・既定の設定（テナント smart_farm_monitoring・無効）・接続先の状態（未設定）を返す', async () => {
    const context = await withEquipment();

    const response = await send(context, 'GET', '/federation/settings');

    expect(response.status).toBe(200);
    expect(FederationSettingsResponseSchema.parse(await response.json())).toMatchObject({
      mode: 'mock',
      settings: { tenant: 'smart_farm_monitoring', enabled: false },
      endpoint: { configured: false },
    });
  });
});

describe('PUT /federation/settings', () => {
  it('設定と接続先を保存する。応答・取得に、接続先の値を含めない', async () => {
    const context = await withEquipment();

    const put = await send(context, 'PUT', '/federation/settings', {
      settings: SETTINGS,
      endpoint: ENDPOINT,
    });
    const get = await send(context, 'GET', '/federation/settings');

    expect(put.status).toBe(200);
    const putBody: unknown = await put.json();
    const getBody: unknown = await get.json();
    expect(JSON.stringify([putBody, getBody])).not.toContain('platform.example.test');
    expect(FederationSettingsResponseSchema.parse(getBody)).toMatchObject({
      settings: SETTINGS,
      endpoint: { configured: true },
    });
  });

  it('接続先が未設定のまま有効にすると、400（項目のエラー）', async () => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', '/federation/settings', { settings: SETTINGS });

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.fields?.map((field) => field.name)).toContain('settings.enabled');
  });

  it.each([
    ['接続先が URL でない', { settings: SETTINGS, endpoint: 'not-a-url' }],
    ['テナント名が不正', { settings: { ...SETTINGS, tenant: 'Bad Tenant' } }],
    ['context が URL でない', { settings: { ...SETTINGS, contextUrl: 'x' } }],
    ['設定がない', { endpoint: ENDPOINT }],
  ])('不正な入力（%s）は、400', async (_name, body) => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', '/federation/settings', body);

    expect(response.status).toBe(400);
  });

  it('変更履歴に、設定の変更と、接続先を更新したこと（値は、含めない）を残す', async () => {
    const context = await withEquipment();
    await send(context, 'PUT', '/federation/settings', { settings: SETTINGS, endpoint: ENDPOINT });

    const response = await send(context, 'GET', '/audit-logs?targetType=ingestion-settings');

    const logs = AuditLogListResponseSchema.parse(await response.json());
    const ids = logs.items.map((entry) => entry.targetId);
    expect(ids).toContain('federation/settings');
    expect(ids).toContain('federation/endpoint');
    expect(JSON.stringify(logs)).not.toContain('platform.example.test');
  });

  it('連携を有効にすると、既存の設備を、基盤へ送る（無効 → 有効のとき。ADR-0024。D-35）', async () => {
    const { context, requests } = await ngsiLdContext();

    await send(context, 'PUT', '/federation/settings', { settings: SETTINGS, endpoint: ENDPOINT });
    context.clock.advance(DAY_MS);
    await context.container.jobRunner.run('JB-03');

    const entities = requests.flatMap(
      (request) => JSON.parse(request.body ?? '[]') as Record<string, unknown>[],
    );
    expect(entities).toContainEqual(
      expect.objectContaining({ id: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}`, type: 'HarvestRobot' }),
    );
  });
});

describe('開発用のリセット（POST /dev/reset）', () => {
  it('連携先の設定（接続先・テナント・有効）も、初期の状態（未設定）に戻す', async () => {
    const context = await withEquipment();
    await send(context, 'PUT', '/federation/settings', {
      settings: SETTINGS,
      endpoint: ENDPOINT,
    });

    await context.request('/dev/reset', { method: 'POST' });
    const response = await send(context, 'GET', '/federation/settings');

    expect(FederationSettingsResponseSchema.parse(await response.json())).toMatchObject({
      settings: { tenant: 'smart_farm_monitoring', enabled: false },
      endpoint: { configured: false },
    });
  });
});

describe('POST /federation/test', () => {
  it('モックの環境では、確認せずに、その旨を返す', async () => {
    const context = await withEquipment();

    const response = await send(context, 'POST', '/federation/test');

    expect(response.status).toBe(200);
    const result = FederationTestResponseSchema.parse(await response.json());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('モック');
  });

  it('接続先が未設定なら、その旨を返す', async () => {
    const { context } = await ngsiLdContext();

    const result = FederationTestResponseSchema.parse(
      await (await send(context, 'POST', '/federation/test')).json(),
    );

    expect(result).toEqual({ ok: false, message: '接続先が設定されていません' });
  });

  it('設定済みなら、読み取りの要求（GET）だけを送り、成功を返す。接続先を、応答に含めない', async () => {
    const { context, requests } = await ngsiLdContext(200);
    await send(context, 'PUT', '/federation/settings', {
      settings: { ...SETTINGS, enabled: false },
      endpoint: ENDPOINT,
    });

    const response = await send(context, 'POST', '/federation/test');

    const result = FederationTestResponseSchema.parse(await response.json());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('platform.example.test');
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('基盤が成功を返さなければ、失敗（状態コードだけ）を返す', async () => {
    const { context } = await ngsiLdContext(503);
    await send(context, 'PUT', '/federation/settings', {
      settings: { ...SETTINGS, enabled: false },
      endpoint: ENDPOINT,
    });

    const result = FederationTestResponseSchema.parse(
      await (await send(context, 'POST', '/federation/test')).json(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('503');
  });
});
