/**
 * 農業情報基盤の連携先の設定（接続先・テナント名・context の URL。ADR-0024。Issue #177）の検証の単体テスト。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEDERATION_TENANT,
  FederationSettingsResponseSchema,
  FederationSettingsSchema,
  FederationSettingsUpdateRequestSchema,
  FederationTestResponseSchema,
  parseFederationEndpoint,
} from '../../../src/shared/schemas/federation-connection.ts';

describe('parseFederationEndpoint（接続先の URL）', () => {
  it('https の URL を、プロトコル・ホスト・ポート・基準のパスに分ける（末尾の / は取り除く）', () => {
    expect(parseFederationEndpoint('https://platform.example.test/api/orion/ngsi-ld/v1/')).toEqual({
      protocol: 'HTTPS',
      host: 'platform.example.test',
      basePath: '/api/orion/ngsi-ld/v1',
    });
  });

  it('http・ポートの指定・パスなしも、受け付ける', () => {
    expect(parseFederationEndpoint('http://platform.example.test:1026')).toEqual({
      protocol: 'HTTP',
      host: 'platform.example.test',
      port: 1026,
      basePath: '',
    });
  });

  it.each([
    ['空', ''],
    ['スキームがない', 'platform.example.test/v1'],
    ['http・https 以外', 'ftp://platform.example.test/v1'],
    ['認証情報つき', 'https://user:dummy-pass@platform.example.test/v1'],
    ['クエリつき', 'https://platform.example.test/v1?a=1'],
    ['フラグメントつき', 'https://platform.example.test/v1#top'],
    ['ホストがない', 'https:///v1'],
    ['空白を含む', 'https://platform.example.test/v 1'],
    ['長すぎる', `https://platform.example.test/${'a'.repeat(2100)}`],
  ])('不正な URL（%s）は、undefined', (_name, value) => {
    expect(parseFederationEndpoint(value)).toBeUndefined();
  });
});

describe('FederationSettingsSchema（テナント名・context の URL・有効／無効）', () => {
  it('既定のテナント名は smart_farm_monitoring', () => {
    expect(DEFAULT_FEDERATION_TENANT).toBe('smart_farm_monitoring');
  });

  it('正しい設定を受け付ける', () => {
    const parsed = FederationSettingsSchema.safeParse({
      tenant: 'smart_farm_monitoring',
      contextUrl: 'https://raw.githubusercontent.com/example/repo/develop/context.jsonld',
      enabled: true,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['テナントが大文字', { tenant: 'Smart', contextUrl: 'https://example.test/c.jsonld' }],
    ['テナントが数字で始まる', { tenant: '1abc', contextUrl: 'https://example.test/c.jsonld' }],
    ['テナントが空', { tenant: '', contextUrl: 'https://example.test/c.jsonld' }],
    ['テナントが長すぎる', { tenant: 'a'.repeat(65), contextUrl: 'https://example.test/c.jsonld' }],
    ['context が URL でない', { tenant: 'abc', contextUrl: 'not-a-url' }],
    ['context が http・https 以外', { tenant: 'abc', contextUrl: 'file:///etc/passwd' }],
    ['context に認証情報', { tenant: 'abc', contextUrl: 'https://u:p@example.test/c.jsonld' }],
  ])('不正な設定（%s）は、拒否する', (_name, override) => {
    expect(FederationSettingsSchema.safeParse({ enabled: true, ...override }).success).toBe(false);
  });
});

describe('連携先の設定の更新・応答のスキーマ（SC-11。ADR-0024。Issue #177 の PR 3）', () => {
  const settings = {
    tenant: 'smart_farm_monitoring',
    contextUrl: 'https://example.test/context.jsonld',
    enabled: true,
  };

  it('更新の要求: 設定と、接続先（省略できる。省略は、保存済みの接続先を保つ）', () => {
    expect(FederationSettingsUpdateRequestSchema.safeParse({ settings }).success).toBe(true);
    expect(
      FederationSettingsUpdateRequestSchema.safeParse({
        settings,
        endpoint: 'https://platform.example.test/v1',
      }).success,
    ).toBe(true);
  });

  it('不正な接続先・設定の更新は、拒否する', () => {
    expect(
      FederationSettingsUpdateRequestSchema.safeParse({ settings, endpoint: 'not-a-url' }).success,
    ).toBe(false);
    expect(
      FederationSettingsUpdateRequestSchema.safeParse({
        settings: { ...settings, tenant: 'Bad' },
      }).success,
    ).toBe(false);
  });

  it('応答は、方式・設定・接続先の状態（値は、含めない）', () => {
    const parsed = FederationSettingsResponseSchema.parse({
      mode: 'ngsi-ld',
      settings,
      endpoint: { configured: true, updatedAt: '2026-11-13T00:00:00.000Z' },
    });

    expect(parsed.endpoint).toEqual({ configured: true, updatedAt: '2026-11-13T00:00:00.000Z' });
    expect(Object.keys(parsed.endpoint)).not.toContain('url');
  });

  it('接続の確認の応答は、成否とメッセージ', () => {
    expect(
      FederationTestResponseSchema.safeParse({ ok: true, message: '接続できました' }).success,
    ).toBe(true);
  });
});
