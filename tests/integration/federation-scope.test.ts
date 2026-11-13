/**
 * 農業情報基盤へ連携するデータの範囲（ADR-0004 の D-35。ADR-0024。Issue #177 の完了条件）の結合テスト。
 * 連携するのは、ロボット・環境センサーのデータ（手動入力を含む）、観点の分析結果（評価）、設備の名前・ID だけ。
 * **システムに登録するユーザー・設定のデータは、連携しない**。ユーザーの登録・ステータスコードの登録・判断基準の変更・
 * 連携先の設定の変更をしても、連携キューにも、基盤への送信にも、それらの内容が含まれないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import type {
  NgsiLdRequest,
  NgsiLdTransport,
} from '../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import { withEquipment, type TestContext } from '../support/test-context.ts';

const DAY_MS = 24 * 60 * 60_000;
const DUMMY_PASSWORD = 'Dummy-Passw0rd-scope';

function send(context: TestContext, method: string, path: string, body?: unknown) {
  return context.request(path, { method, ...(body === undefined ? {} : { body }) });
}

describe('農業情報基盤へ連携するデータの範囲', () => {
  it('ユーザー・ステータスコード・判断基準・連携先の設定を変更しても、その内容は、連携キューにも、基盤への送信にも、含まれない', async () => {
    const requests: NgsiLdRequest[] = [];
    const transport: NgsiLdTransport = (request) => {
      requests.push(request);
      return Promise.resolve({ status: 204, body: '' });
    };
    const context = await withEquipment({
      env: { FEDERATION_MODE: 'ngsi-ld' },
      federationTransport: transport,
    });
    expect(
      (
        await send(context, 'PUT', '/federation/settings', {
          settings: {
            tenant: 'smart_farm_monitoring',
            contextUrl: 'https://example.test/context.jsonld',
            enabled: true,
          },
          endpoint: 'https://platform.example.test/api/orion/ngsi-ld/v1',
        })
      ).status,
    ).toBe(200);

    // システムに登録するユーザー・設定のデータの変更
    await send(context, 'POST', '/users', {
      userId: 'scope-user-2',
      userName: '範囲確認のユーザー',
      password: DUMMY_PASSWORD,
      role: 'general',
    });
    await send(context, 'POST', '/status-codes', {
      code: 'SCOPE_CODE',
      name: '範囲確認のコード',
      category: 'NORMAL',
    });
    await send(context, 'PUT', '/viewpoints/environmentalAdaptability/criteria', {
      criteria: [
        {
          indicator: 'temperatureCelsius',
          kind: 'RANGE',
          thresholds: { errorLower: 0, normalLower: 10, normalUpper: 25, errorUpper: 35 },
          label: '範囲確認の温度',
        },
        {
          indicator: 'humidityPercent',
          kind: 'RANGE',
          thresholds: { errorLower: 30, normalLower: 40, normalUpper: 80, errorUpper: 90 },
          label: '湿度',
        },
        {
          indicator: 'illuminanceLux',
          kind: 'RANGE',
          thresholds: {
            errorLower: 10000,
            normalLower: 20000,
            normalUpper: 40000,
            errorUpper: 50000,
          },
          label: '照度',
        },
        {
          indicator: 'co2Ppm',
          kind: 'RANGE',
          thresholds: { errorLower: 200, normalLower: 800, normalUpper: 1000, errorUpper: 3000 },
          label: 'CO2濃度',
        },
      ],
    });
    context.clock.advance(DAY_MS);
    await context.container.jobRunner.run('JB-03');

    const queued = await context.container.repositories.federation.listDue(
      new Date(context.clock.now().getTime() + 365 * DAY_MS),
      1000,
    );
    const texts = [JSON.stringify(queued), ...requests.map((request) => request.body ?? '')].join(
      '\n',
    );
    // 連携の種類は、観測値・評価・設備だけ
    expect(
      queued.every((item) => ['OBSERVATION', 'EVALUATION', 'EQUIPMENT'].includes(item.targetType)),
    ).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const content of [
      'scope-user-2',
      '範囲確認のユーザー',
      DUMMY_PASSWORD,
      'SCOPE_CODE',
      '範囲確認のコード',
      '範囲確認の温度',
      'platform.example.test',
      'smart_farm_monitoring',
    ]) {
      expect(texts).not.toContain(content);
    }
  });
});
