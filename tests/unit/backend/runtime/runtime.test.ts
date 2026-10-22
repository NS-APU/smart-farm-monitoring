import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { NULL_LOGGER } from '../../../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../../../src/backend/infrastructure/local/ids.ts';
import { ConfigError, parseConfig } from '../../../../src/backend/runtime/config.ts';
import { createContainer } from '../../../../src/backend/runtime/container.ts';
import { createLambdaHandler } from '../../../../src/backend/runtime/lambda.ts';
import { startNodeServer } from '../../../../src/backend/runtime/node-server.ts';
import { TEST_NOW, TEST_USER } from '../../../support/test-constants.ts';

const ENV = {
  APP_MODE: 'test',
  // 開発用 API は、既定で無効（V-001）。このテストの組み立てでは、明示的に有効にする
  DEV_API_ENABLED: 'true',
  LOG_LEVEL: 'error',
  PORT: '0',
  FILE_SERVER_DIR: join(tmpdir(), 'smart-farm-runtime-test'),
  INITIAL_USER_ID: TEST_USER.userId,
  INITIAL_USER_NAME: TEST_USER.userName,
  INITIAL_USER_PASSWORD: TEST_USER.password,
};

describe('組み立て（コンポジションルート）', () => {
  it('初期化すると、ステータスコードの初期の定義と、最初のユーザーを用意する（冪等）', async () => {
    const container = createContainer(parseConfig(ENV), { logger: NULL_LOGGER });

    await container.initialize();
    await container.initialize();

    expect(await container.repositories.statusCodes.list()).toHaveLength(8);
    expect(await container.repositories.users.list()).toHaveLength(1);
  });

  it('初期ユーザーの指定がなければ、ユーザーを作らない', async () => {
    const container = createContainer(parseConfig({ APP_MODE: 'test' }), { logger: NULL_LOGGER });

    await container.initialize();

    expect(await container.repositories.users.list()).toEqual([]);
  });

  it('デモデータ（SEED_MODE=DEMO）で、設備・観測値・評価・通知を用意する。2回目は重複させない', async () => {
    const container = createContainer(parseConfig({ ...ENV, SEED_MODE: 'DEMO' }), {
      clock: createControllableClock(TEST_NOW),
      logger: NULL_LOGGER,
      ids: createSequentialIdGenerator(),
    });

    await container.initialize();
    await container.initialize();

    expect(await container.repositories.equipment.list()).toHaveLength(3);
    const dashboard = await container.dashboardQuery.get({
      equipmentId:
        (await container.repositories.equipment.list())[0]?.equipmentId ?? (undefined as never),
      horizon: 'LONG',
      periodDays: 7,
    });
    // 正常・注意（環境）・不明（満足度）が混在するデモ
    expect(dashboard.summary.NORMAL).toBeGreaterThan(0);
    expect(dashboard.summary.CAUTION).toBeGreaterThan(0);
    expect(dashboard.summary.UNKNOWN).toBeGreaterThan(0);
    expect(
      await container.repositories.notifications.unreadCount(toUserId(TEST_USER.userId)),
    ).toBeGreaterThan(0);
  });

  it('ファイル永続化: 終了時に書き出し、次の起動で読み込む', async () => {
    const dataFile = join(mkdtempSync(join(tmpdir(), 'smart-farm-runtime-')), 'store.json');
    const config = parseConfig({
      ...ENV,
      PERSISTENCE: 'file',
      DATA_FILE: dataFile,
      SEED_MODE: 'DEMO',
    });
    const first = createContainer(config, {
      clock: createControllableClock(TEST_NOW),
      logger: NULL_LOGGER,
    });
    await first.initialize();
    first.close();

    const second = createContainer(config, {
      clock: createControllableClock(TEST_NOW),
      logger: NULL_LOGGER,
    });

    expect(JSON.parse(readFileSync(dataFile, 'utf8'))).toMatchObject({ version: 1 });
    expect(await second.repositories.equipment.list()).toHaveLength(3);
    expect(await second.repositories.users.list()).toHaveLength(1);
  });

  it('ファイル永続化: 初期ユーザーのパスワードは、ハッシュ化して保存し、平文を保存ファイルに残さない', async () => {
    const dataFile = join(mkdtempSync(join(tmpdir(), 'smart-farm-runtime-')), 'store.json');
    const container = createContainer(
      parseConfig({ ...ENV, PERSISTENCE: 'file', DATA_FILE: dataFile }),
      {
        clock: createControllableClock(TEST_NOW),
        logger: NULL_LOGGER,
      },
    );
    await container.initialize();
    container.close();

    const saved = readFileSync(dataFile, 'utf8');

    expect(saved).not.toContain(TEST_USER.password);
    expect(saved).toContain('scrypt$');
  });

  it('開発用の操作（時計・モック・リセット）は、無効にでき、そのとき undefined になる', () => {
    const config = { ...parseConfig(ENV), devApiEnabled: false };

    expect(createContainer(config, { logger: NULL_LOGGER }).dev).toBeUndefined();
    expect(createContainer(parseConfig(ENV), { logger: NULL_LOGGER }).dev).toBeDefined();
  });

  it('開発用 API が無効なとき、時計はシステム時計で、時刻を操作できる実装を持たない（V-143）', () => {
    const config = parseConfig({ ...ENV, DEV_API_ENABLED: 'false' });

    const container = createContainer(config, { logger: NULL_LOGGER });

    expect(container.dev).toBeUndefined();
    expect('set' in container.clock).toBe(false);
    expect('freeze' in container.clock).toBe(false);
  });

  it('開発用 API を有効にした場合、起動時に警告のログを出す（V-001）', () => {
    const warnings: string[] = [];
    const logger = {
      ...NULL_LOGGER,
      warn: (message: string) => {
        warnings.push(message);
      },
    };

    createContainer(parseConfig(ENV), { logger });

    expect(warnings).toContain('開発用 API が有効です。本番・共有環境では無効にしてください');
  });

  it('動作設定を、上書きできる', () => {
    const container = createContainer(parseConfig(ENV), {
      logger: NULL_LOGGER,
      settings: { staleAfterIntervals: 10 },
    });

    expect(container.config.mode).toBe('test');
    expect(container.scheduler).toBeDefined();
  });
});

