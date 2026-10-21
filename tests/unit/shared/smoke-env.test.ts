/** サーバーレス環境のスモークテストの、接続先・認証情報の読み取り（tests/smoke/support/smoke-env.ts。Issue #79）。 */

import { describe, expect, it } from 'vitest';
import { readSmokeEnv } from '../../smoke/support/smoke-env.ts';

const VALID = {
  SMOKE_BASE_URL: 'https://dummy-example.cloudfront.net',
  SMOKE_USER_ID: 'dummy-admin',
  SMOKE_PASSWORD: 'Dummy-Passw0rd',
};

describe('スモークテストの環境変数', () => {
  it('URL・ユーザーID・パスワードを読む。URL は、末尾のスラッシュを除いた origin にする', () => {
    expect(readSmokeEnv(VALID)).toEqual({
      baseUrl: 'https://dummy-example.cloudfront.net',
      userId: 'dummy-admin',
      password: 'Dummy-Passw0rd',
    });
    expect(
      readSmokeEnv({ ...VALID, SMOKE_BASE_URL: 'https://dummy-example.cloudfront.net/' }).baseUrl,
    ).toBe('https://dummy-example.cloudfront.net');
  });

  it('ローカルの確認用に限り、http の localhost を許す', () => {
    expect(readSmokeEnv({ ...VALID, SMOKE_BASE_URL: 'http://127.0.0.1:5173' }).baseUrl).toBe(
      'http://127.0.0.1:5173',
    );
    expect(readSmokeEnv({ ...VALID, SMOKE_BASE_URL: 'http://localhost:5173' }).baseUrl).toBe(
      'http://localhost:5173',
    );
  });

  it.each(['SMOKE_BASE_URL', 'SMOKE_USER_ID', 'SMOKE_PASSWORD'])(
    '%s が未指定・空なら、その名前を示すエラーにする',
    (name) => {
      expect(() => readSmokeEnv({ ...VALID, [name]: undefined })).toThrow(name);
      expect(() => readSmokeEnv({ ...VALID, [name]: '  ' })).toThrow(name);
    },
  );

  it.each([
    ['URL でない', 'dummy-example'],
    ['平文の http（localhost 以外）', 'http://dummy-example.cloudfront.net'],
    ['パスがある', 'https://dummy-example.cloudfront.net/app'],
    ['クエリがある', 'https://dummy-example.cloudfront.net/?a=1'],
    ['フラグメントがある', 'https://dummy-example.cloudfront.net/#x'],
  ])('SMOKE_BASE_URL が不正（%s）ならエラーにする', (_reason, url) => {
    expect(() => readSmokeEnv({ ...VALID, SMOKE_BASE_URL: url })).toThrow('SMOKE_BASE_URL');
  });

  it('エラーメッセージに、パスワードを含めない', () => {
    try {
      readSmokeEnv({ ...VALID, SMOKE_BASE_URL: 'dummy-example' });
      expect.unreachable('エラーになるはず');
    } catch (error) {
      expect(String(error)).not.toContain(VALID.SMOKE_PASSWORD);
    }
  });
});
