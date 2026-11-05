/**
 * パラメータストア（SecureString）の SecretPort（Issue #206。D-55）の単体テスト。
 * 実際の AWS には接続せず、クライアントの偽物で、送るコマンドの内容・キャッシュ・取り直し・値が出ないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  createSsmSecretPort,
  SECRET_CACHE_TTL_MS,
} from '../../../../src/backend/infrastructure/ssm/ssm-secret.ts';

const PREFIX = '/sfm/development/';
const DUMMY_VALUE = 'dummy-secret-value-123';

interface FakeParameter {
  value: string;
  lastModifiedDate: Date;
}

/** SDK のコマンドの、必要な部分（クラス名と入力）だけ。テストが、SDK に依存しないようにする。 */
interface FakeCommand {
  readonly constructor: { readonly name: string };
  readonly input: {
    Name?: string;
    Value?: string;
    WithDecryption?: boolean;
    Type?: string;
    Overwrite?: boolean;
    Tier?: string;
  };
}

const isGet = (command: FakeCommand): boolean => command.constructor.name === 'GetParameterCommand';

/** パラメータストアの「見つからない」エラー（SDK の ParameterNotFound と同じ名前）。 */
function notFound(): Error {
  return Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
}

/** パラメータストアの偽物。呼ばれたコマンドを、記録する。 */
function createFake(initial: Record<string, FakeParameter> = {}) {
  const store = new Map(Object.entries(initial));
  const commands: FakeCommand[] = [];
  let failWith: Error | undefined;
  const client = {
    send(command: FakeCommand): Promise<unknown> {
      commands.push(command);
      if (failWith !== undefined) {
        return Promise.reject(failWith);
      }
      if (isGet(command)) {
        const entry = store.get(command.input.Name ?? '');
        if (entry === undefined) {
          return Promise.reject(notFound());
        }
        return Promise.resolve({
          Parameter: {
            Name: command.input.Name,
            // WithDecryption が false のときは、値を返さない（暗号文。状態の確認に使う）
            Value: command.input.WithDecryption === true ? entry.value : 'AQICAHj-encrypted',
            LastModifiedDate: entry.lastModifiedDate,
          },
        });
      }
      store.set(command.input.Name ?? '', {
        value: command.input.Value ?? '',
        lastModifiedDate: new Date('2026-11-09T01:00:00.000Z'),
      });
      return Promise.resolve({ Version: 1 });
    },
  };
  return {
    client,
    store,
    commands,
    failNextWith(error: Error | undefined) {
      failWith = error;
    },
  };
}

