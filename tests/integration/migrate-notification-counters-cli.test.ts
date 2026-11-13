/**
 * 既存の通知の移行コマンド（`pnpm migrate-notification-counters`。Issue #331。ADR-0013・ADR-0019 の D-41）の結合テスト。
 * 通知に、閲覧範囲のハウス（facilityId）がなかった以前の通知に、ハウスを補い、ハウスごとのカウンター（通知の総数・利用者ごとの既読数）を
 * 再集計する。DynamoDB は DynamoDB Local（実際の AWS には、接続しない）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NotificationIdSchema, toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { runMigrateNotificationCountersCli } from '../../src/backend/runtime/migrate-notification-counters-cli.ts';
import {
  FACILITY_2_ID,
  FACILITY_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  equipmentSet,
  secondHouseSet,
} from '../support/builders.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const USER_1 = toUserId('user-1');
const USER_2 = toUserId('user-2');

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

function legacy(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    notificationId: NotificationIdSchema.parse(id),
    kind: 'STATUS_CHANGE',
    viewpointId: 'safety',
    equipmentId: ROBOT_ID,
    status: 'ERROR',
    message: `通知 ${id}`,
    createdAt: `2026-10-09T0${id.slice(-1)}:00:00.000Z`,
    dedupKey: `key-${id}`,
    deliveries: [
      { channel: 'IN_APP', result: 'SUCCESS', attempts: 1, updatedAt: '2026-10-09T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

/**
 * 移行前の状態: 設備（ハウス 2 つ）・ユーザー 2 人・ハウスの情報（facilityId）がない通知 5 件
 * （n-1: ハウス 1 のロボット、n-2: ハウス 2 のロボット、n-3: ハウス 1 自身、n-4: 取り込みの失敗、n-5: 存在しない設備）。
 * user-1 が、n-1 を既読にした（全体のカウンターだけが、増えている）。
 */
async function seedLegacy(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    const { repositories } = container;
    for (const equipment of [...equipmentSet(), ...secondHouseSet()]) {
      await repositories.equipment.save(equipment);
    }
    for (const userId of [USER_1, USER_2]) {
      await repositories.users.save({
        userId,
        userName: userId,
        role: 'general',
        createdAt: '2026-10-09T00:00:00.000Z',
      });
    }
    await repositories.notifications.add(legacy('n-1', { equipmentId: ROBOT_ID }));
    await repositories.notifications.add(legacy('n-2', { equipmentId: ROBOT_2_ID }));
    await repositories.notifications.add(legacy('n-3', { equipmentId: FACILITY_ID }));
    await repositories.notifications.add(
      legacy('n-4', { kind: 'INGESTION_FAILURE', equipmentId: undefined, dedupKey: 'f' }),
    );
    await repositories.notifications.add(
      legacy('n-5', { equipmentId: toEquipmentId('GONE-ROBOT'), dedupKey: 'gone' }),
    );
    await repositories.notifications.markRead(
      NotificationIdSchema.parse('n-1'),
      USER_1,
      new Date(),
    );
  } finally {
    container.close();
  }
}

async function inspect(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    const { notifications } = container.repositories;
    const facilityOf = async (id: string) =>
      (await notifications.get(NotificationIdSchema.parse(id)))?.facilityId;
    return {
      facilities: {
        n1: await facilityOf('n-1'),
        n2: await facilityOf('n-2'),
        n3: await facilityOf('n-3'),
        n4: await facilityOf('n-4'),
        n5: await facilityOf('n-5'),
      },
      unread: {
        user1House1: await notifications.unreadCount(USER_1, [FACILITY_ID]),
        user1House2: await notifications.unreadCount(USER_1, [FACILITY_2_ID]),
        user2House1: await notifications.unreadCount(USER_2, [FACILITY_ID]),
        user2House2: await notifications.unreadCount(USER_2, [FACILITY_2_ID]),
        user1All: await notifications.unreadCount(USER_1),
      },
    };
  } finally {
    container.close();
  }
}

