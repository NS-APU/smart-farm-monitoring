/**
 * 秘密情報の保管先の組み立て（Issue #206。ADR-0016 の D-55）の結合テスト。
 * 設定（CREDENTIAL_STORE）で、パラメータストア（ssm）かメモリかを選ぶ。パラメータストアのクライアントは、偽物に差し替える。
 * 失敗しても、値が、ログに出ないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';

const DUMMY_VALUE = 'dummy-secret-value-123';

interface RecordedCommand {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function fakeSsm(options: { fail?: boolean } = {}) {
  const commands: RecordedCommand[] = [];
  return {
    commands,
    client: {
      send(command: { readonly input: unknown }): Promise<unknown> {
        commands.push({
          name: command.constructor.name,
          input: command.input as Record<string, unknown>,
        });
        if (options.fail === true) {
          return Promise.reject(new Error(`AccessDeniedException ${DUMMY_VALUE}`));
        }
        return Promise.resolve({ Parameter: { Value: DUMMY_VALUE } });
      },
    },
  };
}

const SSM_ENV = {
  APP_MODE: 'test',
  PERSISTENCE: 'memory',
  CREDENTIAL_STORE: 'ssm',
  CREDENTIAL_PATH_PREFIX: '/sfm/development/',
} as const;

describe('秘密情報の保管先（コンテナの組み立て）', () => {
  it('既定は、メモリ。書き込んだ値を読め、状態は設定済みになる（パラメータストアには、接続しない）', async () => {
    const container = createContainer(parseConfig({ APP_MODE: 'test', PERSISTENCE: 'memory' }), {
      logger: NULL_LOGGER,
    });

    await container.secrets.set('file-server/robot', DUMMY_VALUE);

    expect(await container.secrets.get('file-server/robot')).toBe(DUMMY_VALUE);
    expect(await container.secrets.status('file-server/robot')).toMatchObject({ configured: true });
    container.close();
  });

  it('CREDENTIAL_STORE=ssm は、パラメータストアの、環境のパスの下に、SecureString で書き込み、読み取る', async () => {
    const ssm = fakeSsm();
    const container = createContainer(parseConfig(SSM_ENV), {
      logger: NULL_LOGGER,
      ssmClient: ssm.client,
    });

    await container.secrets.set('web-push/vapid-private-key', DUMMY_VALUE);
    const value = await container.secrets.get('file-server/robot');

    expect(value).toBe(DUMMY_VALUE);
    expect(ssm.commands.map((command) => command.name)).toEqual([
      'PutParameterCommand',
      'GetParameterCommand',
    ]);
    expect(ssm.commands[0]?.input).toMatchObject({
      Name: '/sfm/development/web-push/vapid-private-key',
      Type: 'SecureString',
    });
    expect(ssm.commands[1]?.input).toMatchObject({ Name: '/sfm/development/file-server/robot' });
    container.close();
  });

  it('パラメータストアの失敗は、エラーの種類の名前だけをログに残し、値・AWS のエラーの内容は、ログにもエラーにも出さない', async () => {
    const logs: string[] = [];
    const ssm = fakeSsm({ fail: true });
    const container = createContainer(parseConfig(SSM_ENV), {
      logger: {
        ...NULL_LOGGER,
        warn: (message, fields) => logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) => logs.push(JSON.stringify({ message, fields })),
      },
      ssmClient: ssm.client,
    });

    const error = await container.secrets
      .set('file-server/robot', DUMMY_VALUE)
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe('秘密情報を保存できませんでした');
    // 組み立て時の別の警告を除き、秘密情報の失敗の記録は、1 件で、エラーの種類の名前だけを持つ
    const secretLogs = logs.filter((log) => log.includes('秘密情報の保存に失敗しました'));
    expect(secretLogs).toHaveLength(1);
    expect(secretLogs[0]).toContain('"errorName":"Error"');
    expect(logs.join('')).not.toContain(DUMMY_VALUE);
    expect(JSON.stringify(error)).not.toContain(DUMMY_VALUE);
    container.close();
  });
});
