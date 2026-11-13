/**
 * 農業情報基盤への HTTP の送信（NGSI-LD。ADR-0024。Issue #177 の PR 1）の単体テスト。
 * 手元の HTTP サーバー（ローカルのテスト用。内部のアドレスを許可）に送り、内容・ヘッダー・状態コードを確かめる。
 * 管理者が接続先を設定できるため、内部のアドレスへの接続・リダイレクトを拒否する（SSRF の対策。ADR-0022 と同じ）。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NgsiLdTransportError,
  createHttpNgsiLdTransport,
} from '../../../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | undefined;

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current !== undefined) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

const BASE = {
  protocol: 'HTTP',
  host: '127.0.0.1',
  path: '/api/orion/ngsi-ld/v1/entityOperations/upsert?options=update',
  headers: { 'Content-Type': 'application/json', 'NGSILD-Tenant': 'smart_farm_monitoring' },
  body: '[{"id":"urn:ngsi-ld:EquipmentObserved:A"}]',
} as const;

describe('NGSI-LD の HTTP の送信', () => {
  it('POST で、パス・ヘッダー・本文を送り、状態コードと本文を返す', async () => {
    const { port, received } = await startServer((_request, response) => {
      response.writeHead(207, { 'Content-Type': 'application/json' });
      response.end('{"success":[],"errors":[]}');
    });
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    const result = await transport({ ...BASE, port });

    expect(result).toEqual({ status: 207, body: '{"success":[],"errors":[]}' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: 'POST',
      url: BASE.path,
      body: BASE.body,
    });
    expect(received[0]?.headers['ngsild-tenant']).toBe('smart_farm_monitoring');
    expect(received[0]?.headers['content-type']).toBe('application/json');
    expect(received[0]?.headers['content-length']).toBe(String(Buffer.byteLength(BASE.body)));
  });

  it('204（本文なし）も、返す', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    expect(await transport({ ...BASE, port })).toEqual({ status: 204, body: '' });
  });

  it('リダイレクトには、従わない（状態コードを、そのまま返す）', async () => {
    const { port, received } = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://169.254.169.254/' });
      response.end();
    });
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    const result = await transport({ ...BASE, port });

    expect(result.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it('接続できなければ UNREACHABLE。応答がなければ TIMEOUT', async () => {
    const closed = await startServer(() => undefined);
    const port = closed.port;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    await expect(transport({ ...BASE, port })).rejects.toMatchObject({ reason: 'UNREACHABLE' });

    const silent = await startServer(() => undefined);
    await expect(transport({ ...BASE, port: silent.port, timeoutMs: 50 })).rejects.toMatchObject({
      reason: 'TIMEOUT',
    });
  });

  it('内部のアドレス（IP の直接の指定・名前の解決の結果）には、接続しない（ADDRESS_BLOCKED）。許可するのは、ローカル・テストだけ', async () => {
    const { port, received } = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const strict = createHttpNgsiLdTransport({
      resolver: (_host, _options, callback) => {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    });

    await expect(strict({ ...BASE, port })).rejects.toMatchObject({ reason: 'ADDRESS_BLOCKED' });
    await expect(strict({ ...BASE, host: 'internal.example.test', port })).rejects.toMatchObject({
      reason: 'ADDRESS_BLOCKED',
    });
    expect(received).toHaveLength(0);
  });

  it('応答の本文が大きすぎるときは、TOO_LARGE', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(207);
      response.end('x'.repeat(2 * 1024 * 1024));
    });
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    await expect(transport({ ...BASE, port })).rejects.toBeInstanceOf(NgsiLdTransportError);
    await expect(transport({ ...BASE, port })).rejects.toMatchObject({ reason: 'TOO_LARGE' });
  });

  it('失敗の文言に、接続先・本文を含めない', async () => {
    const transport = createHttpNgsiLdTransport({ allowPrivateAddresses: true });

    try {
      await transport({ ...BASE, host: '127.0.0.1', port: 1, body: '{"secret":"dummy-value"}' });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('127.0.0.1');
      expect(message).not.toContain('dummy-value');
    }
  });
});
