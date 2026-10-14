/**
 * テスト用の組み立て。時計を固定し、識別子を連番にし、ログを出力せず、メモリ上のデータで動かす。
 * 認証情報は、明らかにダミーとわかる値（実際の認証情報ではない）。
 */

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { NULL_LOGGER, type Logger } from '../../src/backend/application/ports/logger-port.ts';
import {
  createControllableClock,
  type ControllableClock,
} from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { hashPassword } from '../../src/backend/infrastructure/local/password-hasher.ts';
import { ErrorResponseSchema } from '../../src/shared/schemas/api.ts';
import { LoginResponseSchema } from '../../src/shared/schemas/auth.ts';
import { toUserId } from '../../src/shared/schemas/common.ts';
import { createApp } from '../../src/backend/presentation/create-app.ts';
import type { AppEnv } from '../../src/backend/presentation/api-deps.ts';
import { parseConfig, type AppConfig } from '../../src/backend/runtime/config.ts';
import { createContainer, type Container } from '../../src/backend/runtime/container.ts';
import { equipmentSet } from './builders.ts';
import { FIXTURES_DIRECTORY } from './fixtures-path.ts';
import { TEST_NOW, TEST_USER } from './test-constants.ts';

// 他のテストが、これまでどおり test-context.ts から import できるようにする
export { TEST_NOW, TEST_USER };

export interface TestContext {
  readonly container: Container;
  readonly app: Hono<AppEnv>;
  readonly clock: ControllableClock;
  readonly config: AppConfig;
  /** モックのファイルサーバーのルート（テストごとの一時ディレクトリ）。 */
  readonly fileServerDirectory: string;
  /** ログインして、アクセストークンを返す。 */
  login(): Promise<string>;
  /** 認証つきでリクエストする。 */
  request(
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<Response>;
  /** 合成データのフィクスチャを、モックのファイルサーバーに置く。 */
  placeFixture(sourceId: string, fixtureRelativePath: string, asName?: string): void;
  /** 任意の内容のファイルを、モックのファイルサーバーに置く。 */
  placeFile(sourceId: string, name: string, content: string): void;
}

export interface TestContextOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: Date;
  /** ログの出力先（ログに秘密情報が含まれないことの検証用）。省略すると、何も出力しない。 */
  readonly logger?: Logger;
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const fileServerDirectory = mkdtempSync(join(tmpdir(), 'smart-farm-test-'));
  const config = parseConfig({
    APP_MODE: 'test',
    PERSISTENCE: 'memory',
    FILE_SERVER_DIR: fileServerDirectory,
    INITIAL_USER_ID: TEST_USER.userId,
    INITIAL_USER_NAME: TEST_USER.userName,
    INITIAL_USER_PASSWORD: TEST_USER.password,
    INGESTION_RETRY_BASE_DELAY_MS: '1000',
    // 開発用 API は、既定で無効（V-001）。テストの組み立てでは、明示的に有効にする
    DEV_API_ENABLED: 'true',
    ...options.env,
  });
  const clock = createControllableClock(options.now ?? TEST_NOW);
  const container = createContainer(config, {
    clock,
    ids: createSequentialIdGenerator('test'),
    logger: options.logger ?? NULL_LOGGER,
  });
  await container.initialize();
  const app = createApp(container);

  const context: TestContext = {
    container,
    app,
    clock,
    config,
    fileServerDirectory,
    async login() {
      const response = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: TEST_USER.userId, password: TEST_USER.password }),
      });
      return LoginResponseSchema.parse(await response.json()).accessToken;
    },
    async request(path, requestOptions = {}) {
      const token = requestOptions.token ?? (await context.login());
      return app.request(`/api/v1${path}`, {
        method: requestOptions.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...requestOptions.headers,
        },
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      });
    },
    placeFixture(sourceId, fixtureRelativePath, asName) {
      const directory = join(fileServerDirectory, sourceId);
      mkdirSync(directory, { recursive: true });
      const name = asName ?? fixtureRelativePath.split('/').at(-1) ?? fixtureRelativePath;
      cpSync(join(FIXTURES_DIRECTORY, 'file-server', fixtureRelativePath), join(directory, name));
    },
    placeFile(sourceId, name, content) {
      const directory = join(fileServerDirectory, sourceId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, name), content, 'utf8');
    },
  };
  return context;
}

/** 設備の一式（ハウス・ロボット・センサー。`equipmentSet()`）を登録したテストの組み立て。 */
export async function withEquipment(options: TestContextOptions = {}): Promise<TestContext> {
  const context = await createTestContext(options);
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

/**
 * 評価の要求を出した直後に呼び、その評価が「始まる」（待機中でなくなる）まで待つ。
 * 評価は、開始の直前に `setImmediate` で1回、イベントループへ制御を戻す。タイマー（`setTimeout`）の待ちでは、実行環境の負荷によって、
 * タイマーが `setImmediate` より先に動くことがあり、順序が不定になる。ここでは、`setImmediate` を2回待つことで、順序を決める。
 */
export async function untilEvaluationStarted(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** エラー応答（共通形式）の本文を、スキーマで検証して取り出す。 */
export async function errorOf(response: Response) {
  return ErrorResponseSchema.parse(await response.json()).error;
}

/** ユーザーを追加して、ログインし、アクセストークンを返す（ロールごとの認可の検証用）。 */
export async function addUserAndLogin(
  context: TestContext,
  user: { userId: string; role: string; password?: string },
): Promise<string> {
  const password = user.password ?? 'Dummy-Passw0rd-extra';
  await context.container.repositories.users.save({
    userId: toUserId(user.userId),
    userName: user.userId,
    role: user.role,
    passwordHash: hashPassword(password),
    createdAt: TEST_NOW.toISOString(),
  });
  const response = await context.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.userId, password }),
  });
  return LoginResponseSchema.parse(await response.json()).accessToken;
}

/** 3ロール（管理者・評価者・閲覧者）の設定の例。ロールの分け方は未確定（Q-017）のため、設定で切り替える。 */
export const THREE_ROLES_JSON = JSON.stringify({
  admin: {
    name: '管理者',
    permissions: [
      'equipment:manage',
      'ingestion:configure',
      'ingestion:run',
      'status-code:manage',
      'manual-entry:write',
      'criteria:edit',
      'user:manage',
      'audit:read',
    ],
  },
  evaluator: {
    name: '評価者',
    permissions: ['manual-entry:write', 'criteria:edit', 'ingestion:run', 'audit:read'],
  },
  viewer: { name: '閲覧者', permissions: [] },
});
