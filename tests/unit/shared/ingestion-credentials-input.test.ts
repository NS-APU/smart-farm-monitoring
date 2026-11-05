/**
 * ファイルサーバーの認証情報の登録の入力（Issue #207。D-47）のスキーマの単体テスト。
 * 認証方式ごとの値の検証（ユーザー名の : ・制御文字、トークンの空白・改行・日本語・長さ）と、状態のスキーマ。
 */

import { describe, expect, it } from 'vitest';
import {
  IngestionCredentialStatusSchema,
  IngestionCredentialsInputSchema,
} from '../../../src/shared/schemas/ingestion.ts';

describe('Basic', () => {
  it('ユーザー名・パスワードを受け付ける（パスワードに、空白・記号・日本語を含められる）', () => {
    const parsed = IngestionCredentialsInputSchema.parse({
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: 'dummy pass:ワード!',
    });
    expect(parsed).toEqual({
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: 'dummy pass:ワード!',
    });
  });

  it.each([
    ['ユーザー名が空', { username: '', password: 'p' }],
    ['ユーザー名に : を含む', { username: 'a:b', password: 'p' }],
    ['ユーザー名に改行を含む', { username: 'a\nb', password: 'p' }],
    ['ユーザー名に DEL を含む', { username: 'a\x7fb', password: 'p' }],
    ['ユーザー名が 201 文字', { username: 'a'.repeat(201), password: 'p' }],
    ['パスワードが空', { username: 'u', password: '' }],
    ['パスワードが 1001 文字', { username: 'u', password: 'p'.repeat(1001) }],
  ])('%s は、無効', (_name, values) => {
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'BASIC', ...values }).success,
    ).toBe(false);
  });

  it('ユーザー名 200 文字・パスワード 1000 文字は、有効（境界）', () => {
    expect(
      IngestionCredentialsInputSchema.safeParse({
        authMethod: 'BASIC',
        username: 'a'.repeat(200),
        password: 'p'.repeat(1000),
      }).success,
    ).toBe(true);
  });
});

describe('Bearer・API キー', () => {
  it.each([
    ['BEARER', 'token'],
    ['API_KEY', 'apiKey'],
  ] as const)('%s: 前後の空白を取り除き、表示できる ASCII を受け付ける', (authMethod, key) => {
    const parsed = IngestionCredentialsInputSchema.parse({
      authMethod,
      [key]: '  dummy-Token_0.1~+/=  ',
    });
    expect(parsed).toMatchObject({ [key]: 'dummy-Token_0.1~+/=' });
  });

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['内部に空白', 'dummy token'],
    ['改行（ヘッダーの注入）', 'dummy\r\nX-Evil: 1'],
    ['日本語', 'ダミー'],
    ['2001 文字', 'a'.repeat(2001)],
  ])('%s は、無効', (_name, value) => {
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'BEARER', token: value }).success,
    ).toBe(false);
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'API_KEY', apiKey: value }).success,
    ).toBe(false);
  });

  it('2000 文字は、有効（境界）', () => {
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'BEARER', token: 'a'.repeat(2000) })
        .success,
    ).toBe(true);
  });

  it('認証方式 NONE・未知の認証方式は、無効。認証方式と値の組み合わせが違う（BEARER に apiKey）も、無効', () => {
    expect(IngestionCredentialsInputSchema.safeParse({ authMethod: 'NONE' }).success).toBe(false);
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'DIGEST', token: 't' }).success,
    ).toBe(false);
    expect(
      IngestionCredentialsInputSchema.safeParse({ authMethod: 'BEARER', apiKey: 'k' }).success,
    ).toBe(false);
  });
});

describe('認証情報の状態', () => {
  it.each(['NOT_REQUIRED', 'NOT_CONFIGURED', 'CONFIGURED', 'UNAVAILABLE'])(
    '%s を受け付ける。値は、持たない',
    (state) => {
      expect(IngestionCredentialStatusSchema.parse({ state, secret: 'dummy' })).toEqual({ state });
    },
  );

  it('更新日時を持てる。未知の状態は、無効', () => {
    expect(
      IngestionCredentialStatusSchema.parse({
        state: 'CONFIGURED',
        updatedAt: '2026-11-09T02:00:00.000Z',
      }),
    ).toEqual({ state: 'CONFIGURED', updatedAt: '2026-11-09T02:00:00.000Z' });
    expect(IngestionCredentialStatusSchema.safeParse({ state: 'UNKNOWN' }).success).toBe(false);
  });
});
