import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { NotificationIdSchema, toUserId } from '@smart-farm/shared/schemas/common';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import { FileSourceUnavailableError } from '../../../../src/backend/application/ports/file-source-port.ts';
import { FormatError } from '../../../../src/backend/application/ports/format-profile.ts';
import {
  FederationRejectedError,
  FederationUnavailableError,
} from '../../../../src/backend/application/ports/federation-port.ts';
import { NotificationDeliveryError } from '../../../../src/backend/application/ports/notifier-port.ts';
import {
  createControllableClock,
  createSystemClock,
} from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createDummyWebPush } from '../../../../src/backend/infrastructure/local/dummy-web-push.ts';
import { createEnvSecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import { createFaultController } from '../../../../src/backend/infrastructure/local/faults.ts';
import {
  createSequentialIdGenerator,
  createUuidGenerator,
} from '../../../../src/backend/infrastructure/local/ids.ts';
import { ensureInitialUser } from '../../../../src/backend/infrastructure/local/initial-user.ts';
import {
  ACCESS_TOKEN_TTL_MINUTES,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
  createLocalAuth,
} from '../../../../src/backend/infrastructure/local/local-auth.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import { createMockFederation } from '../../../../src/backend/infrastructure/local/mock-federation.ts';
import { createDirectoryFileSource } from '../../../../src/backend/infrastructure/local/mock-file-server.ts';
import {
  hashPassword,
  verifyPassword,
} from '../../../../src/backend/infrastructure/local/password-hasher.ts';
import {
  buildDemoEquipment,
  createRandom,
  generateAutoObservations,
  generateManualObservations,
} from '../../../../src/backend/infrastructure/local/synthetic-data.ts';
import {
  createDeclarativeProfile,
  createDefaultFormatProfileRegistry,
  createFormatProfileRegistry,
} from '../../../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import {
  createJsonLogger,
  maskSensitiveFields,
} from '../../../../src/backend/infrastructure/logging/json-logger.ts';
import { FIXTURES_DIRECTORY } from '../../../support/fixtures-path.ts';
import { ROBOT_ID, SENSOR_ID } from '../../../support/builders.ts';
import { readFileSync } from 'node:fs';

const NOW = new Date('2026-10-09T03:00:00Z');

