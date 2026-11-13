/**
 * FederationPort の契約テスト（ADR-0004・ADR-0024。Issue #177 の PR 1）。
 * 既存のモックと、NGSI-LD のアダプタ（手元の模擬の基盤〔HTTP サーバー〕に送る）に、同じ契約を適用する。
 * 契約: 送信できる → 成功。停止している → FederationUnavailableError（保留）。受け付けない → FederationRejectedError（失敗）。
 * テストは、模擬の基盤を使い、実際の接続先に依存しない。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FederationConnection } from '../../src/backend/application/federation/federation-connection-store.ts';
import {
  FederationRejectedError,
  FederationUnavailableError,
  type FederationPort,
} from '../../src/backend/application/ports/federation-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createFaultController } from '../../src/backend/infrastructure/local/faults.ts';
import { createMockFederation } from '../../src/backend/infrastructure/local/mock-federation.ts';
import { createNgsiLdFederation } from '../../src/backend/infrastructure/http/ngsi-ld-federation.ts';
import { createHttpNgsiLdTransport } from '../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import type { FederationItem } from '../../src/shared/schemas/ingestion.ts';
import { equipmentSet, observation, SENSOR_ID } from '../support/builders.ts';
import { TEST_NOW } from '../support/test-context.ts';

type Mode = 'UP' | 'DOWN' | 'REJECT';

/** 契約を確かめる対象（ポートと、模擬の基盤の状態の切り替え）。 */
interface Harness {
  readonly port: FederationPort;
  setMode(mode: Mode): void;
  /** 基盤が受け取った内容があるか。 */
  receivedAny(): boolean;
  close(): Promise<void>;
}

function item(): FederationItem {
  return {
    federationItemId: 'item-1',
    targetType: 'OBSERVATION',
    targetRef: 'environment-sensor#file-1',
    payload: {
      sourceId: 'environment-sensor',
      fileId: 'file-1',
      observations: [
        observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 25 }),
      ],
    },
    status: 'PENDING',
    attempts: 0,
    enqueuedAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
    nextAttemptAt: TEST_NOW.toISOString(),
  };
}

function mockHarness(): Harness {
  const faults = createFaultController();
  const mock = createMockFederation({ faults, clock: createControllableClock(TEST_NOW) });
  return {
    port: mock,
    setMode: (mode) => {
      faults.set({ mode });
    },
    receivedAny: () => mock.received().length > 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    close: async () => undefined,
  };
}

async function ngsiLdHarness(): Promise<Harness> {
  let mode: Mode = 'UP';
  let received = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (mode === 'DOWN') {
        response.writeHead(503);
        response.end();
        return;
      }
      if (mode === 'REJECT') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"type":"BadRequestData"}');
        return;
      }
      received += 1;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const connection: FederationConnection = {
    endpoint: { protocol: 'HTTP', host: '127.0.0.1', port, basePath: '/api/orion/ngsi-ld/v1' },
    tenant: 'smart_farm_monitoring',
    contextUrl: 'https://example.test/context.jsonld',
    enabled: true,
  };
  return {
    port: createNgsiLdFederation({
      connection: () => Promise.resolve(connection),
      transport: createHttpNgsiLdTransport({ allowPrivateAddresses: true }),
      equipment: { list: () => Promise.resolve(equipmentSet()) },
    }),
    setMode: (next) => {
      mode = next;
    },
    receivedAny: () => received > 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

describe.each([
  ['モック', () => Promise.resolve(mockHarness())],
  ['NGSI-LD のアダプタ（模擬の基盤）', ngsiLdHarness],
] as const)('FederationPort の契約: %s', (_name, create) => {
  async function setup(): Promise<Harness> {
    const harness = await create();
    open.push(harness);
    return harness;
  }

  it('基盤が動いていれば、送信でき、基盤が受け取る', async () => {
    const harness = await setup();

    await expect(harness.port.send([item()])).resolves.toBeUndefined();
    expect(harness.receivedAny()).toBe(true);
  });

  it('基盤が停止していれば、FederationUnavailableError（保留）', async () => {
    const harness = await setup();
    harness.setMode('DOWN');

    await expect(harness.port.send([item()])).rejects.toBeInstanceOf(FederationUnavailableError);
    expect(harness.receivedAny()).toBe(false);
  });

  it('基盤が受け付けなければ、FederationRejectedError（失敗）', async () => {
    const harness = await setup();
    harness.setMode('REJECT');

    await expect(harness.port.send([item()])).rejects.toBeInstanceOf(FederationRejectedError);
  });

  it('停止から復旧したら、再び送信できる', async () => {
    const harness = await setup();
    harness.setMode('DOWN');
    await expect(harness.port.send([item()])).rejects.toBeInstanceOf(FederationUnavailableError);

    harness.setMode('UP');

    await expect(harness.port.send([item()])).resolves.toBeUndefined();
  });
});
