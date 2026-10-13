import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../../../src/backend/runtime/config.ts';

const INITIAL_USER = {
  INITIAL_USER_ID: 'first-user',
  INITIAL_USER_NAME: '最初のユーザー',
  INITIAL_USER_PASSWORD: 'Dummy-Passw0rd-1',
};

describe('実行設定（環境変数）', () => {
  it('何も指定しなければ、ローカルの既定値になる（メモリ上のデータ、初期ユーザーなし、スケジューラ無効）', () => {
    const config = parseConfig({});

    expect(config).toMatchObject({
      mode: 'local',
      host: '127.0.0.1',
      port: 8787,
      persistence: 'memory',
      seedMode: 'NONE',
      schedulerEnabled: false,
      defaultIngestionIntervalMinutes: 15,
      staleAfterIntervals: 3,
      logLevel: 'info',
      devApiEnabled: false,
      trustedProxyHops: 0,
    });
    expect(config.initialUser).toBeUndefined();
    expect(Object.keys(config.roles)).toEqual(['worker']);
  });

  it('指定した値を読み込む', () => {
    const config = parseConfig({
      APP_MODE: 'test',
      PORT: '9000',
      PERSISTENCE: 'file',
      DATA_FILE: 'x/store.json',
      FILE_SERVER_DIR: 'x/fs',
      SEED_MODE: 'DEMO',
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_TICK_SECONDS: '5',
      LOG_LEVEL: 'debug',
      DEFAULT_INGESTION_INTERVAL_MINUTES: '30',
      STALE_AFTER_INTERVALS: '2',
      INGESTION_RETRY_BASE_DELAY_MS: '0',
    });

    expect(config).toMatchObject({
      mode: 'test',
      port: 9000,
      persistence: 'file',
      dataFile: 'x/store.json',
      fileServerDirectory: 'x/fs',
      seedMode: 'DEMO',
      schedulerEnabled: true,
      schedulerTickSeconds: 5,
      logLevel: 'debug',
      defaultIngestionIntervalMinutes: 30,
      staleAfterIntervals: 2,
      ingestionRetryBaseDelayMs: 0,
    });
  });

  it('本番では、開発用 API を無効にする', () => {
    expect(parseConfig({ APP_MODE: 'production' }).devApiEnabled).toBe(false);
  });

  describe('開発用 API の有効化（V-001）', () => {
    it('DEV_API_ENABLED=true と明示したときだけ有効にする（ローカル・テスト）', () => {
      expect(parseConfig({ APP_MODE: 'local' }).devApiEnabled).toBe(false);
      expect(parseConfig({ APP_MODE: 'test' }).devApiEnabled).toBe(false);
      expect(parseConfig({ APP_MODE: 'local', DEV_API_ENABLED: 'true' }).devApiEnabled).toBe(true);
      expect(parseConfig({ APP_MODE: 'test', DEV_API_ENABLED: 'true' }).devApiEnabled).toBe(true);
      expect(parseConfig({ APP_MODE: 'test', DEV_API_ENABLED: 'false' }).devApiEnabled).toBe(false);
    });

    it('本番では、DEV_API_ENABLED=true でも、強制的に無効にする', () => {
      expect(parseConfig({ APP_MODE: 'production', DEV_API_ENABLED: 'true' }).devApiEnabled).toBe(
        false,
      );
    });

    it('真偽値でない指定は、設定エラーにする', () => {
      expect(() => parseConfig({ DEV_API_ENABLED: 'yes' })).toThrow('DEV_API_ENABLED');
    });
  });

  describe('信頼するプロキシの段数（V-007）', () => {
    it('既定は 0（X-Forwarded-For を信頼しない）。指定した段数を読み込む', () => {
      expect(parseConfig({}).trustedProxyHops).toBe(0);
      expect(parseConfig({ TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
    });

    it.each(['-1', '11', 'abc', '1.5'])('範囲外・不正な値（%s）は、設定エラーにする', (value) => {
      expect(() => parseConfig({ TRUSTED_PROXY_HOPS: value })).toThrow('TRUSTED_PROXY_HOPS');
    });
  });

  it.each([
    ['PORT', { PORT: 'abc' }],
    ['PORT', { PORT: '70000' }],
    ['APP_MODE', { APP_MODE: 'staging' }],
    ['DEFAULT_INGESTION_INTERVAL_MINUTES', { DEFAULT_INGESTION_INTERVAL_MINUTES: '7' }],
    ['SCHEDULER_ENABLED', { SCHEDULER_ENABLED: 'yes' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
  ])('%s が不正なら、設定エラーにして、変数名だけを示す（値は示さない）', (name, env) => {
    expect.assertions(3);

    try {
      parseConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(Object.values(env)[0]);
    }
  });

  describe('最初のユーザー（環境変数の初期ユーザー）', () => {
    it('3つの変数がそろっていれば、既定のロールで読み込む', () => {
      expect(parseConfig(INITIAL_USER).initialUser).toEqual({
        userId: 'first-user',
        userName: '最初のユーザー',
        password: 'Dummy-Passw0rd-1',
        role: 'worker',
      });
    });

    it('一部だけの指定は、設定エラーにする', () => {
      expect(() => parseConfig({ INITIAL_USER_ID: 'a' })).toThrow('すべて指定してください');
    });

    it('ユーザーIDの形式・パスワードの条件を満たさなければ、設定エラーにする', () => {
      expect(() => parseConfig({ ...INITIAL_USER, INITIAL_USER_ID: '日本語' })).toThrow(
        'INITIAL_USER_ID',
      );
      expect(() => parseConfig({ ...INITIAL_USER, INITIAL_USER_PASSWORD: 'weak' })).toThrow(
        'パスワードの条件',
      );
    });
  });

  describe('ロール定義（設定でロールと権限を割り当てる）', () => {
    const roles = JSON.stringify({
      admin: { name: '管理者', permissions: ['user:manage'] },
      viewer: { name: '閲覧者', permissions: [] },
    });

    it('JSON で、ロールごとの権限を指定できる', () => {
      expect(parseConfig({ ROLE_DEFINITIONS_JSON: roles }).roles).toEqual({
        admin: { name: '管理者', permissions: ['user:manage'] },
        viewer: { name: '閲覧者', permissions: [] },
      });
    });

    it('初期ユーザーのロールは、指定がなければ最初のロール。指定すれば、そのロール', () => {
      expect(parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: roles }).initialUser?.role).toBe(
        'admin',
      );
      expect(
        parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: roles, INITIAL_USER_ROLE: 'viewer' })
          .initialUser?.role,
      ).toBe('viewer');
    });

    it.each([
      ['JSON として読み取れない', 'not json'],
      ['権限の名前が不正', JSON.stringify({ admin: { name: 'x', permissions: ['everything'] } })],
      ['名称がない', JSON.stringify({ admin: { permissions: [] } })],
    ])('%s ロール定義は、設定エラーにする', (_name, value) => {
      expect(() => parseConfig({ ROLE_DEFINITIONS_JSON: value })).toThrow(ConfigError);
    });

    it('初期ユーザーのロールの既定は、ユーザー管理の権限を持つ最初のロール（記述の順序で、管理できない初期ユーザーにならない。V-011）', () => {
      const reversed = JSON.stringify({
        viewer: { name: '閲覧者', permissions: [] },
        admin: { name: '管理者', permissions: ['user:manage'] },
      });

      expect(
        parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: reversed }).initialUser?.role,
      ).toBe('admin');
    });

    it('ユーザー管理の権限を持つロールがなく、INITIAL_USER_ROLE も指定しなければ、設定エラーにする（V-011）', () => {
      const noManager = JSON.stringify({ viewer: { name: '閲覧者', permissions: [] } });

      expect(() => parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: noManager })).toThrow(
        'INITIAL_USER_ROLE',
      );
      expect(
        parseConfig({
          ...INITIAL_USER,
          ROLE_DEFINITIONS_JSON: noManager,
          INITIAL_USER_ROLE: 'viewer',
        }).initialUser?.role,
      ).toBe('viewer');
    });

    it('初期ユーザーのロールが、ロール定義にない場合は、設定エラーにする', () => {
      expect(() =>
        parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: roles, INITIAL_USER_ROLE: 'none' }),
      ).toThrow('INITIAL_USER_ROLE');
      expect(() => parseConfig({ ...INITIAL_USER, ROLE_DEFINITIONS_JSON: '{}' })).toThrow(
        'INITIAL_USER_ROLE',
      );
    });
  });
});
