/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の中核（createHostedFileServer）の単体テスト。
 * 認証（読み取り用・書き込み用のトークン）・メソッド・ファイルパス・大きさ・JSON の検査・ログに秘密情報が出ないことを確かめる。
 * 保管先・秘密情報は、メモリの実装（実際の S3・パラメータストアには、接続しない）。トークンは、明らかにダミーの値。
 */

import { describe, expect, it } from 'vitest';
import {
  createHostedFileServer,
  HOSTED_FILE_MAX_BYTES,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
  type HostedFileRequest,
} from '../../../../src/backend/application/hosted-file-server/hosted-file-server.ts';
import type { LogFields, Logger } from '../../../../src/backend/application/ports/logger-port.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import { createMemoryHostedFileStore } from '../../../support/memory-hosted-file-store.ts';

const READ_TOKEN = 'dummy-read-token';
const WRITE_TOKEN = 'dummy-write-token';
const PATH = '/robot/robot-a/latest.json';
const BODY = '{"harvestCount":12}\n';
const MODIFIED = new Date('2026-11-25T01:02:03.000Z');

const bearer = (token: string): string => `Bearer ${token}`;

function request(overrides: Partial<HostedFileRequest> = {}): HostedFileRequest {
  return { method: 'GET', path: PATH, authorization: bearer(READ_TOKEN), ...overrides };
}

function put(body: string | Buffer, overrides: Partial<HostedFileRequest> = {}): HostedFileRequest {
  return request({
    method: 'PUT',
    authorization: bearer(WRITE_TOKEN),
    body: Buffer.from(body),
    ...overrides,
  });
}

/** 呼ばれたログを、記録するロガー（秘密情報・本文が出ないことの確認用）。 */
function createRecordingLogger() {
  const entries: { level: string; message: string; fields: LogFields | undefined }[] = [];
  const logger: Logger = {
    debug: (message, fields) => entries.push({ level: 'debug', message, fields }),
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
    child: () => logger,
  };
  return { logger, entries };
}

function setup(secrets?: Record<string, string>) {
  const store = createMemoryHostedFileStore(() => MODIFIED);
  const secretPort = createMemorySecretPort(
    secrets ?? {
      [HOSTED_FILE_READ_TOKEN_REFERENCE]: READ_TOKEN,
      [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: WRITE_TOKEN,
    },
  );
  const log = createRecordingLogger();
  const server = createHostedFileServer({ store, secrets: secretPort, logger: log.logger });
  return { store, secretPort, server, ...log };
}

describe('GET・HEAD（読み取り用のトークン）', () => {
  it('GET: 置かれたファイルの内容を返す（JSON。Last-Modified・ETag つき。キャッシュしない）', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const response = await server(request());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BODY);
    expect(response.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Last-Modified': MODIFIED.toUTCString(),
      ETag: '"etag-1"',
    });
  });

  it('HEAD: ヘッダーだけ（本文なし）。GET と同じヘッダーを返す', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const head = await server(request({ method: 'HEAD' }));
    const get = await server(request());

    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers).toEqual(get.headers);
  });

  it('ファイルがなければ 404（GET・HEAD とも）', async () => {
    const { server } = setup();

    const get = await server(request());
    const head = await server(request({ method: 'HEAD' }));

    expect(get).toMatchObject({ statusCode: 404, body: 'Not Found' });
    expect(head.statusCode).toBe(404);
  });

  it('形式が正しくないパスは、存在しない扱い（404）。上の階層への移動・エスケープ・空のパスも同じ', async () => {
    const { server } = setup();

    for (const path of ['/robot/../x.json', '/robot/%2e%2e/x.json', '/', '', 'robot/a.json']) {
      const response = await server(request({ path }));
      expect(response.statusCode, path).toBe(404);
    }
  });
});

