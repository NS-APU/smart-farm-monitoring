/**
 * ファイルサーバーの接続設定（Issue #172。ADR-0022）のスキーマの単体テスト。
 * 接続方式（HTTP のみ。MOCK は ADR-0025 で廃止）、プロトコル・ホスト・ポート・認証方式の検証。ファイルパスは、設備が持つ（ADR-0023。設備のテストで検証する）。認証情報の値は持たない（NFR-5.4）。
 */

import { describe, expect, it } from 'vitest';
import {
  FileServerConnectionSchema,
  IngestionSourceSchema,
  IngestionSourceUpdateSchema,
  defaultHttpPort,
  describeConnectionTarget,
} from '../../../src/shared/schemas/ingestion.ts';

const VALID_HTTP = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  authMethod: 'BASIC',
} as const;

describe('接続設定: 接続方式', () => {
  it('MOCK（廃止した接続方式）は、不正', () => {
    expect(FileServerConnectionSchema.safeParse({ type: 'MOCK' }).success).toBe(false);
  });
});

describe('接続設定 HTTP の既定値', () => {
  it('protocol は HTTPS、apiKeyHeaderName は X-API-Key が既定。port は未指定のまま', () => {
    const parsed = FileServerConnectionSchema.parse({
      type: 'HTTP',
      host: 'fileserver.example.ac.jp',
      authMethod: 'API_KEY',
    });
    expect(parsed).toEqual({
      type: 'HTTP',
      protocol: 'HTTPS',
      host: 'fileserver.example.ac.jp',
      authMethod: 'API_KEY',
      apiKeyHeaderName: 'X-API-Key',
    });
  });

  it('authMethod の省略は、NONE（認証なし）', () => {
    const parsed = FileServerConnectionSchema.parse({
      type: 'HTTP',
      host: 'files.example.com',
    });
    expect(parsed).toMatchObject({ type: 'HTTP', authMethod: 'NONE' });
  });
});

describe('接続設定 HTTP: ホスト', () => {
  it.each([
    'fileserver.example.ac.jp',
    'files.example.com',
    'a-b.example.com',
    'files',
    '203.0.114.10',
    '[2606:4700:4700::1111]',
  ])('%s は、有効', (host) => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, host }).success).toBe(true);
  });

  it.each([
    ['空', ''],
    ['空白を含む', 'file server.example.com'],
    ['スキームを含む', 'https://files.example.com'],
    ['パスを含む', 'files.example.com/data'],
    ['ポートを含む（port で指定する）', 'files.example.com:8443'],
    ['認証情報を含む', 'user:pass@files.example.com'],
    ['先頭がハイフン', '-files.example.com'],
    ['階層の連続（..）', 'files..example.com'],
    ['255 文字を超える', `${'a'.repeat(250)}.example.com`],
    ['1 つの階層が 63 文字を超える', `${'a'.repeat(64)}.example.com`],
    ['日本語', 'ファイル.example.com'],
    ['IPv4 の範囲外', '256.1.1.1'],
  ])('%s は、無効', (_name, host) => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, host }).success).toBe(false);
  });

  it('前後の空白は、取り除く。大文字は、小文字にする', () => {
    const parsed = FileServerConnectionSchema.parse({
      ...VALID_HTTP,
      host: '  FileServer.Example.AC.jp ',
    });
    expect(parsed).toMatchObject({ host: 'fileserver.example.ac.jp' });
  });
});

describe('接続設定 HTTP: ポート・プロトコル', () => {
  it.each([1, 80, 443, 8443, 65535])('ポート %i は、有効', (port) => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, port }).success).toBe(true);
  });

  it.each([0, -1, 65536, 1.5])('ポート %s は、無効', (port) => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, port }).success).toBe(false);
  });

  it('プロトコルは、HTTP・HTTPS のみ', () => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, protocol: 'HTTP' }).success).toBe(
      true,
    );
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, protocol: 'FTP' }).success).toBe(
      false,
    );
  });

  it('既定のポートは、HTTPS が 443・HTTP が 80', () => {
    expect(defaultHttpPort('HTTPS')).toBe(443);
    expect(defaultHttpPort('HTTP')).toBe(80);
  });
});

describe('接続設定 HTTP: ファイルパス（設備ごとに移した。ADR-0023）', () => {
  it('接続設定は、ファイルパスを持たない。保存済みの設定に残る filePath は、読み出すときに、無視する（移行）', () => {
    const parsed = FileServerConnectionSchema.parse({ ...VALID_HTTP, filePath: '/data/old.json' });

    expect(parsed).not.toHaveProperty('filePath');
  });
});