function setup(initial: Record<string, FakeParameter> = {}) {
  const fake = createFake(initial);
  let nowMs = Date.parse('2026-11-09T00:00:00.000Z');
  const port = createSsmSecretPort({
    client: fake.client,
    pathPrefix: PREFIX,
    now: () => nowMs,
  });
  return {
    fake,
    port,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const existing = (value = DUMMY_VALUE): Record<string, FakeParameter> => ({
  [`${PREFIX}file-server/robot`]: {
    value,
    lastModifiedDate: new Date('2026-11-08T05:00:00.000Z'),
  },
});

describe('パラメータストアの SecretPort: 読み取り', () => {
  it('参照名に、パスの接頭辞をつけて、復号つきで読む', async () => {
    const { fake, port } = setup(existing());

    const value = await port.get('file-server/robot');

    expect(value).toBe(DUMMY_VALUE);
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.input).toEqual({
      Name: '/sfm/development/file-server/robot',
      WithDecryption: true,
    });
  });

  it('未設定の参照名は、undefined', async () => {
    const { port } = setup();

    expect(await port.get('file-server/robot')).toBeUndefined();
  });

  it('不正な参照名は、パラメータストアに送らず、拒否する', async () => {
    const { fake, port } = setup(existing());

    await expect(port.get('../other/robot')).rejects.toThrow('秘密情報の参照名が正しくありません');
    await expect(port.set('/abs', 'v')).rejects.toThrow('秘密情報の参照名が正しくありません');
    await expect(port.status('A/B')).rejects.toThrow('秘密情報の参照名が正しくありません');
    expect(fake.commands).toHaveLength(0);
  });
});

describe('パラメータストアの SecretPort: キャッシュ（5 分）と取り直し', () => {
  it('5 分以内の読み取りは、キャッシュを使い、パラメータストアを呼ばない', async () => {
    const { fake, port, advance } = setup(existing());
    await port.get('file-server/robot');

    advance(SECRET_CACHE_TTL_MS - 1);
    const second = await port.get('file-server/robot');

    expect(second).toBe(DUMMY_VALUE);
    expect(fake.commands).toHaveLength(1);
  });

  it('5 分が過ぎたら、取り直す（期限は、5 分ちょうど）。値が変わっていれば、新しい値になる', async () => {
    const { fake, port, advance } = setup(existing('old-value'));
    expect(await port.get('file-server/robot')).toBe('old-value');
    fake.store.set(`${PREFIX}file-server/robot`, {
      value: 'new-value',
      lastModifiedDate: new Date('2026-11-09T00:01:00.000Z'),
    });

    advance(SECRET_CACHE_TTL_MS);
    const value = await port.get('file-server/robot');

    expect(SECRET_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(value).toBe('new-value');
    expect(fake.commands).toHaveLength(2);
  });

  it('refresh を指定すると、期限を待たず、すぐ取り直す（認証に失敗したとき）', async () => {
    const { fake, port } = setup(existing('old-value'));
    await port.get('file-server/robot');
    fake.store.set(`${PREFIX}file-server/robot`, {
      value: 'rotated-value',
      lastModifiedDate: new Date('2026-11-09T00:01:00.000Z'),
    });

    const cached = await port.get('file-server/robot');
    const refreshed = await port.get('file-server/robot', { refresh: true });

    expect(cached).toBe('old-value');
    expect(refreshed).toBe('rotated-value');
    // 取り直したあとは、新しい値を、キャッシュする
    expect(await port.get('file-server/robot')).toBe('rotated-value');
    expect(fake.commands).toHaveLength(2);
  });

  it('未設定の結果も、5 分は、キャッシュする（未設定の参照名への、繰り返しの問い合わせを避ける）', async () => {
    const { fake, port } = setup();

    await port.get('file-server/robot');
    await port.get('file-server/robot');

    expect(fake.commands).toHaveLength(1);
  });

  it('書き込むと、そのプロセスのキャッシュは、新しい値になる', async () => {
    const { fake, port } = setup(existing('old-value'));
    await port.get('file-server/robot');

    await port.set('file-server/robot', 'written-value');

    expect(await port.get('file-server/robot')).toBe('written-value');
    // 最初の読み取り 1 回と、書き込み 1 回だけ（書き込み後の読み取りは、キャッシュ）
    expect(fake.commands.map((command) => command.constructor.name)).toEqual([
      'GetParameterCommand',
      'PutParameterCommand',
    ]);
  });
});

describe('パラメータストアの SecretPort: 書き込みと状態の確認', () => {
  it('SecureString で、上書きして保存する（標準のパラメータ）', async () => {
    const { fake, port } = setup();

    await port.set('web-push/vapid-private-key', DUMMY_VALUE);

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.input).toEqual({
      Name: '/sfm/development/web-push/vapid-private-key',
      Value: DUMMY_VALUE,
      Type: 'SecureString',
      Overwrite: true,
      Tier: 'Standard',
    });
  });

  it('空の値・4 KB を超える値は、保存しない（パラメータストアの標準の上限）', async () => {
    const { fake, port } = setup();

    await expect(port.set('file-server/robot', '')).rejects.toThrow(
      '秘密情報の値が正しくありません',
    );
    await expect(port.set('file-server/robot', 'x'.repeat(4097))).rejects.toThrow(
      '秘密情報の値が正しくありません',
    );
    await expect(port.set('file-server/robot', 'x'.repeat(4096))).resolves.toBeUndefined();
    expect(fake.commands).toHaveLength(1);
  });

  it('状態: 設定済みと更新日時を返す。値は、復号せず、読まない', async () => {
    const { fake, port } = setup(existing());

    const status = await port.status('file-server/robot');

    expect(status).toEqual({ configured: true, updatedAt: '2026-11-08T05:00:00.000Z' });
    expect(fake.commands[0]?.input).toEqual({
      Name: '/sfm/development/file-server/robot',
      WithDecryption: false,
    });
    expect(JSON.stringify(status)).not.toContain(DUMMY_VALUE);
  });

  it('状態: 未設定は、configured: false（更新日時なし）', async () => {
    const { port } = setup();

    expect(await port.status('file-server/robot')).toEqual({ configured: false });
  });

  it('状態は、キャッシュしない（画面が、保存の直後に、最新の状態を示すため）', async () => {
    const { fake, port } = setup();
    expect(await port.status('file-server/robot')).toEqual({ configured: false });

    await port.set('file-server/robot', DUMMY_VALUE);

    expect(await port.status('file-server/robot')).toMatchObject({ configured: true });
    expect(fake.commands.filter(isGet)).toHaveLength(2);
  });
});

describe('パラメータストアの SecretPort: 失敗と、値が出ないこと', () => {
  it('読み取りの失敗は、サービスが利用できない旨のエラーにする（AWS のエラーの内容は、出さない）', async () => {
    const { fake, port } = setup(existing());
    fake.failNextWith(new Error(`AccessDeniedException ${DUMMY_VALUE}`));

    const error = await port.get('file-server/robot').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('秘密情報を読み取れませんでした');
    expect((error as Error).message).not.toContain(DUMMY_VALUE);
    expect(JSON.stringify(error)).not.toContain(DUMMY_VALUE);
  });

  it('書き込みの失敗は、書き込もうとした値を、エラーに含めない', async () => {
    const { fake, port } = setup();
    fake.failNextWith(new Error(`ValidationException: value=${DUMMY_VALUE}`));

    const error = await port
      .set('file-server/robot', DUMMY_VALUE)
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe('秘密情報を保存できませんでした');
    expect(JSON.stringify(error)).not.toContain(DUMMY_VALUE);
    expect(String((error as Error).stack)).not.toContain(DUMMY_VALUE);
  });

  it('状態の確認の失敗も、エラーの内容を出さない', async () => {
    const { fake, port } = setup(existing());
    fake.failNextWith(new Error('throttled'));

    await expect(port.status('file-server/robot')).rejects.toThrow(
      '秘密情報の状態を確認できませんでした',
    );
  });

  it('失敗した読み取りは、キャッシュしない（次の呼び出しで、取り直せる）', async () => {
    const { fake, port } = setup(existing());
    fake.failNextWith(new Error('throttled'));
    await expect(port.get('file-server/robot')).rejects.toThrow();
    fake.failNextWith(undefined);

    expect(await port.get('file-server/robot')).toBe(DUMMY_VALUE);
  });
});
