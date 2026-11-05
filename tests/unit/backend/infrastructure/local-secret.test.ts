/** ローカル・テスト用の SecretPort（メモリ・環境変数。Issue #206）の単体テスト。パラメータストアの実装と、同じ契約を満たす。 */

import { describe, expect, it } from 'vitest';
import {
  createEnvSecretPort,
  createMemorySecretPort,
} from '../../../../src/backend/infrastructure/local/env-secret.ts';

const DUMMY_VALUE = 'dummy-secret-value-123';

describe('メモリの SecretPort', () => {
  it('書き込んだ値を読める。未設定は undefined。状態は、設定済みと更新日時', async () => {
    const clock = { now: Date.parse('2026-11-09T02:00:00.000Z') };
    const secrets = createMemorySecretPort({}, () => clock.now);
    expect(await secrets.get('file-server/robot')).toBeUndefined();
    expect(await secrets.status('file-server/robot')).toEqual({ configured: false });

    await secrets.set('file-server/robot', DUMMY_VALUE);

    expect(await secrets.get('file-server/robot')).toBe(DUMMY_VALUE);
    expect(await secrets.status('file-server/robot')).toEqual({
      configured: true,
      updatedAt: '2026-11-09T02:00:00.000Z',
    });
  });

  it('上書きでき、更新日時が変わる。refresh を指定しても、同じ値', async () => {
    const clock = { now: Date.parse('2026-11-09T02:00:00.000Z') };
    const secrets = createMemorySecretPort({ 'file-server/robot': 'old' }, () => clock.now);

    clock.now += 60_000;
    await secrets.set('file-server/robot', 'new');

    expect(await secrets.get('file-server/robot', { refresh: true })).toBe('new');
    expect(await secrets.status('file-server/robot')).toEqual({
      configured: true,
      updatedAt: '2026-11-09T02:01:00.000Z',
    });
  });

  it('不正な参照名・空の値・4 KB を超える値は、拒否する（パラメータストアと同じ規則）', async () => {
    const secrets = createMemorySecretPort();

    await expect(secrets.get('../x')).rejects.toThrow('秘密情報の参照名が正しくありません');
    await expect(secrets.set('A', 'v')).rejects.toThrow('秘密情報の参照名が正しくありません');
    await expect(secrets.set('file-server/robot', '')).rejects.toThrow(
      '秘密情報の値が正しくありません',
    );
    await expect(secrets.set('file-server/robot', 'x'.repeat(4097))).rejects.toThrow(
      '秘密情報の値が正しくありません',
    );
  });
});

describe('環境変数の SecretPort', () => {
  it('読み取りは、環境変数 SECRET_<参照名>（英大文字・数字・_ に置き換える）から。階層の / や - は、_ になる', async () => {
    const secrets = createEnvSecretPort({
      SECRET_FILE_SERVER_ROBOT: DUMMY_VALUE,
      SECRET_WEB_PUSH_VAPID_PRIVATE_KEY: 'dummy-key',
    });

    expect(await secrets.get('file-server/robot')).toBe(DUMMY_VALUE);
    expect(await secrets.get('web-push/vapid-private-key')).toBe('dummy-key');
    expect(await secrets.get('file-server/other')).toBeUndefined();
  });

  it('書き込みは、メモリにだけ持つ（環境変数・プロセスの外は、変えない）。環境変数の値より、書き込みが優先する', async () => {
    const env = { SECRET_FILE_SERVER_ROBOT: 'from-env' };
    const secrets = createEnvSecretPort(env);

    await secrets.set('file-server/robot', 'written');

    expect(await secrets.get('file-server/robot')).toBe('written');
    expect(env.SECRET_FILE_SERVER_ROBOT).toBe('from-env');
    expect(await secrets.status('file-server/robot')).toMatchObject({ configured: true });
  });

  it('状態: 環境変数にだけある値は、設定済み（更新日時なし）。値は、状態に含まれない', async () => {
    const secrets = createEnvSecretPort({ SECRET_FILE_SERVER_ROBOT: DUMMY_VALUE });

    const status = await secrets.status('file-server/robot');

    expect(status).toEqual({ configured: true });
    expect(JSON.stringify(status)).not.toContain(DUMMY_VALUE);
    expect(await secrets.status('file-server/none')).toEqual({ configured: false });
  });
});
