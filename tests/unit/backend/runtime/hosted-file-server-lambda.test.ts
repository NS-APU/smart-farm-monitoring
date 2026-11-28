/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の Lambda の入り口（Function URL のイベントの変換・環境変数の読み取り）の単体テスト。
 * 中核（createHostedFileServer）の動作は、`hosted-file-server.test.ts`。ここでは、イベント・レスポンスの対応だけを確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  createHostedFileServer,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
} from '../../../../src/backend/application/hosted-file-server/hosted-file-server.ts';
import { NULL_LOGGER } from '../../../../src/backend/application/ports/logger-port.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import {
  createHostedFileServerLambdaHandler,
  parseHostedFileServerEnv,
  type HostedFileHttpEvent,
} from '../../../../src/backend/runtime/hosted-file-server-lambda.ts';
import { createMemoryHostedFileStore } from '../../../support/memory-hosted-file-store.ts';

const READ_TOKEN = 'dummy-read-token';
const WRITE_TOKEN = 'dummy-write-token';
const PATH = '/robot/robot-a/latest.json';

function setup() {
  const store = createMemoryHostedFileStore(() => new Date('2026-11-25T01:02:03.000Z'));
  const server = createHostedFileServer({
    store,
    secrets: createMemorySecretPort({
      [HOSTED_FILE_READ_TOKEN_REFERENCE]: READ_TOKEN,
      [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: WRITE_TOKEN,
    }),
    logger: NULL_LOGGER,
  });
  return { store, handler: createHostedFileServerLambdaHandler(server) };
}

function event(
  overrides: Partial<HostedFileHttpEvent> & { method?: string } = {},
): HostedFileHttpEvent {
  const { method = 'GET', ...rest } = overrides;
  return {
    rawPath: PATH,
    requestContext: { http: { method } },
    headers: { authorization: `Bearer ${READ_TOKEN}` },
    ...rest,
  };
}

describe('Function URL のイベントの変換（createHostedFileServerLambdaHandler）', () => {
  it('PUT（本文は、そのまま）→ GET: 置いたファイルを、レスポンスの形式（statusCode・headers・body）で返す', async () => {
    const { handler } = setup();

    const put = await handler(
      event({
        method: 'PUT',
        headers: { authorization: `Bearer ${WRITE_TOKEN}` },
        body: '{"harvestCount":12}',
      }),
    );
    const get = await handler(event());

    expect(put).toMatchObject({ statusCode: 204, body: '' });
    expect(get).toMatchObject({
      statusCode: 200,
      body: '{"harvestCount":12}',
      headers: {
        'Content-Type': 'application/json',
        'Last-Modified': 'Wed, 25 Nov 2026 01:02:03 GMT',
      },
    });
  });

  it('PUT: isBase64Encoded の本文は、復号して置く（UTF-8 の日本語を含む JSON も、そのまま読める）', async () => {
    const { handler } = setup();
    const json = '{"name":"収穫ロボット"}';

    await handler(
      event({
        method: 'PUT',
        headers: { authorization: `Bearer ${WRITE_TOKEN}` },
        body: Buffer.from(json, 'utf8').toString('base64'),
        isBase64Encoded: true,
      }),
    );
    const get = await handler(event());

    expect(get.body).toBe(json);
  });

  it('HEAD は本文なし。Authorization ヘッダー名は、大文字・小文字を区別しない', async () => {
    const { store, handler } = setup();
    await store.put(PATH, '{"a":1}');

    const head = await handler(
      event({ method: 'HEAD', headers: { Authorization: `Bearer ${READ_TOKEN}` } }),
    );

    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('ヘッダーがないイベントは、エラーにせず、401（認証なし）にする', async () => {
    const { handler } = setup();

    const response = await handler({ rawPath: PATH, requestContext: { http: { method: 'GET' } } });

    expect(response.statusCode).toBe(401);
  });

  it('メソッド・パス・本文がないイベントは、エラーにせず、405・404・400 にする', async () => {
    const { handler } = setup();

    const noMethod = await handler({ rawPath: PATH, headers: {} });
    const noPath = await handler({
      requestContext: { http: { method: 'GET' } },
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    const noBody = await handler(
      event({ method: 'PUT', headers: { authorization: `Bearer ${WRITE_TOKEN}` } }),
    );

    expect(noMethod.statusCode).toBe(405);
    expect(noPath.statusCode).toBe(404);
    expect(noBody.statusCode).toBe(400);
  });
});

describe('環境変数の読み取り（parseHostedFileServerEnv）', () => {
  it('バケット名と、秘密情報のパスの接頭辞を読む（ログの水準は、任意）', () => {
    const config = parseHostedFileServerEnv({
      HOSTED_FILE_SERVER_BUCKET: 'dummy-bucket',
      CREDENTIAL_PATH_PREFIX: '/sfm/development/',
    });

    expect(config).toEqual({
      bucket: 'dummy-bucket',
      credentialPathPrefix: '/sfm/development/',
      logLevel: 'info',
    });
  });

  it('バケット名・接頭辞がない、または、形式が正しくないときは、エラー（起動しない）', () => {
    expect(() =>
      parseHostedFileServerEnv({ CREDENTIAL_PATH_PREFIX: '/sfm/development/' }),
    ).toThrow();
    expect(() => parseHostedFileServerEnv({ HOSTED_FILE_SERVER_BUCKET: 'dummy-bucket' })).toThrow();
    expect(() =>
      parseHostedFileServerEnv({
        HOSTED_FILE_SERVER_BUCKET: 'dummy-bucket',
        CREDENTIAL_PATH_PREFIX: 'sfm/development',
      }),
    ).toThrow();
  });
});
