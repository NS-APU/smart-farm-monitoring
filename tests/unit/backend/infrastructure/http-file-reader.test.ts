/**
 * HTTP のファイルの一覧（メタデータ）・取得（Issue #119。ADR-0023）の単体テスト。
 * 手元（127.0.0.1）の HTTP サーバーに、実際に接続して確かめる（内部のアドレスは、通常は拒否するため、allowPrivateAddresses を指定する）。
 * 失敗の理由の文言に、接続先・ファイルパス・認証情報を含めない。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpFileServerConnection } from '../../../../src/shared/schemas/ingestion.ts';
import { FileSourceFailure } from '../../../../src/backend/application/ports/file-source-port.ts';
import {
  readHttpFile,
  statHttpFile,
} from '../../../../src/backend/infrastructure/http/http-file-reader.ts';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];

async function startServer(
  handler: Handler,
): Promise<{ port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function connection(port: number): HttpFileServerConnection {
  return {
    type: 'HTTP',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port,
    authMethod: 'NONE',
    apiKeyHeaderName: 'X-API-Key',
  };
}

const PATH = '/data/robot-01.json';
const ALLOW = { allowPrivateAddresses: true } as const;

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileSourceFailure);
    return (error as FileSourceFailure).reason;
  }
  throw new Error('失敗するはずの処理が、成功した');
}

describe('statHttpFile（ファイルのメタデータ）', () => {
  it('HEAD で、大きさ（Content-Length）と更新日時（Last-Modified）を得る。本文は、取得しない', async () => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200, {
        'Content-Length': '123',
        'Last-Modified': 'Fri, 09 Oct 2026 01:00:00 GMT',
      });
      response.end();
    });

    const stat = await statHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      ...ALLOW,
    });

    expect(stat.sizeBytes).toBe(123);
    expect(stat.modifiedAt?.toISOString()).toBe('2026-10-09T01:00:00.000Z');
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`HEAD ${PATH}`]);
  });

  it('Last-Modified・Content-Length がないサーバーは、更新日時・大きさを「不明」で返す', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      response.end();
    });

    const stat = await statHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      ...ALLOW,
    });

    expect(stat.sizeBytes).toBeUndefined();
    expect(stat.modifiedAt).toBeUndefined();
  });

  it('不正な Last-Modified は、更新日時を「不明」にする', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '1', 'Last-Modified': 'not-a-date' });
      response.end();
    });

    const stat = await statHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      ...ALLOW,
    });

    expect(stat.modifiedAt).toBeUndefined();
    expect(stat.sizeBytes).toBe(1);
  });

  it('HEAD が使えない（405）ときは、先頭 1 バイトだけの GET（Range）で、大きさ（Content-Range）と更新日時を得る', async () => {
    const { port, requests } = await startServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(206, {
        'Content-Range': 'bytes 0-0/4096',
        'Last-Modified': 'Fri, 09 Oct 2026 02:00:00 GMT',
      });
      response.end('x');
    });

    const stat = await statHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      ...ALLOW,
    });

    expect(requests.map((request) => request.method)).toEqual(['HEAD', 'GET']);
    expect(requests[1]?.headers.range).toBe('bytes=0-0');
    expect(stat.sizeBytes).toBe(4096);
    expect(stat.modifiedAt?.toISOString()).toBe('2026-10-09T02:00:00.000Z');
  });

  it('空のファイルで GET の Range が 416 のときは、大きさ 0 で返す', async () => {
    const { port } = await startServer((request, response) => {
      response.writeHead(request.method === 'HEAD' ? 405 : 416);
      response.end();
    });

    const stat = await statHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      ...ALLOW,
    });

    expect(stat.sizeBytes).toBe(0);
  });

  it('認証のヘッダーを送る。リクエストのパスは、引数のパス（接続設定にはパスがない）', async () => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await statHttpFile({
      connection: connection(port),
      path: '/other/sensor-01.json',
      headers: { Authorization: 'Bearer dummy-token' },
      ...ALLOW,
    });

    expect(requests[0]?.url).toBe('/other/sensor-01.json');
    expect(requests[0]?.headers.authorization).toBe('Bearer dummy-token');
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [500, 'SERVER_ERROR'],
    [302, 'REDIRECT'],
    [418, 'UNEXPECTED_RESPONSE'],
  ])('状態コード %i は、理由 %s で失敗する', async (status, reason) => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(status, { Location: 'http://127.0.0.1:1/' });
      response.end();
    });

    expect(
      await reasonOf(
        statHttpFile({ connection: connection(port), path: PATH, headers: {}, ...ALLOW }),
      ),
    ).toBe(reason);
  });

  it('内部のアドレスは、拒否する（allowPrivateAddresses がないとき）', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    expect(
      await reasonOf(statHttpFile({ connection: connection(port), path: PATH, headers: {} })),
    ).toBe('ADDRESS_BLOCKED');
  });
});

describe('readHttpFile（ファイルの取得）', () => {
  it('GET で、本文を UTF-8 のテキストとして返す（日本語を含む。分割して届いても、つなげる）', async () => {
    const { port, requests } = await startServer((_request, response) => {
      const bytes = Buffer.from('{"名前":"収穫ロボット"}', 'utf8');
      response.writeHead(200);
      response.write(bytes.subarray(0, 8));
      response.end(bytes.subarray(8));
    });

    const text = await readHttpFile({
      connection: connection(port),
      path: PATH,
      headers: { 'X-API-Key': 'dummy-api-key' },
      maxBytes: 1024,
      ...ALLOW,
    });

    expect(text).toBe('{"名前":"収穫ロボット"}');
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`GET ${PATH}`]);
    expect(requests[0]?.headers['x-api-key']).toBe('dummy-api-key');
  });

  it('空のファイルは、空の文字列', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '0' });
      response.end();
    });

    expect(
      await readHttpFile({
        connection: connection(port),
        path: PATH,
        headers: {},
        maxBytes: 10,
        ...ALLOW,
      }),
    ).toBe('');
  });

  it('大きさの上限を超える本文は、Content-Length がなくても（途中で）失敗する', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.write('x'.repeat(600));
      response.end('x'.repeat(600));
    });

    expect(
      await reasonOf(
        readHttpFile({
          connection: connection(port),
          path: PATH,
          headers: {},
          maxBytes: 1000,
          ...ALLOW,
        }),
      ),
    ).toBe('TOO_LARGE');
  });

  it('Content-Length が上限を超えるときは、本文を読まずに失敗する', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '5000' });
      response.write('x');
      // 本文を、最後まで送らない
    });

    expect(
      await reasonOf(
        readHttpFile({
          connection: connection(port),
          path: PATH,
          headers: {},
          maxBytes: 1000,
          ...ALLOW,
        }),
      ),
    ).toBe('TOO_LARGE');
  });

  it('上限ちょうどの大きさは、読める', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('x'.repeat(1000));
    });

    const text = await readHttpFile({
      connection: connection(port),
      path: PATH,
      headers: {},
      maxBytes: 1000,
      ...ALLOW,
    });

    expect(text).toHaveLength(1000);
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [503, 'SERVER_ERROR'],
    [301, 'REDIRECT'],
  ])('状態コード %i は、理由 %s で失敗する。リダイレクトには、従わない', async (status, reason) => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(status, { Location: '/elsewhere.json' });
      response.end('x');
    });

    expect(
      await reasonOf(
        readHttpFile({
          connection: connection(port),
          path: PATH,
          headers: {},
          maxBytes: 100,
          ...ALLOW,
        }),
      ),
    ).toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it('応答が途中で切れたとき・応答しないときは、接続の失敗として扱う', async () => {
    const cut = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('x');
      setTimeout(() => response.destroy(), 20);
    });
    const slow = await startServer(() => {
      // 応答しない
    });

    expect(
      await reasonOf(
        readHttpFile({
          connection: connection(cut.port),
          path: PATH,
          headers: {},
          maxBytes: 1000,
          ...ALLOW,
        }),
      ),
    ).toBe('UNREACHABLE');
    expect(
      await reasonOf(
        readHttpFile({
          connection: connection(slow.port),
          path: PATH,
          headers: {},
          maxBytes: 1000,
          timeoutMs: 100,
          ...ALLOW,
        }),
      ),
    ).toBe('TIMEOUT');
  });

  it('内部のアドレスは、拒否する（allowPrivateAddresses がないとき）', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });

    expect(
      await reasonOf(
        readHttpFile({ connection: connection(port), path: PATH, headers: {}, maxBytes: 100 }),
      ),
    ).toBe('ADDRESS_BLOCKED');
  });

  it('失敗の理由の文言に、接続先・ファイルパス・認証情報を含めない', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });

    try {
      await readHttpFile({
        connection: connection(port),
        path: PATH,
        headers: { Authorization: 'Bearer dummy-token' },
        maxBytes: 100,
        ...ALLOW,
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('127.0.0.1');
      expect(message).not.toContain(PATH);
      expect(message).not.toContain('dummy-token');
    }
  });
});