describe('PUT（書き込み用のトークン）', () => {
  it('JSON のファイルを置く（204）。置いたファイルは、読み取り用のトークンで読める。上書きすると、新しい内容になる', async () => {
    const { server } = setup();

    const first = await server(put(BODY));
    const second = await server(put('{"harvestCount":13}\n'));
    const read = await server(request());

    expect(first).toMatchObject({ statusCode: 204, body: '' });
    expect(second.statusCode).toBe(204);
    expect(read.body).toBe('{"harvestCount":13}\n');
  });

  it('設備ごとのパスに、それぞれ置く（別のパスのファイルは、変わらない）', async () => {
    const { server } = setup();
    await server(put('{"a":1}', { path: '/robot/robot-a/latest.json' }));
    await server(put('{"b":2}', { path: '/robot/robot-b/latest.json' }));

    const a = await server(request({ path: '/robot/robot-a/latest.json' }));
    const b = await server(request({ path: '/robot/robot-b/latest.json' }));

    expect([a.body, b.body]).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('大きさの上限（1 MiB）ちょうどは置ける。1 バイトでも超えたら 413（置かない）', async () => {
    const { store, server } = setup();
    const filler = (bytes: number): string => `{"x":"${'a'.repeat(bytes - 8)}"}`;

    const exact = await server(put(filler(HOSTED_FILE_MAX_BYTES)));
    const over = await server(
      put(filler(HOSTED_FILE_MAX_BYTES + 1), { path: '/robot/other.json' }),
    );

    expect(exact.statusCode).toBe(204);
    expect(over.statusCode).toBe(413);
    expect(store.paths()).toEqual([PATH]);
  });

  it('JSON として読めない内容・空・UTF-8 でない内容は 400。置かず、すでにあるファイルを残す', async () => {
    const { store, server } = setup();
    await server(put(BODY));

    const broken = await server(put('{"harvestCount":'));
    const empty = await server(put(''));
    const notUtf8 = await server(put(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
    const missingBody = await server(
      request({ method: 'PUT', authorization: bearer(WRITE_TOKEN) }),
    );
    const read = await server(request());

    for (const response of [broken, empty, notUtf8, missingBody]) {
      expect(response.statusCode).toBe(400);
    }
    expect(store.putCount()).toBe(1);
    expect(read.body).toBe(BODY);
  });

  it('形式が正しくないパスには置けない（400）', async () => {
    const { store, server } = setup();

    for (const path of ['/robot/../x.json', '/robot/a b.json', '/robot/dir/', '/', '']) {
      const response = await server(put(BODY, { path }));
      expect(response.statusCode, path).toBe(400);
    }
    expect(store.putCount()).toBe(0);
  });
});

describe('認証', () => {
  it('トークンがない・違う・形式が違うときは 401（WWW-Authenticate を示す）。ファイルの内容を含めない', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const none = await server(request({ authorization: undefined }));
    const wrong = await server(request({ authorization: bearer('dummy-wrong-token') }));
    const basic = await server(request({ authorization: `Basic ${READ_TOKEN}` }));
    const empty = await server(request({ authorization: 'Bearer ' }));

    for (const response of [none, wrong, basic, empty]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['WWW-Authenticate']).toBe('Bearer');
      expect(response.body).not.toContain('harvestCount');
    }
  });

  it('スキームは、大文字・小文字を区別しない', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const response = await server(request({ authorization: `bearer ${READ_TOKEN}` }));

    expect(response.statusCode).toBe(200);
  });

  it('読み取り用のトークンでは、置けない。書き込み用のトークンでは、読めない（権限を分ける）', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const putWithRead = await server(put('{"x":1}', { authorization: bearer(READ_TOKEN) }));
    const getWithWrite = await server(request({ authorization: bearer(WRITE_TOKEN) }));

    expect(putWithRead.statusCode).toBe(401);
    expect(getWithWrite.statusCode).toBe(401);
    expect(store.putCount()).toBe(1);
  });

  it('認証の失敗は、置く検査（大きさ・JSON・パス）より先。認証されない相手に、検査の結果を知らせない', async () => {
    const { server } = setup();

    const response = await server(
      put('not json', { authorization: bearer('dummy-wrong-token'), path: '/bad path' }),
    );

    expect(response.statusCode).toBe(401);
  });

  it('トークンが未設定のあいだは、すべてのリクエストを拒否する（空のトークンで、通らない）', async () => {
    const { server } = setup({});

    const get = await server(request());
    const emptyBearer = await server(request({ authorization: 'Bearer ' }));
    const putResponse = await server(put(BODY));

    expect([get.statusCode, emptyBearer.statusCode, putResponse.statusCode]).toEqual([
      401, 401, 401,
    ]);
  });

  it('ローテーション: 値をカンマで 2 つ並べると、どちらでも通る（前後の空白は無視。3 つ目以降は無効）', async () => {
    const { store, server } = setup({
      [HOSTED_FILE_READ_TOKEN_REFERENCE]: ' dummy-old-token , dummy-new-token ,dummy-third-token',
      [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: WRITE_TOKEN,
    });
    await store.put(PATH, BODY);

    const oldToken = await server(request({ authorization: bearer('dummy-old-token') }));
    const newToken = await server(request({ authorization: bearer('dummy-new-token') }));
    const third = await server(request({ authorization: bearer('dummy-third-token') }));

    expect([oldToken.statusCode, newToken.statusCode, third.statusCode]).toEqual([200, 200, 401]);
  });

  it('秘密情報（パラメータストア）を読めないときは 503（認証の失敗と区別する）', async () => {
    const { secretPort, logger } = setup();
    const broken = createHostedFileServer({
      store: createMemoryHostedFileStore(),
      secrets: { ...secretPort, get: () => Promise.reject(new Error('dummy-secret-store-down')) },
      logger,
    });

    const response = await broken(request());

    expect(response).toMatchObject({ statusCode: 503, body: 'Service Unavailable' });
  });
});

describe('メソッドと障害', () => {
  it('GET・HEAD・PUT 以外は 405（Allow を示す）。認証より先に判定する', async () => {
    const { server } = setup();

    for (const method of ['POST', 'DELETE', 'PATCH', 'OPTIONS', '']) {
      const response = await server(request({ method, authorization: undefined }));
      expect(response.statusCode, method).toBe(405);
      expect(response.headers.Allow).toBe('GET, HEAD, PUT');
    }
  });

  it('メソッドは、大文字・小文字を区別しない', async () => {
    const { store, server } = setup();
    await store.put(PATH, BODY);

    const response = await server(request({ method: 'get' }));

    expect(response.statusCode).toBe(200);
  });

  it('保管先の障害は 503（読み取り・書き込みとも）。内容・パスを含めない', async () => {
    const { store, server } = setup();
    store.failWith(new Error('dummy-storage-down /secret/path'));

    const read = await server(request());
    const write = await server(put(BODY));

    for (const response of [read, write]) {
      expect(response.statusCode).toBe(503);
      expect(response.body).toBe('Service Unavailable');
    }
  });
});

describe('ログ', () => {
  it('トークン・本文・パスを、ログに出さない（認証の失敗・障害・置いた結果）', async () => {
    const { store, server, entries } = setup();
    await server(request({ authorization: bearer('dummy-wrong-token') }));
    await server(put(BODY, { path: '/robot/secret-name/latest.json' }));
    store.failWith(new Error('dummy-storage-down'));
    await server(request());

    const logged = JSON.stringify(entries);

    expect(entries.length).toBeGreaterThan(0);
    for (const secret of [
      READ_TOKEN,
      WRITE_TOKEN,
      'dummy-wrong-token',
      'harvestCount',
      'secret-name',
      'dummy-storage-down',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
