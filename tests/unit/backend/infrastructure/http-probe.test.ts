/**
 * HTTP のファイルの接続テスト（Issue #172。ADR-0022）の単体テスト。
 * 手元（127.0.0.1）の HTTP サーバーに、実際に接続して確かめる。内部のアドレスは、通常は拒否するため、
 * 接続を試すテストでは、allowPrivateAddresses を指定する。失敗の理由の文言に、接続先・ファイルパス・認証情報を含めない。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpFileServerConnection } from '../../../../src/shared/schemas/ingestion.ts';
import { FileSourceFailure } from '../../../../src/backend/application/ports/file-source-port.ts';
import {
  classifyNetworkError,
  probeHttpFile,
  type HostResolver,
} from '../../../../src/backend/infrastructure/http/http-probe.ts';

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

function connection(
  port: number,
  overrides: Partial<HttpFileServerConnection> = {},
): HttpFileServerConnection {
  return {
    type: 'HTTP',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port,
    authMethod: 'NONE',
    apiKeyHeaderName: 'X-API-Key',
    ...overrides,
  };
}

const ALLOW = { allowPrivateAddresses: true } as const;
const PATH = '/data/robot/latest.json';

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileSourceFailure);
    return (error as FileSourceFailure).reason;
  }
  throw new Error('失敗するはずの接続テストが、成功した');
}

describe('接続テストの成功', () => {
  it('HEAD で、ファイルがあることを確かめる（本文は、取得しない）', async () => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '10' });
      response.end();
    });

    await probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'HEAD /data/robot/latest.json',
    ]);
  });

  it('HEAD が使えない（405）ときは、先頭 1 バイトだけの GET（Range）で確かめる', async () => {
    const { port, requests } = await startServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(206, { 'Content-Range': 'bytes 0-0/10' });
      response.end('x');
    });

    await probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW });

    expect(requests.map((request) => request.method)).toEqual(['HEAD', 'GET']);
    expect(requests[1]?.headers.range).toBe('bytes=0-0');
  });

  it('空のファイルで GET の Range が 416 のときも、ファイルがあるので、成功', async () => {
    const { port } = await startServer((request, response) => {
      response.writeHead(request.method === 'HEAD' ? 405 : 416);
      response.end();
    });

    await expect(
      probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW }),
    ).resolves.toBeUndefined();
  });

  it('認証のヘッダーを、そのまま送る。User-Agent は、固定の値', async () => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await probeHttpFile({
      path: PATH,
      connection: connection(port, { authMethod: 'API_KEY' }),
      headers: { 'X-API-Key': 'dummy-api-key' },
      ...ALLOW,
    });

    expect(requests[0]?.headers['x-api-key']).toBe('dummy-api-key');
    expect(requests[0]?.headers['user-agent']).toBe('smart-farm-monitoring');
  });
});

describe('接続テストの失敗の理由', () => {
  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [400, 'UNEXPECTED_RESPONSE'],
    [429, 'UNEXPECTED_RESPONSE'],
  ])('HTTP %i は、%s', async (status, reason) => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(status);
      response.end();
    });

    expect(
      await reasonOf(
        probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW }),
      ),
    ).toBe(reason);
  });

  it('リダイレクト（301・302・307）は、追従せず、REDIRECT（内部のアドレスへの誘導を避ける）', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const { port } = await startServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${String(target.port)}/x` });
      response.end();
    });

    expect(
      await reasonOf(
        probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW }),
      ),
    ).toBe('REDIRECT');
    expect(target.requests).toHaveLength(0);
  });

  it('接続できない（ポートを開けていない）は、UNREACHABLE', async () => {
    const { port } = await startServer((_request, response) => response.end());
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );

    expect(
      await reasonOf(
        probeHttpFile({ path: PATH, connection: connection(port), headers: {}, ...ALLOW }),
      ),
    ).toBe('UNREACHABLE');
  });

  it('応答が、時間内に返らないときは、TIMEOUT', async () => {
    const { port } = await startServer(() => {
      // 応答しない
    });

    expect(
      await reasonOf(
        probeHttpFile({
          path: PATH,
          connection: connection(port),
          headers: {},
          timeoutMs: 100,
          ...ALLOW,
        }),
      ),
    ).toBe('TIMEOUT');
  });

  it('エラーの文言に、接続先・ファイルパス・認証情報を含めない', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });

    const error = await probeHttpFile({
      path: PATH,
      connection: connection(port, { authMethod: 'BEARER' }),
      headers: { Authorization: 'Bearer dummy-token-value' },
      ...ALLOW,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileSourceFailure);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
    expect(text).not.toContain('dummy-token-value');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('/data/robot/latest.json');
    expect(text).not.toContain(String(port));
  });
});

describe('内部のアドレスの拒否（SSRF の対策）', () => {
  it.each([
    ['ループバック（IPv4）', '127.0.0.1'],
    ['AWS のメタデータ', '169.254.169.254'],
    ['プライベート', '10.1.2.3'],
    ['ループバック（IPv6）', '[::1]'],
    ['localhost', 'localhost'],
    ['内部の名前', 'service.internal'],
    ['数字だけの名前（127.0.0.1 に解釈される）', '2130706433'],
  ])('%s（%s）は、接続せずに、ADDRESS_BLOCKED', async (_name, host) => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    expect(
      await reasonOf(
        probeHttpFile({ path: PATH, connection: connection(port, { host }), headers: {} }),
      ),
    ).toBe('ADDRESS_BLOCKED');
    expect(requests).toHaveLength(0);
  });

  it('名前の解決の結果が、内部のアドレスなら、接続の直前に拒否する（DNS リバインディングの対策）', async () => {
    const { port, requests } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const resolver: HostResolver = (_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };

    expect(
      await reasonOf(
        probeHttpFile({
          path: PATH,
          connection: connection(port, { host: 'fileserver.example.ac.jp' }),
          headers: {},
          resolver,
        }),
      ),
    ).toBe('ADDRESS_BLOCKED');
    expect(requests).toHaveLength(0);
  });

  it('名前の解決の結果に、1 つでも内部のアドレスがあれば、拒否する', async () => {
    const resolver: HostResolver = (_hostname, _options, callback) => {
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    };

    expect(
      await reasonOf(
        probeHttpFile({
          path: PATH,
          connection: connection(443, { host: 'fileserver.example.ac.jp', protocol: 'HTTPS' }),
          headers: {},
          resolver,
        }),
      ),
    ).toBe('ADDRESS_BLOCKED');
  });

  it('allowPrivateAddresses を指定すると、内部のアドレスにも、接続できる（ローカル・テスト用）', async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await expect(
      probeHttpFile({
        path: PATH,
        connection: connection(port),
        headers: {},
        allowPrivateAddresses: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('名前を、解決できないときは、UNREACHABLE', async () => {
    const resolver: HostResolver = (_hostname, _options, callback) => {
      callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), []);
    };

    expect(
      await reasonOf(
        probeHttpFile({
          path: PATH,
          connection: connection(443, { host: 'fileserver.example.ac.jp', protocol: 'HTTPS' }),
          headers: {},
          resolver,
        }),
      ),
    ).toBe('UNREACHABLE');
  });
});

describe('ネットワークのエラーの分類', () => {
  it.each([
    ['ECONNREFUSED', 'UNREACHABLE'],
    ['ENOTFOUND', 'UNREACHABLE'],
    ['ECONNRESET', 'UNREACHABLE'],
    ['EHOSTUNREACH', 'UNREACHABLE'],
    ['ETIMEDOUT', 'TIMEOUT'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERTIFICATE'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'CERTIFICATE'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERTIFICATE'],
    ['CERT_HAS_EXPIRED', 'CERTIFICATE'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERTIFICATE'],
    ['EPROTO', 'TLS'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'TLS'],
    ['SOMETHING_ELSE', 'UNREACHABLE'],
  ])('%s は、%s', (code, reason) => {
    expect(classifyNetworkError(Object.assign(new Error('x'), { code }))).toBe(reason);
  });

  it('コードのないエラーは、UNREACHABLE', () => {
    expect(classifyNetworkError(new Error('x'))).toBe('UNREACHABLE');
    expect(classifyNetworkError('x')).toBe('UNREACHABLE');
  });
});