describe('接続設定 HTTP: 認証方式', () => {
  it.each(['NONE', 'BASIC', 'BEARER', 'API_KEY'])('%s は、有効', (authMethod) => {
    expect(FileServerConnectionSchema.safeParse({ ...VALID_HTTP, authMethod }).success).toBe(true);
  });

  it('未知の認証方式は、無効', () => {
    expect(
      FileServerConnectionSchema.safeParse({ ...VALID_HTTP, authMethod: 'DIGEST' }).success,
    ).toBe(false);
  });

  it.each(['X-API-Key', 'X-Auth-Token', 'api_key', 'Ocp-Apim-Subscription-Key'])(
    'API キーのヘッダー名 %s は、有効',
    (apiKeyHeaderName) => {
      expect(
        FileServerConnectionSchema.safeParse({
          ...VALID_HTTP,
          authMethod: 'API_KEY',
          apiKeyHeaderName,
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    ['空', ''],
    ['空白を含む', 'X API Key'],
    ['改行を含む', 'X-Key\r\nHost: evil'],
    ['コロンを含む', 'X-Key:'],
    ['日本語', '鍵'],
    ['Host（予約済み）', 'Host'],
    ['host（大文字小文字を区別しない）', 'host'],
    ['Authorization（認証方式 BEARER・BASIC で使う）', 'Authorization'],
    ['Content-Length', 'Content-Length'],
    ['Transfer-Encoding', 'Transfer-Encoding'],
    ['Connection', 'Connection'],
    ['Cookie', 'Cookie'],
    ['65 文字以上', 'X'.repeat(65)],
  ])('API キーのヘッダー名 %s は、無効', (_name, apiKeyHeaderName) => {
    expect(
      FileServerConnectionSchema.safeParse({
        ...VALID_HTTP,
        authMethod: 'API_KEY',
        apiKeyHeaderName,
      }).success,
    ).toBe(false);
  });

  it('認証情報の値（パスワード・トークン・API キー）は、接続設定に持てない（未知の項目は、除かれる）', () => {
    const parsed = FileServerConnectionSchema.parse({
      ...VALID_HTTP,
      password: 'dummy-password',
      token: 'dummy-token',
      apiKey: 'dummy-api-key',
    });
    expect(JSON.stringify(parsed)).not.toContain('dummy-');
  });
});

describe('取り込み元の設定（共通の接続の廃止。ADR-0026）', () => {
  const base = {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-json',
    isEnabled: true,
  } as const;

  it('取り込み元の設定は、接続・接続設定の参照名を持たない（有効／無効だけ）', () => {
    expect(IngestionSourceSchema.parse(base)).toEqual(base);
  });

  it.each([
    ['接続方式 MOCK（廃止）', { type: 'MOCK' }],
    ['HTTP の接続', VALID_HTTP],
    ['不正な HTTP の接続（読み込みは、失敗しない）', { ...VALID_HTTP, host: 'http://x' }],
  ])(
    '以前に保存された取り込み元の connection（%s）・connectionRef・intervalMinutes は、読み込むときに無視する',
    (_name, connection) => {
      const parsed = IngestionSourceSchema.parse({
        ...base,
        connectionRef: 'FILE_SERVER_MOCK',
        connection,
        intervalMinutes: 30,
      });

      expect(parsed).toEqual(base);
    },
  );

  it('変更の入力は、{ sourceId, isEnabled } だけで足りる', () => {
    expect(IngestionSourceUpdateSchema.parse({ sourceId: 'robot', isEnabled: false })).toEqual({
      sourceId: 'robot',
      isEnabled: false,
    });
    expect(IngestionSourceUpdateSchema.safeParse({ sourceId: 'robot' }).success).toBe(false);
  });

  it('変更の入力に、旧項目（connection・connectionRef・intervalMinutes）を含めても、無視する（不正な接続設定でも、拒否しない）', () => {
    const parsed = IngestionSourceUpdateSchema.parse({
      sourceId: 'robot',
      connectionRef: 'FILE_SERVER_MOCK',
      connection: { ...VALID_HTTP, host: 'http://x' },
      intervalMinutes: 30,
      isEnabled: true,
    });

    expect(parsed).toEqual({ sourceId: 'robot', isEnabled: true });
  });
});

describe('接続先の表示（describeConnectionTarget）', () => {
  it('HTTP: プロトコル・ホスト・ポートを組み立てる（パスは、設備ごとのため含めない）。既定のポートは省略する', () => {
    expect(describeConnectionTarget(FileServerConnectionSchema.parse(VALID_HTTP))).toBe(
      'https://fileserver.example.ac.jp',
    );
    expect(
      describeConnectionTarget(FileServerConnectionSchema.parse({ ...VALID_HTTP, port: 8443 })),
    ).toBe('https://fileserver.example.ac.jp:8443');
    expect(
      describeConnectionTarget(
        FileServerConnectionSchema.parse({ ...VALID_HTTP, protocol: 'HTTP', port: 80 }),
      ),
    ).toBe('http://fileserver.example.ac.jp');
  });

  it('未設定（undefined）は、undefined（接続先を持たない）', () => {
    expect(describeConnectionTarget(undefined)).toBeUndefined();
  });
});
