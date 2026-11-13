/**
 * 農業情報基盤への連携のアダプタ（NGSI-LD の upsert。ADR-0024。Issue #177 の PR 1）の単体テスト。
 * 送信は、差し替えた transport で確かめる（実際の接続先に依存しない）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FederationRejectedError,
  FederationUnavailableError,
} from '../../../../src/backend/application/ports/federation-port.ts';
import type { FederationConnection } from '../../../../src/backend/application/federation/federation-connection-store.ts';
import {
  NgsiLdTransportError,
  type NgsiLdRequest,
  type NgsiLdResponse,
  type NgsiLdTransport,
} from '../../../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import {
  createNgsiLdFederation,
  probeNgsiLd,
} from '../../../../src/backend/infrastructure/http/ngsi-ld-federation.ts';
import type { FederationItem } from '../../../../src/shared/schemas/ingestion.ts';
import type { Observation } from '../../../../src/shared/schemas/observation.ts';
import { equipmentSet, observation, SENSOR_ID } from '../../../support/builders.ts';

const CONNECTION: FederationConnection = {
  endpoint: { protocol: 'HTTPS', host: 'platform.example.test', basePath: '/api/orion/ngsi-ld/v1' },
  tenant: 'smart_farm_monitoring',
  contextUrl: 'https://example.test/context.jsonld',
  enabled: true,
};

function item(observations: readonly Observation[], federationItemId = 'item-1'): FederationItem {
  return {
    federationItemId,
    targetType: 'OBSERVATION',
    targetRef: `environment-sensor#${federationItemId}`,
    payload: { sourceId: 'environment-sensor', fileId: federationItemId, observations },
    status: 'PENDING',
    attempts: 0,
    enqueuedAt: '2026-10-09T02:00:00.000Z',
    updatedAt: '2026-10-09T02:00:00.000Z',
    nextAttemptAt: '2026-10-09T02:00:00.000Z',
  };
}

const SENSOR_OBSERVATIONS = [
  observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 27.5 }),
  observation({ equipmentId: SENSOR_ID, itemKey: 'humidityPercent', value: 60 }),
];

function build(
  respond: (request: NgsiLdRequest) => NgsiLdResponse | Promise<NgsiLdResponse> = () => ({
    status: 204,
    body: '',
  }),
  connection: FederationConnection | undefined = CONNECTION,
  configured = true,
) {
  const requests: NgsiLdRequest[] = [];
  const transport: NgsiLdTransport = async (request) => {
    requests.push(request);
    return respond(request);
  };
  const list = vi.fn().mockResolvedValue(equipmentSet());
  const port = createNgsiLdFederation({
    connection: () => Promise.resolve(configured ? connection : undefined),
    transport,
    equipment: { list },
  });
  return { port, requests, list };
}

describe('NGSI-LD のアダプタ（FederationPort）', () => {
  it('upsert（options=update）に、設備ごとのエンティティを POST する。テナント・context・内容の形式のヘッダーを付ける', async () => {
    const { port, requests, list } = build();

    await port.send([item(SENSOR_OBSERVATIONS)]);

    expect(list).toHaveBeenCalledWith({ includeDeleted: true });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toMatchObject({
      protocol: 'HTTPS',
      host: 'platform.example.test',
      path: '/api/orion/ngsi-ld/v1/entityOperations/upsert?options=update',
    });
    expect(request?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'NGSILD-Tenant': 'smart_farm_monitoring',
      Link: '<https://example.test/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"',
    });
    const body = JSON.parse(request?.body ?? '[]') as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: `urn:ngsi-ld:IndoorEnvironmentObserved:${SENSOR_ID}`,
      type: 'IndoorEnvironmentObserved',
      // 設備の種別（センサー）を、設備の記録から引いて、refDevice を付ける
      refDevice: { type: 'Relationship', object: `urn:ngsi-ld:EnvironmentSensor:${SENSOR_ID}` },
    });
  });

  it('ポートの指定は、そのまま使う。基準のパスがなくても、動く', async () => {
    const { port, requests } = build(undefined, {
      ...CONNECTION,
      endpoint: { protocol: 'HTTP', host: 'platform.example.test', port: 1026, basePath: '' },
    });

    await port.send([item(SENSOR_OBSERVATIONS)]);

    expect(requests[0]).toMatchObject({
      protocol: 'HTTP',
      port: 1026,
      path: '/entityOperations/upsert?options=update',
    });
  });

  it('複数の項目をまとめて送る。同じエンティティの複数の時刻は、古い順の別の要求にする', async () => {
    const { port, requests } = build();
    const earlier = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 20,
      observedAt: '2026-10-09T02:00:00.000Z',
    });
    const later = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 21,
      observedAt: '2026-10-09T02:05:00.000Z',
    });

    await port.send([item([later], 'item-2'), item([earlier], 'item-1')]);

    expect(requests).toHaveLength(2);
    const values = requests.map(
      (request) =>
        (JSON.parse(request.body ?? '[]') as { temperature: { value: number } }[])[0]?.temperature
          .value,
    );
    expect(values).toEqual([20, 21]);
  });

  it('送るものがない項目（不正・欠損のみ）は、要求を送らず、成功にする', async () => {
    const { port, requests } = build();

    await port.send([
      item([
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: null,
          quality: 'MISSING',
        }),
      ]),
    ]);

    expect(requests).toHaveLength(0);
  });

  it('連携先が未設定・無効のときは、送らずに、利用できない（保留）として扱う', async () => {
    const unset = build(undefined, CONNECTION, false);
    const disabled = build(undefined, { ...CONNECTION, enabled: false });

    await expect(unset.port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(
      FederationUnavailableError,
    );
    await expect(disabled.port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(
      FederationUnavailableError,
    );
    expect(unset.requests).toHaveLength(0);
    expect(disabled.requests).toHaveLength(0);
  });

  it.each([200, 201, 204])('状態コード %s は、成功', async (status) => {
    const { port } = build(() => ({ status, body: '' }));

    await expect(port.send([item(SENSOR_OBSERVATIONS)])).resolves.toBeUndefined();
  });

  it('207 で、エラーがなければ成功。エラーがあれば、失敗（受け付けなかった）にする', async () => {
    const ok = build(() => ({ status: 207, body: '{"success":["a"],"errors":[]}' }));
    const failed = build(() => ({
      status: 207,
      body: '{"success":[],"errors":[{"entityId":"a","error":{"title":"Bad"}}]}',
    }));

    await expect(ok.port.send([item(SENSOR_OBSERVATIONS)])).resolves.toBeUndefined();
    await expect(failed.port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(
      FederationRejectedError,
    );
  });

  it.each([400, 404, 415, 422, 302])(
    '状態コード %s は、失敗（受け付けなかった）',
    async (status) => {
      const { port } = build(() => ({ status, body: '{"detail":"dummy-body-detail"}' }));

      await expect(port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(
        FederationRejectedError,
      );
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    '状態コード %s は、利用できない（保留。あとで再試行する）',
    async (status) => {
      const { port } = build(() => ({ status, body: '' }));

      await expect(port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(
        FederationUnavailableError,
      );
    },
  );

  it.each([
    ['UNREACHABLE', FederationUnavailableError],
    ['TIMEOUT', FederationUnavailableError],
    ['ADDRESS_BLOCKED', FederationRejectedError],
    ['TLS', FederationRejectedError],
    ['CERTIFICATE', FederationRejectedError],
    ['TOO_LARGE', FederationRejectedError],
  ] as const)('送信の失敗 %s の扱い', async (reason, expected) => {
    const { port } = build(() => {
      throw new NgsiLdTransportError(reason);
    });

    await expect(port.send([item(SENSOR_OBSERVATIONS)])).rejects.toBeInstanceOf(expected);
  });

  it('失敗の文言に、接続先・応答の本文・データを含めない', async () => {
    const { port } = build(() => ({ status: 400, body: '{"detail":"dummy-body-detail"}' }));

    try {
      await port.send([item(SENSOR_OBSERVATIONS)]);
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('platform.example.test');
      expect(message).not.toContain('dummy-body-detail');
      expect(message).not.toContain('temperature');
    }
  });

  it('途中の要求が失敗したら、そこで止めて、失敗にする（前の要求は、送信済み。再送は、冪等）', async () => {
    let count = 0;
    const { port, requests } = build(() => {
      count += 1;
      return { status: count === 2 ? 503 : 204, body: '' };
    });
    const first = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 20,
      observedAt: '2026-10-09T02:00:00.000Z',
    });
    const second = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 21,
      observedAt: '2026-10-09T02:05:00.000Z',
    });
    const third = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 22,
      observedAt: '2026-10-09T02:10:00.000Z',
    });

    await expect(port.send([item([first, second, third])])).rejects.toBeInstanceOf(
      FederationUnavailableError,
    );
    expect(requests).toHaveLength(2);
  });
});

describe('NGSI-LD の接続の確認（probeNgsiLd）', () => {
  function probeWith(respond: (request: NgsiLdRequest) => NgsiLdResponse) {
    const requests: NgsiLdRequest[] = [];
    const transport: NgsiLdTransport = (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    };
    return { requests, run: () => probeNgsiLd(CONNECTION, transport) };
  }

  it('テナント・context つきで、読み取り（GET /entities?type=Greenhouse&limit=1）だけを送る（書き込みは、しない）', async () => {
    const { requests, run } = probeWith(() => ({ status: 200, body: '[]' }));

    const result = await run();

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      protocol: 'HTTPS',
      host: 'platform.example.test',
      path: '/api/orion/ngsi-ld/v1/entities?type=Greenhouse&limit=1',
    });
    expect(requests[0]?.headers).toMatchObject({
      'NGSILD-Tenant': 'smart_farm_monitoring',
      Link: '<https://example.test/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"',
    });
    expect(requests[0]?.body).toBeUndefined();
  });

  it.each([
    [404, false],
    [400, false],
    [503, false],
  ])('状態コード %s は、成功ではない（理由だけを示し、本文・接続先を含めない）', async (status) => {
    const { run } = probeWith(() => ({ status, body: '{"detail":"dummy-body-detail"}' }));

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('dummy-body-detail');
    expect(result.message).not.toContain('platform.example.test');
    expect(result.message).toContain(String(status));
  });

  it.each(['UNREACHABLE', 'TIMEOUT', 'ADDRESS_BLOCKED', 'TLS', 'CERTIFICATE'] as const)(
    '送信の失敗 %s は、固定の文言で示す（接続先を含めない）',
    async (reason) => {
      const transport: NgsiLdTransport = () => {
        throw new NgsiLdTransportError(reason);
      };

      const result = await probeNgsiLd(CONNECTION, transport);

      expect(result.ok).toBe(false);
      expect(result.message).toBe(new NgsiLdTransportError(reason).message);
    },
  );
});
