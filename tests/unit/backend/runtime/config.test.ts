import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  parseConfig,
  parseLambdaConfig,
} from '../../../../src/backend/runtime/config.ts';

const INITIAL_USER = {
  INITIAL_USER_ID: 'first-user',
  INITIAL_USER_NAME: '最初のユーザー',
  INITIAL_USER_PASSWORD: 'Dummy-Passw0rd-1',
};

const DYNAMODB_TABLES = {
  DYNAMODB_OBSERVATIONS_TABLE: 'dummy-observations',
  DYNAMODB_MAIN_TABLE: 'dummy-main',
};

// 本番（APP_MODE=production）に必要な、DynamoDB・Cognito の設定（ダミー値）
const PRODUCTION_ADAPTERS = {
  PERSISTENCE: 'dynamodb',
  ...DYNAMODB_TABLES,
  AUTH_PROVIDER: 'cognito',
  COGNITO_USER_POOL_ID: 'dummy-pool',
  COGNITO_CLIENT_ID: 'dummy-client',
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

  it('PERSISTENCE=dynamodb: テーブル名・接続先・リージョンを読み込む（メモリ・ファイルでは、持たない）', () => {
    const local = parseConfig({
      PERSISTENCE: 'dynamodb',
      ...DYNAMODB_TABLES,
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:18000',
      AWS_REGION: 'ap-northeast-1',
    });
    const aws = parseConfig({ PERSISTENCE: 'dynamodb', ...DYNAMODB_TABLES });

    expect(local.dynamodb).toEqual({
      observationsTable: 'dummy-observations',
      mainTable: 'dummy-main',
      endpoint: 'http://127.0.0.1:18000',
      region: 'ap-northeast-1',
    });
    expect(aws.dynamodb).toEqual({
      observationsTable: 'dummy-observations',
      mainTable: 'dummy-main',
      endpoint: undefined,
      region: undefined,
    });
    expect(parseConfig({ ...DYNAMODB_TABLES }).dynamodb).toBeUndefined();
  });

  it('PERSISTENCE=dynamodb: テーブル名の指定がなければ、設定エラーにする', () => {
    expect(() => parseConfig({ PERSISTENCE: 'dynamodb' })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ PERSISTENCE: 'dynamodb', DYNAMODB_MAIN_TABLE: 'dummy-main' }),
    ).toThrow('DYNAMODB_OBSERVATIONS_TABLE');
    expect(() =>
      parseConfig({ PERSISTENCE: 'dynamodb', DYNAMODB_OBSERVATIONS_TABLE: 'dummy-observations' }),
    ).toThrow('DYNAMODB_MAIN_TABLE');
  });

  it('PERSISTENCE=dynamodb: 開発用 API（リセットで、全データを消す）とは、同時に使えない', () => {
    expect(() =>
      parseConfig({ PERSISTENCE: 'dynamodb', ...DYNAMODB_TABLES, DEV_API_ENABLED: 'true' }),
    ).toThrow('DEV_API_ENABLED');
  });

  it('AUTH_PROVIDER=cognito: ユーザープール・クライアントの ID とリージョンを読み込む。既定は local（Cognito の設定は、持たない）', () => {
    const cognito = parseConfig({
      PERSISTENCE: 'dynamodb',
      ...DYNAMODB_TABLES,
      AUTH_PROVIDER: 'cognito',
      COGNITO_USER_POOL_ID: 'dummy-pool',
      COGNITO_CLIENT_ID: 'dummy-client',
      AWS_REGION: 'ap-northeast-1',
    });

    expect(cognito.cognito).toEqual({
      userPoolId: 'dummy-pool',
      clientId: 'dummy-client',
      region: 'ap-northeast-1',
    });
    expect(parseConfig({}).cognito).toBeUndefined();
    expect(
      parseConfig({ COGNITO_USER_POOL_ID: 'dummy-pool', COGNITO_CLIENT_ID: 'dummy-client' })
        .cognito,
    ).toBeUndefined();
  });

  it('AUTH_PROVIDER=cognito: ID の指定がなければ、設定エラーにする', () => {
    const base = { PERSISTENCE: 'dynamodb', ...DYNAMODB_TABLES, AUTH_PROVIDER: 'cognito' };

    expect(() => parseConfig(base)).toThrow('COGNITO_USER_POOL_ID');
    expect(() => parseConfig({ ...base, COGNITO_USER_POOL_ID: 'dummy-pool' })).toThrow(
      'COGNITO_CLIENT_ID',
    );
    expect(() => parseConfig({ ...base, COGNITO_CLIENT_ID: 'dummy-client' })).toThrow(
      'COGNITO_USER_POOL_ID',
    );
  });

  it('AUTH_PROVIDER=cognito: PERSISTENCE=dynamodb が必要（ユーザーのロールと、ログインの試行回数の制限を、DynamoDB に持つ）', () => {
    expect(() =>
      parseConfig({
        AUTH_PROVIDER: 'cognito',
        COGNITO_USER_POOL_ID: 'dummy-pool',
        COGNITO_CLIENT_ID: 'dummy-client',
      }),
    ).toThrow('PERSISTENCE=dynamodb');
  });

  it('AUTH_PROVIDER=cognito: INITIAL_USER_*（環境変数の初期ユーザー）は、使えない', () => {
    for (const name of ['INITIAL_USER_ID', 'INITIAL_USER_NAME', 'INITIAL_USER_PASSWORD']) {
      expect(() =>
        parseConfig({
          PERSISTENCE: 'dynamodb',
          ...DYNAMODB_TABLES,
          AUTH_PROVIDER: 'cognito',
          COGNITO_USER_POOL_ID: 'dummy-pool',
          COGNITO_CLIENT_ID: 'dummy-client',
          [name]: 'dummy',
        }),
      ).toThrow('INITIAL_USER_*');
    }
  });

  it('不正な AUTH_PROVIDER は、設定エラーにする', () => {
    expect(() => parseConfig({ AUTH_PROVIDER: 'ldap' })).toThrow('AUTH_PROVIDER');
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
    expect(parseConfig({ APP_MODE: 'production', ...PRODUCTION_ADAPTERS }).devApiEnabled).toBe(
      false,
    );
  });

  describe('本番（APP_MODE=production）の必須の設定（ADR-0009）', () => {
    it('DynamoDB と Cognito がそろっていれば、読み込める', () => {
      const config = parseConfig({ APP_MODE: 'production', ...PRODUCTION_ADAPTERS });

      expect(config).toMatchObject({ mode: 'production', persistence: 'dynamodb' });
      expect(config.dynamodb).toBeDefined();
      expect(config.cognito).toBeDefined();
    });

    it.each([
      ['何も指定しない', {}],
      ['認証が Cognito でない', { ...PRODUCTION_ADAPTERS, AUTH_PROVIDER: 'local' }],
      ['データが DynamoDB でない', { ...PRODUCTION_ADAPTERS, PERSISTENCE: 'memory' }],
    ])('%s場合は、設定エラーにする', (_name, adapters) => {
      expect(() => parseConfig({ APP_MODE: 'production', ...adapters })).toThrow(ConfigError);
    });
  });

  describe('Lambda の設定', () => {
    const lambdaEnv = { APP_MODE: 'production', ...PRODUCTION_ADAPTERS };

    it('開発用 API・スケジューラを、指定があっても使えなくする', () => {
      // DynamoDB の設定は、DEV_API_ENABLED そのものを拒否する。上書きは、メモリの設定で確かめる
      const config = parseLambdaConfig({
        APP_MODE: 'test',
        PERSISTENCE: 'memory',
        DEV_API_ENABLED: 'true',
        SCHEDULER_ENABLED: 'true',
      });

      expect(config.devApiEnabled).toBe(false);
      expect(config.schedulerEnabled).toBe(false);
    });

    it('SEED_MODE の指定は、起動のたびにデモデータを投入してしまうため、設定エラーにする', () => {
      expect(() => parseLambdaConfig({ ...lambdaEnv, SEED_MODE: 'DEMO' })).toThrow('SEED_MODE');
    });
  });

  describe('開発用 API の有効化（V-001）', () => {
    it('DEV_API_ENABLED=true と明示したときだけ有効にする（ローカル・テスト）', () => {
      expect(parseConfig({ APP_MODE: 'local' }).devApiEnabled).toBe(false);
      expect(parseConfig({ APP_MODE: 'test' }).devApiEnabled).toBe(false);
      expect(parseConfig({ APP_MODE: 'local', DEV_API_ENABLED: 'true' }).devApiEnabled).toBe(true);
      expect(parseConfig({ APP_MODE: 'test', DEV_API_ENABLED: 'true' }).devApiEnabled).toBe(true);
      expect(parseConfig({ APP_MODE: 'test', DEV_API_ENABLED: 'false' }).devApiEnabled).toBe(false);
    });

    it('本番では、DEV_API_ENABLED=true を、設定エラーにする（本番は DynamoDB 必須で、開発用 API を使えない）', () => {
      expect(() =>
        parseConfig({ APP_MODE: 'production', ...PRODUCTION_ADAPTERS, DEV_API_ENABLED: 'true' }),
      ).toThrow('DEV_API_ENABLED');
    });

    it('真偽値でない指定は、設定エラーにする', () => {
      expect(() => parseConfig({ DEV_API_ENABLED: 'yes' })).toThrow('DEV_API_ENABLED');
    });
  });

  describe('ファイルサーバーのモックの S3 のバケット（FILE_SERVER_S3_BUCKET。Issue #77）', () => {
    it('既定は、指定なし（ローカルのディレクトリ）。指定すれば、読み込む', () => {
      expect(parseConfig({}).fileServerBucket).toBeUndefined();
      expect(parseConfig({ FILE_SERVER_S3_BUCKET: 'dummy-file-server' }).fileServerBucket).toBe(
        'dummy-file-server',
      );
    });

    it('空の指定は、設定エラーにする', () => {
      expect(() => parseConfig({ FILE_SERVER_S3_BUCKET: '' })).toThrow('FILE_SERVER_S3_BUCKET');
    });
  });

  describe('利用者の IP のヘッダー（CLIENT_IP_HEADER。Issue #100）', () => {
    it('既定は指定なし。指定したヘッダー名は、小文字にして読み込む', () => {
      expect(parseConfig({}).clientIpHeader).toBeUndefined();
      expect(parseConfig({ CLIENT_IP_HEADER: 'X-Sfm-Viewer-Ip' }).clientIpHeader).toBe(
        'x-sfm-viewer-ip',
      );
    });

    it.each(['x sfm', 'x-sfm:ip', 'x-sfm\nip'])(
      'ヘッダー名として不正な値（%j）は、設定エラーにする',
      (value) => {
        expect(() => parseConfig({ CLIENT_IP_HEADER: value })).toThrow('CLIENT_IP_HEADER');
      },
    );
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