describe('Node サーバー（ローカル・E2E・負荷テスト）', () => {
  it('同じ Hono アプリを HTTP で提供し、ログインして API を呼び出せる。終了で止まる', async () => {
    const server = await startNodeServer(parseConfig(ENV), { logger: NULL_LOGGER });
    const base = `http://127.0.0.1:${String(server.port)}`;

    const health = await fetch(`${base}/health`);
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: TEST_USER.userId, password: TEST_USER.password }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const codes = await fetch(`${base}/api/v1/status-codes`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await server.close();

    expect(health.status).toBe(200);
    expect(login.status).toBe(200);
    expect(codes.status).toBe(200);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it('スケジューラを有効にすると、時間が来たジョブを実行する', async () => {
    const logs: string[] = [];
    const logger = {
      ...NULL_LOGGER,
      info: (message: string) => {
        logs.push(message);
      },
    };
    const server = await startNodeServer(
      parseConfig({ ...ENV, SCHEDULER_ENABLED: 'true', SCHEDULER_TICK_SECONDS: '1' }),
      { logger: { ...logger, child: () => logger } },
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('スケジューラが動きませんでした'));
      }, 5000);
      const poll = setInterval(() => {
        if (logs.includes('評価を実行しました')) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
    await server.close();

    expect(logs).toContain('評価を実行しました');
  });

  it('ポートがすでに使われていれば、起動に失敗する', async () => {
    const first = await startNodeServer(parseConfig(ENV), { logger: NULL_LOGGER });

    await expect(
      startNodeServer(parseConfig({ ...ENV, PORT: String(first.port) }), { logger: NULL_LOGGER }),
    ).rejects.toThrow();
    await first.close();
  });
});

describe('Lambda のハンドラ（関数の URL）', () => {
  function functionUrlEvent(method: string, path: string, body?: string, sourceIp = '192.0.2.10') {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: path,
      rawQueryString: '',
      headers: { host: 'example.invalid', 'content-type': 'application/json' },
      requestContext: {
        accountId: 'anonymous',
        apiId: 'dummy',
        authentication: null,
        authorizer: {},
        domainName: 'example.invalid',
        domainPrefix: 'example',
        http: { method, path, protocol: 'HTTP/1.1', sourceIp, userAgent: 'test' },
        requestId: 'dummy-request',
        routeKey: '$default',
        stage: '$default',
        time: '09/Oct/2026:03:00:00 +0000',
        timeEpoch: TEST_NOW.getTime(),
      },
      body: body ?? null,
      isBase64Encoded: false,
    };
  }

  it('同じアプリを、Lambda のイベントとして処理する（組み立ては最初の1回だけ）', async () => {
    const handler = createLambdaHandler({ ...ENV, APP_MODE: 'local', PERSISTENCE: 'memory' });

    const health = await handler(functionUrlEvent('GET', '/health'));
    const login = await handler(
      functionUrlEvent(
        'POST',
        '/api/v1/auth/login',
        JSON.stringify({ userId: TEST_USER.userId, password: 'wrong' }),
      ),
    );
    const second = await handler(functionUrlEvent('GET', '/health'));

    expect(health).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((health as { body: string }).body)).toMatchObject({ status: 'ok' });
    expect(login).toMatchObject({ statusCode: 401 });
    expect(second).toMatchObject({ statusCode: 200 });
  });

  it('本番（APP_MODE=production）で、Cognito の設定がなければ、設定エラーにする（ADR-0009）', async () => {
    const handler = createLambdaHandler({ APP_MODE: 'production', PERSISTENCE: 'dynamodb' });

    await expect(handler(functionUrlEvent('GET', '/health'))).rejects.toThrow(ConfigError);
  });

  it('SEED_MODE は、Lambda では使えない（起動のたびにデモデータを投入しない）', async () => {
    const handler = createLambdaHandler({ ...ENV, PERSISTENCE: 'memory', SEED_MODE: 'DEMO' });

    await expect(handler(functionUrlEvent('GET', '/health'))).rejects.toThrow('SEED_MODE');
  });

  it('APP_MODE・PERSISTENCE が未設定なら、既定（local・メモリ）で動かさず、設定エラーにする（V-002）', async () => {
    const missingBoth = createLambdaHandler({});
    const missingPersistence = createLambdaHandler({ APP_MODE: 'test' });

    await expect(missingBoth(functionUrlEvent('GET', '/health'))).rejects.toThrow('APP_MODE');
    await expect(missingPersistence(functionUrlEvent('GET', '/health'))).rejects.toThrow(
      'PERSISTENCE',
    );
  });

  it('ファイルの永続化は、読み取り専用のファイルシステム・複数の実行環境では使えないため、拒否する（V-133）', async () => {
    const handler = createLambdaHandler({ ...ENV, PERSISTENCE: 'file' });

    await expect(handler(functionUrlEvent('GET', '/health'))).rejects.toThrow('PERSISTENCE');
  });

  it('DEV_API_ENABLED=true と指定されても、Lambda では開発用 API を登録しない（V-001・V-002）', async () => {
    const handler = createLambdaHandler({ ...ENV, PERSISTENCE: 'memory', DEV_API_ENABLED: 'true' });

    const response = await handler(functionUrlEvent('GET', '/api/v1/dev/clock'));

    expect(response).toMatchObject({ statusCode: 404 });
  });

  it('ログインの試行回数の制限は、イベントの接続元（sourceIp）ごとに数え、X-Forwarded-For は信頼しない（V-007・V-008）', async () => {
    const handler = createLambdaHandler({ ...ENV, PERSISTENCE: 'memory' });
    const login = (password: string, sourceIp: string, forwardedFor: string) => {
      const event = functionUrlEvent(
        'POST',
        '/api/v1/auth/login',
        JSON.stringify({ userId: TEST_USER.userId, password }),
        sourceIp,
      );
      return handler({ ...event, headers: { ...event.headers, 'x-forwarded-for': forwardedFor } });
    };
    for (let count = 0; count < 5; count += 1) {
      await login('wrong', '192.0.2.20', `198.51.100.${String(count)}`);
    }

    const blocked = await login(TEST_USER.password, '192.0.2.20', '198.51.100.99');
    const otherClient = await login(TEST_USER.password, '192.0.2.21', '198.51.100.99');

    expect(blocked).toMatchObject({ statusCode: 429 });
    expect(otherClient).toMatchObject({ statusCode: 200 });
  });

  it('初期化が失敗しても、失敗を保持せず、次の呼び出しで再試行する（V-041）', async () => {
    let attempts = 0;
    const handler = createLambdaHandler(
      { ...ENV, PERSISTENCE: 'memory' },
      {
        createContainer: (config, overrides) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('一時的な初期化の失敗');
          }
          return createContainer(config, overrides);
        },
      },
    );

    await expect(handler(functionUrlEvent('GET', '/health'))).rejects.toThrow('一時的な初期化');
    const retried = await handler(functionUrlEvent('GET', '/health'));
    const third = await handler(functionUrlEvent('GET', '/health'));

    expect(retried).toMatchObject({ statusCode: 200 });
    expect(third).toMatchObject({ statusCode: 200 });
    expect(attempts).toBe(2);
  });

  it('初期化の非同期処理が失敗した場合も、次の呼び出しで再試行する（V-041）', async () => {
    let attempts = 0;
    const handler = createLambdaHandler(
      { ...ENV, PERSISTENCE: 'memory' },
      {
        createContainer: (config, overrides) => {
          attempts += 1;
          const container = createContainer(config, overrides);
          if (attempts === 1) {
            return {
              ...container,
              initialize: () => Promise.reject(new Error('一時的な初期化の失敗')),
            };
          }
          return container;
        },
      },
    );

    await expect(handler(functionUrlEvent('GET', '/health'))).rejects.toThrow('一時的な初期化');

    expect(await handler(functionUrlEvent('GET', '/health'))).toMatchObject({ statusCode: 200 });
  });
});