describe('時計', () => {
  it('システム時計は、現在時刻を返し、指定した時間だけ待つ', async () => {
    const clock = createSystemClock();
    const before = Date.now();

    await clock.sleep(5);

    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('固定した時計は、時刻が進まず、sleep は待たずに時刻だけを進める', async () => {
    const clock = createControllableClock(NOW);

    await clock.sleep(60_000);

    expect(clock.isFrozen()).toBe(true);
    expect(clock.now()).toEqual(new Date('2026-10-09T03:01:00Z'));
  });

  it('固定中は、時刻の設定・進行が、固定した時刻に反映される', () => {
    const clock = createControllableClock(NOW);

    clock.set(new Date('2026-12-31T00:00:00Z'));
    clock.advance(30 * 60_000);

    expect(clock.now()).toEqual(new Date('2026-12-31T00:30:00Z'));
  });

  it('日時を省略して固定すると、その時点の時刻で固定する', () => {
    const clock = createControllableClock();

    clock.freeze();
    const first = clock.now();

    expect(clock.now()).toEqual(first);
  });

  it('固定を解除すると、設定した時刻から実時間で進む', async () => {
    const clock = createControllableClock(NOW);

    clock.unfreeze();
    await clock.sleep(20);

    expect(clock.isFrozen()).toBe(false);
    expect(clock.now().getTime()).toBeGreaterThan(NOW.getTime() + 10);
    expect(clock.now().getTime()).toBeLessThan(NOW.getTime() + 5000);
  });

  it('固定していない時計に時刻を設定・進行すると、実時間との差として保持する', () => {
    const clock = createControllableClock();
    clock.unfreeze();

    clock.set(new Date('2030-01-01T00:00:00Z'));
    clock.advance(60_000);

    expect(
      Math.abs(clock.now().getTime() - new Date('2030-01-01T00:01:00Z').getTime()),
    ).toBeLessThan(2000);
  });

  it('固定の解除を、固定していない時計に行っても何も起きない', () => {
    const clock = createControllableClock();
    clock.unfreeze();

    expect(() => {
      clock.unfreeze();
    }).not.toThrow();
  });
});

describe('識別子の生成・秘密情報・停止の再現', () => {
  it('連番の識別子を作る', () => {
    const ids = createSequentialIdGenerator('x');

    expect([ids.next(), ids.next()]).toEqual(['x-000001', 'x-000002']);
    expect(createSequentialIdGenerator().next()).toBe('id-000001');
  });

  it('UUID の識別子は、毎回異なる', () => {
    const ids = createUuidGenerator();

    expect(ids.next()).not.toBe(ids.next());
  });

  it('秘密情報は、参照名に対応する環境変数 SECRET_<参照名> から読む', () => {
    const secrets = createEnvSecretPort({ SECRET_FILE_SERVER: 'dummy-secret' });

    expect(secrets.get('FILE_SERVER')).toBe('dummy-secret');
    expect(secrets.get('OTHER')).toBeUndefined();
  });

  it('停止・遅延の設定を、一部だけ変更できる', () => {
    const faults = createFaultController();

    expect(faults.get()).toEqual({ mode: 'UP', delayMs: 0 });
    expect(faults.set({ mode: 'SLOW' })).toEqual({ mode: 'SLOW', delayMs: 0 });
    expect(faults.set({ delayMs: 500 })).toEqual({ mode: 'SLOW', delayMs: 500 });
  });
});

describe('パスワードのハッシュ化', () => {
  it('同じパスワードでも、毎回異なるハッシュ（ソルト）になり、元のパスワードで検証できる', () => {
    const first = hashPassword('Dummy-Passw0rd');
    const second = hashPassword('Dummy-Passw0rd');

    expect(first).not.toBe(second);
    expect(first).not.toContain('Dummy-Passw0rd');
    expect(verifyPassword('Dummy-Passw0rd', first)).toBe(true);
    expect(verifyPassword('Dummy-Passw0rd2', first)).toBe(false);
  });

  it('形式が不正なハッシュは、検証に失敗する', () => {
    expect(verifyPassword('x', 'plain')).toBe(false);
    expect(verifyPassword('x', 'scrypt$00')).toBe(false);
    expect(verifyPassword('x', 'scrypt$00$00')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$00$00')).toBe(false);
  });
});

describe('最初のユーザーの作成', () => {
  const initial = {
    userId: 'first-user',
    userName: '最初のユーザー',
    password: 'Dummy-Passw0rd-1',
    role: 'worker',
  };

  it('ユーザーがいなければ作成し、パスワードはハッシュで保存する', async () => {
    const { repositories } = createLocalRepositories();

    const created = await ensureInitialUser(repositories.users, initial, NOW);

    expect(created).toBe(true);
    const user = await repositories.users.get(toUserId('first-user'));
    expect(user?.passwordHash).not.toContain('Dummy-Passw0rd-1');
    expect(verifyPassword('Dummy-Passw0rd-1', user?.passwordHash ?? '')).toBe(true);
  });

  it('すでにユーザーがいれば、何もしない（冪等。上書きしない）', async () => {
    const { repositories } = createLocalRepositories();
    await ensureInitialUser(repositories.users, initial, NOW);

    const created = await ensureInitialUser(
      repositories.users,
      { ...initial, password: 'Dummy-Passw0rd-2' },
      NOW,
    );

    expect(created).toBe(false);
    expect(
      verifyPassword(
        'Dummy-Passw0rd-1',
        (await repositories.users.get(toUserId('first-user')))?.passwordHash ?? '',
      ),
    ).toBe(true);
  });
});

describe('ローカルの認証（AuthPort）', () => {
  async function setup() {
    const { repositories } = createLocalRepositories();
    const clock = createControllableClock(NOW);
    await ensureInitialUser(
      repositories.users,
      { userId: 'user-a', userName: 'ユーザーA', password: 'Dummy-Passw0rd-a', role: 'worker' },
      NOW,
    );
    return { auth: createLocalAuth({ users: repositories.users, clock }), clock, repositories };
  }

  it('正しいユーザーIDとパスワードでログインでき、有効期限（アクセス30分・リフレッシュ7日）を返す', async () => {
    const { auth } = await setup();

    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );

    expect(session.principal).toEqual({ userId: 'user-a', userName: 'ユーザーA', role: 'worker' });
    expect(session.accessTokenExpiresAt.getTime() - NOW.getTime()).toBe(
      ACCESS_TOKEN_TTL_MINUTES * 60_000,
    );
    expect(session.refreshTokenExpiresAt.getTime() - NOW.getTime()).toBe(
      REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    );
    expect(await auth.verifyAccessToken(session.accessToken)).toEqual(session.principal);
  });

  it('ログインすると、最終ログイン日時を記録する', async () => {
    const { auth, repositories } = await setup();

    await auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1');

    expect((await repositories.users.get(toUserId('user-a')))?.lastLoginAt).toBe(NOW.toISOString());
  });

  it.each([
    ['パスワードが違う', 'user-a', 'wrong-Passw0rd'],
    ['ユーザーIDが存在しない', 'nobody', 'Dummy-Passw0rd-a'],
    ['ユーザーIDの形式が不正', '日本語', 'Dummy-Passw0rd-a'],
  ])('%s場合は、原因を特定できない同じメッセージで失敗する', async (_name, userId, password) => {
    const { auth } = await setup();

    await expect(auth.login({ userId, password }, 'client-1')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'ユーザーIDまたはパスワードが正しくありません',
    });
  });

  it(`同じ接続元からの失敗が${String(LOGIN_FAILURE_LIMIT)}回に達したら、正しい認証情報でも一時的に拒否する`, async () => {
    const { auth } = await setup();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await expect(
        auth.login({ userId: 'user-a', password: 'bad' }, 'client-1'),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }

    await expect(
      auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1'),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // 別の接続元は影響を受けない
    await expect(
      auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-2'),
    ).resolves.toBeDefined();
  });

  it(`制限の時間（${String(LOGIN_FAILURE_WINDOW_MINUTES)}分）が過ぎたら、再び試行できる`, async () => {
    const { auth, clock } = await setup();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await auth.login({ userId: 'user-a', password: 'bad' }, 'client-1').catch(() => undefined);
    }

    clock.advance(LOGIN_FAILURE_WINDOW_MINUTES * 60_000 + 1);

    await expect(
      auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1'),
    ).resolves.toBeDefined();
  });

  it('ログインに成功すると、失敗の回数をリセットする', async () => {
    const { auth } = await setup();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      await auth.login({ userId: 'user-a', password: 'bad' }, 'client-1').catch(() => undefined);
    }
    await auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1');

    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      await expect(
        auth.login({ userId: 'user-a', password: 'bad' }, 'client-1'),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('アクセストークンの有効期限が切れたら無効にする。不明なトークンも無効', async () => {
    const { auth, clock } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );

    expect(await auth.verifyAccessToken('unknown-token')).toBeNull();
    clock.advance(ACCESS_TOKEN_TTL_MINUTES * 60_000);

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it('追跡する接続元の数に上限があり、超えたら、最も古い接続元の失敗の記録を捨てる（キーの偽装によるメモリの消費を防ぐ。V-009）', async () => {
    const { repositories } = await setup();
    const clock = createControllableClock(NOW);
    const auth = createLocalAuth({ users: repositories.users, clock, maxTrackedClients: 2 });
    const fail = (clientKey: string) =>
      auth.login({ userId: 'user-a', password: 'bad' }, clientKey).catch(() => undefined);
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await fail('client-old');
    }
    await expect(
      auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-old'),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await fail('client-2');
    await fail('client-3');

    // client-old の記録は、上限を超えたため捨てられ、再び試行できる
    await expect(
      auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-old'),
    ).resolves.toBeDefined();
  });

  it('ユーザーのセッションを失効できる。keepAccessToken を指定したセッションだけを残す（V-005・V-006）', async () => {
    const { auth } = await setup();
    const login = () => auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1');
    const first = await login();
    const second = await login();

    await auth.revokeSessionsOf(toUserId('user-a'), { keepAccessToken: second.accessToken });

    expect(await auth.verifyAccessToken(first.accessToken)).toBeNull();
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(await auth.verifyAccessToken(second.accessToken)).not.toBeNull();

    await auth.revokeSessionsOf(toUserId('user-a'));

    expect(await auth.verifyAccessToken(second.accessToken)).toBeNull();
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('ほかのユーザーのセッションは、失効しない', async () => {
    const { auth, repositories } = await setup();
    await repositories.users.save({
      userId: toUserId('user-b'),
      userName: 'ユーザーB',
      role: 'worker',
      passwordHash: hashPassword('Dummy-Passw0rd-b'),
      createdAt: NOW.toISOString(),
    });
    const sessionB = await auth.login(
      { userId: 'user-b', password: 'Dummy-Passw0rd-b' },
      'client-1',
    );

    await auth.revokeSessionsOf(toUserId('user-a'));

    expect(await auth.verifyAccessToken(sessionB.accessToken)).not.toBeNull();
  });

  it('同じIDで再登録されたユーザー（作成日時が異なる）には、削除前のセッションを使えない', async () => {
    const { auth, repositories } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );
    const original = await repositories.users.get(toUserId('user-a'));
    await repositories.users.delete(toUserId('user-a'));
    await repositories.users.save({
      ...(original ?? (undefined as never)),
      createdAt: new Date(NOW.getTime() + 1000).toISOString(),
    });

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('期限切れのセッションは、新しいセッションの発行のときに掃除する', async () => {
    const { auth, clock } = await setup();
    const old = await auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1');
    clock.advance(REFRESH_TOKEN_TTL_DAYS * 86_400_000 + 1);

    await auth.login({ userId: 'user-a', password: 'Dummy-Passw0rd-a' }, 'client-1');

    await expect(auth.refresh(old.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('ログアウトすると、トークンが無効になる', async () => {
    const { auth } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );

    await auth.logout(session.accessToken);
    await auth.logout('unknown-token');

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('リフレッシュトークンで、新しいセッションを得る（古いトークンは使えなくなる）', async () => {
    const { auth, clock } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );
    clock.advance(ACCESS_TOKEN_TTL_MINUTES * 60_000 + 1000);

    const renewed = await auth.refresh(session.refreshToken);

    expect(await auth.verifyAccessToken(renewed.accessToken)).not.toBeNull();
    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    await expect(auth.refresh(session.refreshToken)).rejects.toBeInstanceOf(AppError);
  });

  it('アクセストークンが期限切れと判定された後も、リフレッシュトークンで、セッションを更新できる', async () => {
    const { auth, clock } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );
    clock.advance(ACCESS_TOKEN_TTL_MINUTES * 60_000 + 1000);
    // 期限切れのアクセストークンでの呼び出し（401）の後に、画面は、リフレッシュトークンで更新する
    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();

    const renewed = await auth.refresh(session.refreshToken);

    expect(await auth.verifyAccessToken(renewed.accessToken)).not.toBeNull();
  });

  it('リフレッシュトークンの有効期限が切れたら、再ログインを求める', async () => {
    const { auth, clock } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );
    clock.advance(REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(auth.refresh('unknown-token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('ユーザーが削除されたら、トークンもリフレッシュも使えなくなる', async () => {
    const { auth, repositories } = await setup();
    const session = await auth.login(
      { userId: 'user-a', password: 'Dummy-Passw0rd-a' },
      'client-1',
    );

    await repositories.users.delete(toUserId('user-a'));

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('ファイルサーバーのモック', () => {
  function setup() {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'smart-farm-fs-'));
    mkdirSync(join(rootDirectory, 'robot'));
    writeFileSync(join(rootDirectory, 'robot', 'b.json'), '{"b":1}');
    writeFileSync(join(rootDirectory, 'robot', 'a.json'), '{"a":1}');
    mkdirSync(join(rootDirectory, 'robot', 'subdir'));
    const faults = createFaultController();
    const clock = createControllableClock(NOW);
    return { source: createDirectoryFileSource({ rootDirectory, faults, clock }), faults, clock };
  }

  it('取り込み元のディレクトリのファイルを、更新日時・名前の順に一覧する（ディレクトリは除く）', async () => {
    const { source } = setup();

    const files = await source.listFiles('robot');

    expect(files.map((file) => file.fileId)).toEqual(expect.arrayContaining(['a.json', 'b.json']));
    expect(files).toHaveLength(2);
    expect(files[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('ディレクトリがない取り込み元は、空の一覧にする。接続テストは失敗する', async () => {
    const { source } = setup();

    expect(await source.listFiles('environment-sensor')).toEqual([]);
    await expect(source.testConnection('environment-sensor')).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    await expect(source.testConnection('robot')).resolves.toBeUndefined();
  });

  it('ファイルの内容を読める。存在しない・識別子が不正なファイルは読めない', async () => {
    const { source } = setup();

    expect(await source.readFile('robot', 'a.json')).toBe('{"a":1}');
    await expect(source.readFile('robot', 'none.json')).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    await expect(source.readFile('robot', '../x.json')).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
  });

  it('取り込み元の識別子で、ルートの外へ出られない', async () => {
    const { source } = setup();

    await expect(source.listFiles('../etc')).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await expect(source.listFiles('Robot')).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('停止（DOWN）を再現すると、すべての操作が接続できないエラーになる', async () => {
    const { source, faults } = setup();
    faults.set({ mode: 'DOWN' });

    await expect(source.listFiles('robot')).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await expect(source.readFile('robot', 'a.json')).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    await expect(source.testConnection('robot')).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('遅延（SLOW）を再現すると、指定した時間の経過後に応答する', async () => {
    const { source, faults, clock } = setup();
    faults.set({ mode: 'SLOW', delayMs: 5000 });

    await source.listFiles('robot');

    expect(clock.now()).toEqual(new Date(NOW.getTime() + 5000));
  });
});

describe('農業情報基盤のモック', () => {
  const item: FederationItem = {
    federationItemId: 'f-1',
    targetType: 'EVALUATION',
    targetRef: 'x',
    payload: {},
    status: 'PENDING',
    attempts: 0,
    enqueuedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    nextAttemptAt: NOW.toISOString(),
  };

  it('受け取った項目を記録する。リセットで消える', async () => {
    const faults = createFaultController();
    const federation = createMockFederation({ faults, clock: createControllableClock(NOW) });

    await federation.send([item]);

    expect(federation.received()).toEqual([item]);
    federation.reset();
    expect(federation.received()).toEqual([]);
  });

  it('停止中は連携先が利用できないエラー、拒否中は受け付けないエラーになり、記録しない', async () => {
    const faults = createFaultController();
    const federation = createMockFederation({ faults, clock: createControllableClock(NOW) });

    faults.set({ mode: 'DOWN' });
    await expect(federation.send([item])).rejects.toBeInstanceOf(FederationUnavailableError);
    faults.set({ mode: 'REJECT' });
    await expect(federation.send([item])).rejects.toBeInstanceOf(FederationRejectedError);

    expect(federation.received()).toEqual([]);
  });

  it('遅延中は、指定した時間の経過後に受け取る', async () => {
    const faults = createFaultController({ mode: 'SLOW', delayMs: 3000 });
    const clock = createControllableClock(NOW);
    const federation = createMockFederation({ faults, clock });

    await federation.send([item]);

    expect(clock.now()).toEqual(new Date(NOW.getTime() + 3000));
    expect(federation.received()).toHaveLength(1);
  });
});

describe('Web Push のダミー', () => {
  const notification: Notification = {
    notificationId: NotificationIdSchema.parse('n-1'),
    kind: 'STATUS_CHANGE',
    message: 'm',
    createdAt: NOW.toISOString(),
    dedupKey: 'k',
    deliveries: [],
  };
  const subscription = {
    subscriptionId: 's-1',
    userId: toUserId('u-1'),
    endpoint: 'https://push.invalid/1',
    isActive: true,
    createdAt: NOW.toISOString(),
  };

  it('配信した内容を記録する。リセットで消える', async () => {
    const push = createDummyWebPush({ faults: createFaultController() });

    expect(await push.deliver(notification, subscription)).toBe('DELIVERED');

    expect(push.delivered()).toEqual([{ notificationId: 'n-1', subscriptionId: 's-1' }]);
    push.reset();
    expect(push.delivered()).toEqual([]);
  });

  it('停止中は配信に失敗し、拒否中は購読が無効（解除・期限切れ）として扱う', async () => {
    const faults = createFaultController();
    const push = createDummyWebPush({ faults });

    faults.set({ mode: 'DOWN' });
    await expect(push.deliver(notification, subscription)).rejects.toBeInstanceOf(
      NotificationDeliveryError,
    );
    faults.set({ mode: 'REJECT' });

    expect(await push.deliver(notification, subscription)).toBe('SUBSCRIPTION_GONE');
    expect(push.delivered()).toEqual([]);
  });
});

describe('FormatProfile（仮決めのロボット JSON・環境センサー CSV）', () => {
  const registry = createDefaultFormatProfileRegistry();
  const robot = registry.get('robot-json');
  const sensor = registry.get('environment-sensor-csv');
  if (robot === undefined || sensor === undefined) {
    throw new Error('テストの前提: 仮決めの FormatProfile がある');
  }
  const fixture = (path: string) =>
    readFileSync(join(FIXTURES_DIRECTORY, 'file-server', path), 'utf8');

  it('版と状態（仮決め）を持ち、解釈に使った版の表記を作る', () => {
    expect(robot).toMatchObject({
      profileId: 'robot-json',
      version: '0.1.0',
      status: 'PROVISIONAL',
      versionLabel: 'robot-json@0.1.0(PROVISIONAL)',
    });
    expect(registry.get('none')).toBeUndefined();
  });

  it('ロボットデータ（JSON）を、記録ごとに、項目の識別子へ対応づけて読む', () => {
    const parsed = robot.parse(fixture('robot/robot-sample-001.json'));

    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      externalId: 'ROBOT-SAMPLE-01',
      observedAt: '2026-10-09T01:00:00Z',
      fields: { harvestCount: 12, statusCode: 'HARVESTING', operatingHours: 0.25 },
    });
  });

  it('JSON の記録に計測日時がなければ、その記録を読み取れなかった数に数える。値のない項目は含めない', () => {
    const parsed = robot.parse(fixture('robot/robot-sample-002-partial.json'));

    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.records).toHaveLength(3);
    expect(parsed.records[2]?.fields).toEqual({ harvestCount: null, operatingHours: 0.25 });
  });

  it.each([
    ['JSON として読み取れない', fixture('robot/robot-sample-003-broken.json')],
    ['記録の配列がない', '{"robotId":"R","other":[]}'],
    ['設備の識別子がない', '{"records":[]}'],
    ['設備の識別子が空', '{"robotId":"","records":[]}'],
    ['トップが配列', '[]'],
  ])('ロボットデータ: %s ファイルは、形式違いとして扱う', (_name, content) => {
    expect(() => robot.parse(content)).toThrow(FormatError);
  });

  it('JSON の記録がオブジェクトでなければ、読み取れなかった数に数える', () => {
    const parsed = robot.parse('{"robotId":"R","records":[1,"a",null]}');

    expect(parsed).toEqual({ records: [], rejectedCount: 3 });
  });

  it('環境センサー（CSV）を読み、空の値は欠損（null）、数値は数値に変換する', () => {
    const parsed = sensor.parse(fixture('environment-sensor/sensor-sample-001.csv'));

    expect(parsed.records).toHaveLength(3);
    expect(parsed.records[0]).toMatchObject({
      externalId: 'SENSOR-SAMPLE-01',
      observedAt: '2026-10-09T01:00:00Z',
      fields: { temperatureCelsius: 21.5, humidityPercent: 58, illuminanceLux: 30000, co2Ppm: 880 },
    });
    expect(parsed.records[2]?.fields.temperatureCelsius).toBeNull();
  });

  it('CSV の数値でない値は、そのまま渡し（検証で不正にする）、列の数が合わない行は読み取れなかった数に数える', () => {
    const parsed = sensor.parse(fixture('environment-sensor/sensor-sample-002-invalid.csv'));

    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.records[0]?.fields.temperatureCelsius).toBe('abc');
  });

  it.each([
    ['見出し行がない', ''],
    ['見出しが仕様と異なる', fixture('environment-sensor/sensor-sample-003-bad-header.csv')],
  ])('環境センサー: %s ファイルは、形式違いとして扱う', (_name, content) => {
    expect(() => sensor.parse(content)).toThrow(FormatError);
  });

  it('CSV の項目が見出しにない場合は、その項目を含めない', () => {
    const parsed = sensor.parse('sensor_id,timestamp,temperature_c\nS,2026-10-09T01:00:00Z,20\n');

    expect(parsed.records[0]?.fields).toEqual({ temperatureCelsius: 20 });
  });

  describe('計測日時の解釈（V-020）', () => {
    const jsonWith = (timestamp: unknown) =>
      JSON.stringify({ robotId: 'R', records: [{ timestamp, harvestCount: 1 }] });
    const observedAtOf = (timestamp: string) =>
      robot.parse(jsonWith(timestamp)).records[0]?.observedAt;

    it.each([
      [
        'タイムゾーンのない日時（T 区切り）は、日本時間として',
        '2026-10-09T10:00:00',
        '2026-10-09T01:00:00.000Z',
      ],
      [
        'タイムゾーンのない日時（空白区切り）は、日本時間として',
        '2026-10-09 10:00:00',
        '2026-10-09T01:00:00.000Z',
      ],
      ['秒のない日時も', '2026-10-09T10:00', '2026-10-09T01:00:00.000Z'],
      ['小数秒つきも', '2026-10-09T10:00:00.5', '2026-10-09T01:00:00.500Z'],
      ['日付をまたぐ変換も', '2026-10-09T08:30:00', '2026-10-08T23:30:00.000Z'],
      ['Z つきは、そのまま', '2026-10-09T01:00:00Z', '2026-10-09T01:00:00Z'],
      [
        'オフセットつきは、そのまま（空白区切りは T にする）',
        '2026-10-09 10:00:00+09:00',
        '2026-10-09T10:00:00+09:00',
      ],
    ])('%s解釈する', (_name, text, expected) => {
      expect(observedAtOf(text)).toBe(expected);
    });

    it.each([
      ['ISO 8601 以外の形式', 'Oct 9 2026 10:00'],
      ['日付のみ', '2026-10-09'],
      ['存在しない日付', '2026-02-31T10:00:00'],
      ['25時', '2026-10-09T25:00:00'],
      ['数値（エポック）', '1760000000'],
      ['オフセットの書式が不正', '2026-10-09T10:00:00+0900'],
    ])('%sの日時は、読み取れなかった記録として数える', (_name, text) => {
      const parsed = robot.parse(jsonWith(text));

      expect(parsed).toEqual({ records: [], rejectedCount: 1 });
    });

    it('タイムゾーンのない日時の解釈は、実行環境のタイムゾーン（TZ）に依存しない', () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = 'UTC';
        const underUtc = observedAtOf('2026-10-09T10:00:00');
        process.env.TZ = 'America/Los_Angeles';
        const underLosAngeles = observedAtOf('2026-10-09T10:00:00');

        expect(underUtc).toBe('2026-10-09T01:00:00.000Z');
        expect(underLosAngeles).toBe(underUtc);
      } finally {
        if (original === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = original;
        }
      }
    });

    it('プロファイルの utcOffsetMinutes で、解釈するタイムゾーンを変えられる。CSV も同じ', () => {
      const utcProfile = createDeclarativeProfile({
        profileId: 'utc-json',
        version: '1',
        status: 'PROVISIONAL',
        format: 'JSON',
        basis: 'テスト',
        utcOffsetMinutes: 0,
        layout: { recordsPath: 'records', equipmentIdPath: 'robotId', timestampField: 'timestamp' },
        fields: [{ source: 'harvestCount', itemKey: 'harvestCount' }],
      });

      expect(utcProfile.parse(jsonWith('2026-10-09T10:00:00')).records[0]?.observedAt).toBe(
        '2026-10-09T10:00:00.000Z',
      );
      expect(
        sensor.parse('sensor_id,timestamp,temperature_c\nS,2026-10-09 10:00:00,20\n').records[0]
          ?.observedAt,
      ).toBe('2026-10-09T01:00:00.000Z');
      expect(
        sensor.parse('sensor_id,timestamp,temperature_c\nS,10/09/2026,20\n').rejectedCount,
      ).toBe(1);
    });
  });

  describe('構造の変更の検出（V-019）', () => {
    it('JSON: すべての記録で、設定した項目が1つも読み取れなければ、形式違いにする', () => {
      const content = JSON.stringify({
        robotId: 'R',
        records: [{ timestamp: '2026-10-09T01:00:00Z', harvest_total: 3 }],
      });

      expect(() => robot.parse(content)).toThrow(FormatError);
    });

    it('JSON: 一部の項目だけがある記録は、読める。記録がなければ（空のファイル）、形式違いにしない', () => {
      const partial = robot.parse(
        JSON.stringify({
          robotId: 'R',
          records: [{ timestamp: '2026-10-09T01:00:00Z', statusCode: null }],
        }),
      );

      expect(partial.records).toHaveLength(1);
      expect(robot.parse('{"robotId":"R","records":[]}')).toEqual({
        records: [],
        rejectedCount: 0,
      });
    });

    it('CSV: 設定した項目の列が、見出しに1つもなければ、行がなくても、形式違いにする', () => {
      expect(() => sensor.parse('sensor_id,timestamp,temp,humid\n')).toThrow(FormatError);
      expect(() =>
        sensor.parse('sensor_id,timestamp,temp,humid\nS,2026-10-09T01:00:00Z,20,50\n'),
      ).toThrow('見出し');
    });
  });

  it('設定が不正な FormatProfile は作れない', () => {
    expect(() => createDeclarativeProfile({ profileId: 'x' })).toThrow();
  });

  it('設定から FormatProfile の一覧を作り、識別子で引ける', () => {
    expect(createFormatProfileRegistry([robot]).get('robot-json')).toBe(robot);
  });
});

describe('構造化ログ', () => {
  function capture() {
    const lines: string[] = [];
    return {
      lines,
      sink: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    };
  }

  it('1行1イベントの JSON で、時刻・レベル・メッセージ・項目を出力する', () => {
    const { lines, sink } = capture();
    const logger = createJsonLogger({ sink, now: () => NOW });

    logger.info('開始', { jobId: 'JB-01' });

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: NOW.toISOString(),
      level: 'info',
      message: '開始',
      jobId: 'JB-01',
    });
    expect(lines[0]?.endsWith('\n')).toBe(true);
  });

  it('最小のレベルより低いレベルは、出力しない', () => {
    const { lines, sink } = capture();
    const logger = createJsonLogger({ sink, minimumLevel: 'warn' });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('デバッグのレベルも出力できる', () => {
    const { lines, sink } = capture();

    createJsonLogger({ sink, minimumLevel: 'debug' }).debug('d');

    expect(lines).toHaveLength(1);
  });

  it('子ロガーは、固定の項目を引き継ぐ', () => {
    const { lines, sink } = capture();
    const logger = createJsonLogger({ sink }).child({ requestId: 'r-1' });

    logger.info('x', { extra: 1 });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ requestId: 'r-1', extra: 1 });
  });

  it('パスワード・トークンなど秘密情報らしい名前の項目は、値をマスクする', () => {
    expect(
      maskSensitiveFields({
        password: 'p',
        accessToken: 't',
        Authorization: 'a',
        apiKey: 'k',
        userId: 'u',
      }),
    ).toEqual({
      password: '[MASKED]',
      accessToken: '[MASKED]',
      Authorization: '[MASKED]',
      apiKey: '[MASKED]',
      userId: 'u',
    });
  });

  it('標準出力へ書くシンクで、1行を出力する', async () => {
    const { STDOUT_SINK } =
      await import('../../../../src/backend/infrastructure/logging/json-logger.ts');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    STDOUT_SINK.write('line\n');

    expect(write).toHaveBeenCalledWith('line\n');
    write.mockRestore();
  });
});

describe('合成データの生成', () => {
  it('同じ種からは、同じデータになる（再現性）', () => {
    const first = createRandom(1);
    const second = createRandom(1);

    expect([first(), first()]).toEqual([second(), second()]);
    expect(createRandom(2)()).not.toBe(createRandom(1)());
  });

  it('自動取り込み相当のデータを、間隔ごとにロボット6項目・センサー4項目で作る', () => {
    const observations = generateAutoObservations({
      robotId: ROBOT_ID,
      sensorId: SENSOR_ID,
      from: NOW,
      to: new Date(NOW.getTime() + 30 * 60_000),
      intervalMinutes: 15,
      seed: 1,
    });

    expect(observations).toHaveLength(3 * 10);
    expect(
      observations.every((item) => item.source === 'AUTO_IMPORT' && item.quality === 'VALID'),
    ).toBe(true);
    expect(observations.filter((item) => item.equipmentId === SENSOR_ID)).toHaveLength(12);
  });

  it('温度の基準を指定でき、手動入力相当のデータは入力者を持てる', () => {
    const hot = generateAutoObservations({
      robotId: ROBOT_ID,
      sensorId: SENSOR_ID,
      from: NOW,
      to: NOW,
      intervalMinutes: 15,
      seed: 1,
      temperatureBaseCelsius: 40,
    });
    const manual = generateManualObservations({
      robotId: ROBOT_ID,
      at: NOW,
      enteredBy: toUserId('user-1'),
    });
    const anonymous = generateManualObservations({
      robotId: ROBOT_ID,
      at: NOW,
      enteredBy: undefined,
    });

    expect(
      Number(hot.find((item) => item.itemKey === 'temperatureCelsius')?.value),
    ).toBeGreaterThanOrEqual(40);
    expect(manual.every((item) => item.source === 'MANUAL' && item.enteredBy === 'user-1')).toBe(
      true,
    );
    expect(anonymous.every((item) => item.enteredBy === undefined)).toBe(true);
  });

  it('デモの設備は、ハウス1・ロボット1・センサー1の階層', () => {
    const equipment = buildDemoEquipment(NOW);

    expect(equipment.map((item) => [item.equipmentType, item.facilityId])).toEqual([
      ['FACILITY', undefined],
      ['ROBOT', 'HOUSE-01'],
      ['SENSOR', 'HOUSE-01'],
    ]);
  });
});
