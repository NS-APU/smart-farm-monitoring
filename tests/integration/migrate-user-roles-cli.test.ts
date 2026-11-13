/**
 * 既存ユーザーのロールの移行コマンド（`pnpm migrate-user-roles`。Issue #115。ADR-0013）の結合テスト。
 * ロールを「農作業者（worker）」の 1 種類から、「管理者・一般」の 2 種類に分けたため、既存のユーザーのロールを、新しいロールに移す。
 * DynamoDB は DynamoDB Local（実際の AWS には、接続しない）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { runMigrateUserRolesCli } from '../../src/backend/runtime/migrate-user-roles-cli.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const CREATED_AT = '2026-10-09T03:00:00.000Z';

function environment(extra: Record<string, string> = {}) {
  const database = createDynamoTestDatabase();
  const options = dynamoTestClientOptions();
  const env: Record<string, string> = {
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: options.endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
    ...extra,
  };
  return { env, ready: database.ready };
}

function output() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
  };
}

/** 移行前の状態（ロール worker のユーザー 2 人と、すでに新しいロールの一般ユーザー 1 人）を作る。 */
async function seedUsers(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    for (const [userId, role] of [
      ['old-user-1', 'worker'],
      ['old-user-2', 'worker'],
      ['general-user', 'general'],
    ] as const) {
      await container.repositories.users.save({
        userId: toUserId(userId),
        userName: userId,
        role,
        createdAt: CREATED_AT,
      });
    }
  } finally {
    container.close();
  }
}

async function rolesOf(env: Record<string, string>): Promise<Record<string, string>> {
  const container = createContainer(parseConfig(env));
  try {
    const users = await container.repositories.users.list();
    return Object.fromEntries(users.map((user) => [user.userId, user.role]));
  } finally {
    container.close();
  }
}

describe('既存ユーザーのロールの移行（worker → admin）', () => {
  it('既定では、ロール worker のユーザーを、管理者（admin）に移す。ほかのユーザーは、変えない', async () => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);
    const out = output();

    const exitCode = await runMigrateUserRolesCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: ロール「worker」のユーザー 2 人を、「admin」に移しました']);
    expect(await rolesOf(env)).toEqual({
      'old-user-1': 'admin',
      'old-user-2': 'admin',
      'general-user': 'general',
    });
  });

  it('移したあとの、ユーザーの名前・作成日時などは、変えない', async () => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);

    await runMigrateUserRolesCli(env, output());

    const container = createContainer(parseConfig(env));
    try {
      expect(await container.repositories.users.get(toUserId('old-user-1'))).toMatchObject({
        userName: 'old-user-1',
        createdAt: CREATED_AT,
      });
    } finally {
      container.close();
    }
  });

  it('何度実行しても同じ（移すユーザーがなければ、何もしない）', async () => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);
    await runMigrateUserRolesCli(env, output());
    const out = output();

    const exitCode = await runMigrateUserRolesCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: ロール「worker」のユーザーは、いませんでした。何もしませんでした',
    ]);
  });

  it('MIGRATE_DRY_RUN=true なら、対象の人数を示すだけで、書き込まない', async () => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);
    const out = output();

    const exitCode = await runMigrateUserRolesCli({ ...env, MIGRATE_DRY_RUN: 'true' }, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: ロール「worker」のユーザーは、2 人います。「admin」に移します（MIGRATE_DRY_RUN=true のため、書き込んでいません）',
    ]);
    expect(await rolesOf(env)).toMatchObject({ 'old-user-1': 'worker', 'old-user-2': 'worker' });
  });

  it('移す先を、MIGRATE_TO_ROLE で指定できる（ロール定義にあるロールだけ）', async () => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);
    const out = output();

    const exitCode = await runMigrateUserRolesCli({ ...env, MIGRATE_TO_ROLE: 'general' }, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: ロール「worker」のユーザー 2 人を、「general」に移しました']);
    expect(await rolesOf(env)).toMatchObject({ 'old-user-1': 'general', 'old-user-2': 'general' });
  });

  it.each([
    ['移す先が、ロール定義にない', { MIGRATE_TO_ROLE: 'unknown-role' }, 'MIGRATE_TO_ROLE'],
    ['移す先が、移す元と同じ', { MIGRATE_FROM_ROLE: 'admin', MIGRATE_TO_ROLE: 'admin' }, '同じ'],
    [
      'データを保存しない設定（メモリ）',
      { PERSISTENCE: 'memory' },
      'PERSISTENCE=dynamodb または file',
    ],
  ])('設定の誤り（%s）は、何も書き込まず、終了コード 1 にする', async (_name, extra, message) => {
    const { env, ready } = environment();
    await ready;
    await seedUsers(env);
    const out = output();

    const exitCode = await runMigrateUserRolesCli({ ...env, ...extra }, out);

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain(message);
    expect(await rolesOf(env)).toMatchObject({ 'old-user-1': 'worker' });
  });

  it('ローカルのファイル（PERSISTENCE=file。`.local-data/store.json`）のユーザーも、同じように移せる', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smart-farm-migrate-'));
    const env = { PERSISTENCE: 'file', DATA_FILE: join(directory, 'store.json') };
    await seedUsers(env);
    const out = output();

    const exitCode = await runMigrateUserRolesCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: ロール「worker」のユーザー 2 人を、「admin」に移しました']);
    expect(await rolesOf(env)).toEqual({
      'old-user-1': 'admin',
      'old-user-2': 'admin',
      'general-user': 'general',
    });
  });

  it('DynamoDB の失敗は、エラーの名前だけを出力する（メッセージの、アカウント ID・ARN を、出力しない）', async () => {
    const { env, ready } = environment();
    await ready;
    const out = output();
    const failing = {
      repositories: {
        users: {
          list: () =>
            Promise.reject(
              Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x/y'), {
                name: 'AccessDeniedException',
              }),
            ),
        },
      },
      close: () => undefined,
    };

    const exitCode = await runMigrateUserRolesCli(env, out, {
      createContainer: () => failing as never,
    });

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('AccessDeniedException');
    expect(out.lines.join('\n')).not.toContain('123456789012');
  });
});