describe('既存の通知の移行（facilityId の補完と、ハウスごとのカウンターの再集計）', () => {
  it('移行前は、ハウスの情報がなく、一般ユーザーのハウスごとの未読の件数は、0（安全側）', async () => {
    const { env, ready } = environment();
    await ready;
    await seedLegacy(env);

    const state = await inspect(env);

    expect(Object.values(state.facilities)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(state.unread).toEqual({
      user1House1: 0,
      user1House2: 0,
      user2House1: 0,
      user2House2: 0,
      user1All: 4,
    });
  });

  it('通知にハウスを補い（設備のハウス。ハウス自身はその ID）、ハウスごとのカウンター（総数・既読数）を、再集計する。ハウスに属さない通知・設備が見つからない通知は、補わない', async () => {
    const { env, ready } = environment();
    await ready;
    await seedLegacy(env);
    const out = output();

    const exitCode = await runMigrateNotificationCountersCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: 通知 5 件を確認し、3 件にハウスを補いました。ハウスごとのカウンターを、再集計しました（ハウス 2 つ・利用者 2 人）',
    ]);
    const state = await inspect(env);
    expect(state.facilities).toEqual({
      n1: FACILITY_ID,
      n2: FACILITY_2_ID,
      n3: FACILITY_ID,
      n4: undefined,
      n5: undefined,
    });
    // ハウス 1 の通知は n-1・n-3 の 2 件で、user-1 は n-1 を既読にしている
    expect(state.unread).toEqual({
      user1House1: 1,
      user1House2: 1,
      user2House1: 2,
      user2House2: 1,
      user1All: 4,
    });
  });

  it('何度実行しても同じ（2 回目は、補う通知がなく、カウンターも同じ値）。移行のあとに作った通知・既読も、合う', async () => {
    const { env, ready } = environment();
    await ready;
    await seedLegacy(env);
    await runMigrateNotificationCountersCli(env, output());
    const first = await inspect(env);
    const out = output();

    const exitCode = await runMigrateNotificationCountersCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain('0 件にハウスを補いました');
    expect(await inspect(env)).toEqual(first);
    // 移行のあとに、通常の経路（既読）で変えても、カウンターが合う
    const container = createContainer(parseConfig(env));
    try {
      await container.repositories.notifications.markRead(
        NotificationIdSchema.parse('n-2'),
        USER_2,
        new Date(),
      );
      expect(await container.repositories.notifications.unreadCount(USER_2, [FACILITY_2_ID])).toBe(
        0,
      );
    } finally {
      container.close();
    }
  });

  it('MIGRATE_DRY_RUN=true なら、対象の件数を示すだけで、書き込まない', async () => {
    const { env, ready } = environment();
    await ready;
    await seedLegacy(env);
    const out = output();

    const exitCode = await runMigrateNotificationCountersCli(
      { ...env, MIGRATE_DRY_RUN: 'true' },
      out,
    );

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: 通知 5 件を確認しました。3 件にハウスを補い、ハウスごとのカウンターを再集計します（MIGRATE_DRY_RUN=true のため、書き込んでいません）',
    ]);
    expect((await inspect(env)).facilities.n1).toBeUndefined();
  });

  it('ローカルのファイル（PERSISTENCE=file）の通知にも、ハウスを補える（カウンターは、持たない）', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smart-farm-migrate-notif-'));
    const env = { PERSISTENCE: 'file', DATA_FILE: join(directory, 'store.json') };
    await seedLegacy(env);
    const out = output();

    const exitCode = await runMigrateNotificationCountersCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain('3 件にハウスを補いました');
    expect((await inspect(env)).facilities).toMatchObject({ n1: FACILITY_ID, n2: FACILITY_2_ID });
  });

  it('データを保存しない設定（メモリ）は、何も書き込まず、終了コード 1', async () => {
    const out = output();

    const exitCode = await runMigrateNotificationCountersCli({ PERSISTENCE: 'memory' }, out);

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('PERSISTENCE=dynamodb または file');
  });

  it('失敗は、エラーの名前だけを出力する（メッセージの、アカウント ID・ARN を、出力しない）', async () => {
    const { env, ready } = environment();
    await ready;
    const out = output();
    const failing = {
      repositories: {
        equipment: {
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

    const exitCode = await runMigrateNotificationCountersCli(env, out, {
      createContainer: () => failing as never,
    });

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('AccessDeniedException');
    expect(out.lines.join('\n')).not.toContain('123456789012');
  });
});
