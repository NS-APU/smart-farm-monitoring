/**
 * オリジンの秘密（Secrets Manager。Issue #102。ADR-0010 の追記）を読むアダプタの単体テスト。
 * 実際の AWS には接続せず、クライアントの偽物で、送るコマンドの内容・値の検証・失敗時に値が出ないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import { createOriginSecretReader } from '../../../../src/backend/infrastructure/secrets-manager/origin-secret-reader.ts';

const ARN = 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:SfmOriginSecret-AbCdEf';
const VALUE = 'dummyOriginSecret0123456789abcdefABCDEF0123456789';

interface FakeCommand {
  readonly constructor: { readonly name: string };
  readonly input: { SecretId?: string };
}

function fakeClient(result: unknown | Error) {
  const sent: FakeCommand[] = [];
  return {
    sent,
    client: {
      send: (command: FakeCommand): Promise<unknown> => {
        sent.push(command);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

describe('オリジンの秘密を読むアダプタ（Secrets Manager）', () => {
  it('指定した ARN の秘密の値（SecretString）を、GetSecretValue で読んで返す', async () => {
    const { client, sent } = fakeClient({ SecretString: VALUE });

    const value = await createOriginSecretReader({ client })(ARN);

    expect(value).toBe(VALUE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.constructor.name).toBe('GetSecretValueCommand');
    expect(sent[0]?.input.SecretId).toBe(ARN);
  });

  it.each([
    ['値がない', {}],
    ['文字列でない（バイナリ）', { SecretBinary: new Uint8Array([1, 2, 3]) }],
    ['空', { SecretString: '' }],
    ['短すぎる', { SecretString: 'short' }],
    ['英数字以外を含む', { SecretString: `${VALUE}-!` }],
  ])(
    '秘密の値が正しくない（%s）ときは、失敗する。エラーに、値を含めない',
    async (_label, result) => {
      const { client } = fakeClient(result);

      const failure = await createOriginSecretReader({ client })(ARN).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const text = `${String((failure as Error).message)} ${JSON.stringify(failure)}`;
      expect(text).toContain('オリジンの秘密');
      expect(text).not.toContain(VALUE);
      expect(text).not.toContain('short');
    },
  );

  it('AWS の呼び出しに失敗したときは、エラーの種類の名前だけを伝える（AWS のエラーの内容・ARN を含めない）', async () => {
    const awsError = Object.assign(new Error(`not authorized to perform on ${ARN}`), {
      name: 'AccessDeniedException',
    });
    const { client } = fakeClient(awsError);

    const failure = await createOriginSecretReader({ client })(ARN).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('AccessDeniedException');
    expect(message).not.toContain('111111111111');
    expect(message).not.toContain('SfmOriginSecret');
  });
});
