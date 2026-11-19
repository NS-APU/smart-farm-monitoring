/**
 * ファイルサーバーの認証情報（Issue #172。ADR-0022）の単体テスト。
 * 秘密情報の値（SecretPort）から、認証方式に合わせた、リクエストのヘッダーを組み立てる。値は、エラーに含めない。
 */

import { describe, expect, it } from 'vitest';
import type { HttpFileServerConnection } from '../../../../src/shared/schemas/ingestion.ts';
import {
  buildAuthHeaders,
  fileServerEquipmentSecretReference,
} from '../../../../src/backend/application/ingestion/file-server-credentials.ts';
import { FileSourceFailure } from '../../../../src/backend/application/ports/file-source-port.ts';

function connection(overrides: Partial<HttpFileServerConnection>): HttpFileServerConnection {
  return {
    type: 'HTTP',
    protocol: 'HTTPS',
    host: 'fileserver.example.ac.jp',
    authMethod: 'NONE',
    apiKeyHeaderName: 'X-API-Key',
    ...overrides,
  };
}

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FileSourceFailure);
    return (error as FileSourceFailure).reason;
  }
  throw new Error('失敗するはずの処理が、成功した');
}

describe('秘密情報の参照名（設備ごと）', () => {
  it('設備ごとに、file-server/equipment/<設備 ID のハッシュ（16 進 32 文字）>。同じ設備 ID は、常に同じ参照名', () => {
    const reference = fileServerEquipmentSecretReference('ROBOT-01');

    expect(reference).toMatch(/^file-server\/equipment\/[0-9a-f]{32}$/);
    expect(fileServerEquipmentSecretReference('ROBOT-01')).toBe(reference);
    expect(fileServerEquipmentSecretReference('ROBOT-02')).not.toBe(reference);
  });

  it('設備 ID は、大文字・100 文字まででも、参照名にできる（設備 ID そのものは、参照名に含めない）', () => {
    const equipmentId = `ROBOT-${'A'.repeat(94)}`;

    expect(fileServerEquipmentSecretReference(equipmentId)).not.toContain('ROBOT');
  });
});

describe('認証のヘッダーの組み立て', () => {
  it('NONE: ヘッダーなし。値は、読まなくてよい', () => {
    expect(buildAuthHeaders(connection({ authMethod: 'NONE' }), undefined)).toEqual({});
  });

  it('BASIC: JSON {"username","password"} を、Authorization: Basic にする', () => {
    const headers = buildAuthHeaders(
      connection({ authMethod: 'BASIC' }),
      JSON.stringify({ username: 'dummy-user', password: 'dummy:pass' }),
    );
    expect(headers).toEqual({
      Authorization: `Basic ${Buffer.from('dummy-user:dummy:pass').toString('base64')}`,
    });
  });

  it('BASIC: パスワードには、: を含められる。ユーザー名には、含められない（Basic 認証の仕様）', () => {
    expect(
      reasonOf(() =>
        buildAuthHeaders(
          connection({ authMethod: 'BASIC' }),
          JSON.stringify({ username: 'dummy:user', password: 'p' }),
        ),
      ),
    ).toBe('CREDENTIALS_INVALID');
  });

  it.each([
    ['JSON ではない', 'dummy-not-json'],
    ['オブジェクトではない', '"dummy"'],
    ['username がない', JSON.stringify({ password: 'p' })],
    ['password がない', JSON.stringify({ username: 'u' })],
    ['username が空', JSON.stringify({ username: '', password: 'p' })],
    ['password が空', JSON.stringify({ username: 'u', password: '' })],
    ['文字列ではない', JSON.stringify({ username: 1, password: 'p' })],
  ])('BASIC: %s は、CREDENTIALS_INVALID', (_name, value) => {
    expect(reasonOf(() => buildAuthHeaders(connection({ authMethod: 'BASIC' }), value))).toBe(
      'CREDENTIALS_INVALID',
    );
  });

  it('BEARER: トークンを、Authorization: Bearer にする（前後の空白は、取り除く）', () => {
    expect(buildAuthHeaders(connection({ authMethod: 'BEARER' }), '  dummy-token \n')).toEqual({
      Authorization: 'Bearer dummy-token',
    });
  });

  it('API_KEY: 指定のヘッダー名に、API キーを入れる', () => {
    expect(
      buildAuthHeaders(
        connection({ authMethod: 'API_KEY', apiKeyHeaderName: 'X-Auth-Token' }),
        'dummy-api-key',
      ),
    ).toEqual({ 'X-Auth-Token': 'dummy-api-key' });
  });

  it.each(['BASIC', 'BEARER', 'API_KEY'] as const)(
    '%s: 値が未設定なら、CREDENTIALS_MISSING',
    (authMethod) => {
      expect(reasonOf(() => buildAuthHeaders(connection({ authMethod }), undefined))).toBe(
        'CREDENTIALS_MISSING',
      );
    },
  );

  it.each([
    ['改行を含む（ヘッダーの注入）', 'dummy\r\nX-Evil: 1'],
    ['日本語を含む', 'ダミー'],
    ['空', ''],
    ['空白だけ', '   '],
    ['内部に空白を含む', 'dummy token'],
  ])('BEARER・API_KEY: %s は、CREDENTIALS_INVALID', (_name, value) => {
    expect(reasonOf(() => buildAuthHeaders(connection({ authMethod: 'BEARER' }), value))).toBe(
      value.trim() === '' ? 'CREDENTIALS_MISSING' : 'CREDENTIALS_INVALID',
    );
    expect(reasonOf(() => buildAuthHeaders(connection({ authMethod: 'API_KEY' }), value))).toBe(
      value.trim() === '' ? 'CREDENTIALS_MISSING' : 'CREDENTIALS_INVALID',
    );
  });

  it('エラーに、値を含めない', () => {
    try {
      buildAuthHeaders(connection({ authMethod: 'BEARER' }), 'dummy-secret\r\nvalue');
    } catch (error) {
      expect((error as Error).message).not.toContain('dummy-secret');
      expect(JSON.stringify(error)).not.toContain('dummy-secret');
      return;
    }
    throw new Error('失敗するはずの処理が、成功した');
  });
});
