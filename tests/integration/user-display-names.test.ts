/**
 * 入力者・変更者の表示名（Issue #154 の SC-07-7。FR-4.2.1・FR-4.2.3）の結合テスト（API）。
 * 画面の「入力者」「変更者」を「ユーザー名（ID）」で出せるよう、読み取りの応答に、表示名の項目を足す:
 * 入力データ一覧（`enteredByName`）・変更履歴（`actorName`）・判断基準（`updatedByName`）・通知のメモ（`enteredByName`）。
 * 読み取り時に、現在のユーザー名へ解決する（履歴に、変更時点の名前を保存しない）。削除済みの利用者は、項目を出さない（ID のみ）。
 * 保存データ（DB）は変えない。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { NotificationIdSchema, toUserId } from '@smart-farm/shared/schemas/common';
import { CriteriaViewSchema } from '@smart-farm/shared/schemas/criteria';
import {
  ManualEntryListResponseSchema,
  ManualEntrySaveResponseSchema,
  type ManualEntryInput,
} from '@smart-farm/shared/schemas/manual-entry';
import { NotificationMemoListResponseSchema } from '@smart-farm/shared/schemas/notification';
import { FACILITY_ID, ROBOT_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  markPasswordChanged,
  TEST_USER,
  THREE_ROLES_JSON,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

function send(context: TestContext, method: string, path: string, body?: unknown, token?: string) {
  return context.request(path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(token === undefined ? {} : { token }),
  });
}

const ENTRY: ManualEntryInput = {
  equipmentId: ROBOT_ID,
  category: 'OPERABILITY',
  observedAt: '2026-10-09T02:00:00.000Z',
  items: { operationStepCount: 4, operationMinutes: 8, operationErrorCount: 0 },
};

/** ユーザー名を、ユーザーID と別の値にする（addUserAndLogin は、ユーザー名をユーザーID と同じにするため）。 */
async function renameUser(context: TestContext, userId: string, userName: string): Promise<void> {
  const users = context.container.repositories.users;
  const user = await users.get(toUserId(userId));
  if (user === undefined) {
    throw new Error(`テストの前提: ユーザーがいます: ${userId}`);
  }
  await users.save({ ...user, userName });
}

async function entries(context: TestContext, token?: string) {
  const response = await send(context, 'GET', '/manual-entries', undefined, token);
  expect(response.status).toBe(200);
  return ManualEntryListResponseSchema.parse(await response.json()).items;
}

async function auditLogs(context: TestContext, query = '') {
  const response = await send(context, 'GET', `/audit-logs${query}`);
  expect(response.status).toBe(200);
  return AuditLogListResponseSchema.parse(await response.json()).items;
}

describe('入力データ一覧（GET /manual-entries）の入力者の表示名', () => {
  it('入力者のユーザー名を、enteredByName で返す（enteredBy は、ユーザー ID のまま）', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/manual-entries', ENTRY);

    const [entry] = await entries(context);

    expect(entry).toMatchObject({
      enteredBy: TEST_USER.userId,
      enteredByName: TEST_USER.userName,
    });
  });

  it('複数の入力者は、それぞれのユーザー名で返す', async () => {
    const context = await withEquipment();
    const other = await addUserAndLogin(context, { userId: 'general-1', role: 'general' });
    await markPasswordChanged(context, 'general-1');
    await renameUser(context, 'general-1', '一般の入力者');
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [toUserId('general-1')],
    });
    await send(context, 'POST', '/manual-entries', ENTRY);
    await send(
      context,
      'POST',
      '/manual-entries',
      { ...ENTRY, observedAt: '2026-10-09T01:00:00.000Z' },
      other,
    );

    const names = (await entries(context)).map((entry) => [entry.enteredBy, entry.enteredByName]);

    expect(names).toEqual([
      [TEST_USER.userId, TEST_USER.userName],
      ['general-1', '一般の入力者'],
    ]);
  });

  it('入力のあと、利用者がユーザー名を変えると、現在のユーザー名で返す（変更時点の名前は、保存しない）', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/manual-entries', ENTRY);
    await send(context, 'PUT', '/auth/profile', { userName: '改名後のユーザー' });

    const [entry] = await entries(context);

    expect(entry?.enteredByName).toBe('改名後のユーザー');
    const stored = await context.container.repositories.manualEntries.list(
      {},
      { limit: 10, cursor: undefined },
      { key: 'observedAt', direction: 'desc' },
    );
    expect(JSON.stringify(stored.items)).not.toContain('enteredByName');
  });

  it('入力者が削除済みの利用者なら、enteredByName を出さない（ユーザー ID のみ）', async () => {
    const context = await withEquipment();
    await addUserAndLogin(context, { userId: 'general-gone', role: 'general' });
    await context.container.repositories.manualEntries.save({
      ...ENTRY,
      entryId: 'entry-gone',
      enteredBy: toUserId('general-gone'),
      createdAt: '2026-10-09T02:30:00.000Z',
      updatedAt: '2026-10-09T02:30:00.000Z',
      isDeleted: false,
    });
    await context.container.repositories.users.delete(toUserId('general-gone'));

    const [entry] = await entries(context);

    expect(entry?.enteredBy).toBe('general-gone');
    expect(entry).not.toHaveProperty('enteredByName');
  });

  it('一般ユーザーにも、他の利用者の入力の入力者の名前を返す（手動入力は、他人の入力も見える・修正できる。ADR-0013）', async () => {
    const context = await withEquipment();
    const general = await addUserAndLogin(context, { userId: 'general-1', role: 'general' });
    await markPasswordChanged(context, 'general-1');
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [toUserId('general-1')],
    });
    await send(context, 'POST', '/manual-entries', ENTRY);

    const seen = await entries(context, general);

    expect(seen.map((entry) => entry.enteredByName)).toEqual([TEST_USER.userName]);
  });

  it('保存・修正の応答の入力は、DB の保存の形のまま（表示名を、保存しない）', async () => {
    const context = await withEquipment();
    const saved = ManualEntrySaveResponseSchema.parse(
      await (await send(context, 'POST', '/manual-entries', ENTRY)).json(),
    );

    const stored = await context.container.repositories.manualEntries.get(saved.entry.entryId);

    expect(stored).not.toHaveProperty('enteredByName');
  });
});

describe('変更履歴（GET /audit-logs）の変更者の表示名', () => {
  it('変更者のユーザー名を、actorName で返す（actor は、ユーザー ID のまま）', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/manual-entries', ENTRY);

    const [log] = await auditLogs(context);

    expect(log).toMatchObject({ actor: TEST_USER.userId, actorName: TEST_USER.userName });
  });

  it('現在のユーザー名で返す。ユーザー名を変えると、過去の履歴も、新しい名前になる', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/manual-entries', ENTRY);
    await send(context, 'PUT', '/auth/profile', { userName: '改名後のユーザー' });

    const logs = await auditLogs(context);

    // 登録（手動入力）と、ユーザー名の変更の 2 件。どちらの変更者も、現在のユーザー名
    expect(logs.map((log) => log.actorName)).toEqual(['改名後のユーザー', '改名後のユーザー']);
    const stored = await context.container.repositories.auditLogs.list(
      {},
      { limit: 10, cursor: undefined },
    );
    expect(JSON.stringify(stored.items)).not.toContain('actorName');
  });

  it('変更者が削除済みの利用者なら、actorName を出さない（ユーザー ID のみ）', async () => {
    const context = await withEquipment();
    await context.container.repositories.auditLogs.add({
      auditId: 'audit-gone',
      occurredAt: '2026-10-09T02:30:00.000Z',
      operation: 'UPDATE',
      targetType: 'equipment',
      targetId: ROBOT_ID,
      actor: toUserId('user-gone'),
    });

    const [log] = await auditLogs(context, '?actor=user-gone');

    expect(log?.actor).toBe('user-gone');
    expect(log).not.toHaveProperty('actorName');
  });

  it('履歴は管理者のみ（audit:read）。一般ユーザーは、名前の解決にかかわらず、403 のまま', async () => {
    const context = await withEquipment();
    const general = await addUserAndLogin(context, { userId: 'general-1', role: 'general' });
    await markPasswordChanged(context, 'general-1');

    const response = await send(context, 'GET', '/audit-logs', undefined, general);

    expect(response.status).toBe(403);
  });
});

describe('判断基準（GET・PUT・POST reset /viewpoints/{id}/criteria）の最終変更者の表示名', () => {
  const URL = '/viewpoints/environmentalAdaptability/criteria';

  async function currentCriteria(context: TestContext) {
    const response = await send(context, 'GET', URL);
    expect(response.status).toBe(200);
    return CriteriaViewSchema.parse(await response.json());
  }

  /** 現在の判断基準を、そのまま保存し直す（変更済みにする）。現在の版（ETag）を If-Match に付ける。 */
  async function changeCriteria(context: TestContext) {
    const response = await send(context, 'GET', URL);
    const current = CriteriaViewSchema.parse(await response.json());
    return context.request(URL, {
      method: 'PUT',
      body: { criteria: current.criteria },
      headers: { 'if-match': response.headers.get('etag') ?? '' },
    });
  }

  it('既定値（変更していない）は、最終変更者も、表示名もない', async () => {
    const context = await createTestContext();

    const view = await currentCriteria(context);

    expect(view).not.toHaveProperty('updatedBy');
    expect(view).not.toHaveProperty('updatedByName');
  });

  it('変更すると、変更の応答と、そのあとの取得に、最終変更者のユーザー名を、updatedByName で返す', async () => {
    const context = await createTestContext();

    const changed = await changeCriteria(context);
    const updated = CriteriaViewSchema.parse(await changed.json());
    const read = await currentCriteria(context);

    expect(changed.status).toBe(200);
    expect(updated).toMatchObject({
      updatedBy: TEST_USER.userId,
      updatedByName: TEST_USER.userName,
    });
    expect(read).toMatchObject({
      updatedBy: TEST_USER.userId,
      updatedByName: TEST_USER.userName,
    });
    const stored = await context.container.repositories.criteria.get(updated.viewpointId);
    expect(stored).not.toHaveProperty('updatedByName');
  });

  it('既定値へ戻した応答は、最終変更者も、表示名もない', async () => {
    const context = await createTestContext();
    await changeCriteria(context);

    const response = await context.request(`${URL}/reset`, {
      method: 'POST',
      headers: { 'if-match': (await send(context, 'GET', URL)).headers.get('etag') ?? '' },
    });

    expect(response.status).toBe(200);
    expect(CriteriaViewSchema.parse(await response.json())).not.toHaveProperty('updatedByName');
  });

  it('最終変更者が削除済みの利用者なら、updatedByName を出さない（updatedBy のみ）', async () => {
    const context = await createTestContext();
    await changeCriteria(context);
    const stored = await context.container.repositories.criteria.get(
      (await currentCriteria(context)).viewpointId,
    );
    if (stored === undefined) {
      throw new Error('テストの前提: 変更済み');
    }
    await context.container.repositories.criteria.save({
      ...stored,
      updatedBy: toUserId('user-gone'),
    });

    const view = await currentCriteria(context);

    expect(view.updatedBy).toBe('user-gone');
    expect(view).not.toHaveProperty('updatedByName');
  });
});

describe('通知のメモ（GET・POST /notifications/{id}/memos）の入力者の表示名', () => {
  /** 3 ロールの設定。評価者・閲覧者にも、全設備の閲覧（equipment:view-all）を加える（取り込み失敗の通知は、ハウスに属さない）。 */
  const ROLES_JSON = JSON.stringify(
    Object.fromEntries(
      Object.entries(
        JSON.parse(THREE_ROLES_JSON) as Record<string, { name: string; permissions: string[] }>,
      ).map(([roleId, role]) => [
        roleId,
        roleId === 'admin'
          ? role
          : { ...role, permissions: [...role.permissions, 'equipment:view-all'] },
      ]),
    ),
  );
  const ROLES_ENV = { ROLE_DEFINITIONS_JSON: ROLES_JSON, INITIAL_USER_ROLE: 'admin' };

  async function createNotification(context: TestContext): Promise<string> {
    const created = await context.container.notificationService.notifyIngestionFailure({
      sourceId: 'robot',
      sourceName: 'ロボットデータ',
      reason: '接続できません',
    });
    if (created === null) {
      throw new Error('テストの前提');
    }
    return created.notificationId;
  }

  it('追記の応答と一覧に、入力者のユーザー名を、enteredByName で返す。別の利用者が読んでも同じ', async () => {
    const context = await createTestContext({ env: ROLES_ENV });
    const id = await createNotification(context);
    const evaluator = await addUserAndLogin(context, { userId: 'worker-b', role: 'evaluator' });
    await renameUser(context, 'worker-b', '評価者B');

    const posted = await send(context, 'POST', `/notifications/${id}/memos`, {
      body: '管理者のメモ',
    });
    await send(context, 'POST', `/notifications/${id}/memos`, { body: '評価者のメモ' }, evaluator);
    const viewer = await addUserAndLogin(context, { userId: 'viewer-c', role: 'viewer' });
    const listed = NotificationMemoListResponseSchema.parse(
      await (await send(context, 'GET', `/notifications/${id}/memos`, undefined, viewer)).json(),
    );

    expect(((await posted.json()) as { enteredByName?: string }).enteredByName).toBe(
      TEST_USER.userName,
    );
    expect(listed.items.map((memo) => [memo.enteredBy, memo.enteredByName])).toEqual([
      [TEST_USER.userId, TEST_USER.userName],
      ['worker-b', '評価者B'],
    ]);
  });

  it('入力者がユーザー名を変えると、現在のユーザー名で返す。削除済みの利用者は、enteredByName を出さない', async () => {
    const context = await createTestContext({ env: ROLES_ENV });
    const id = await createNotification(context);
    const evaluator = await addUserAndLogin(context, { userId: 'worker-b', role: 'evaluator' });
    await send(context, 'POST', `/notifications/${id}/memos`, { body: '管理者のメモ' });
    await send(context, 'POST', `/notifications/${id}/memos`, { body: '評価者のメモ' }, evaluator);
    await send(context, 'PUT', '/auth/profile', { userName: '改名後の管理者' });
    await context.container.repositories.users.delete(toUserId('worker-b'));

    const listed = NotificationMemoListResponseSchema.parse(
      await (await send(context, 'GET', `/notifications/${id}/memos`)).json(),
    );

    expect(listed.items[0]?.enteredByName).toBe('改名後の管理者');
    expect(listed.items[1]?.enteredBy).toBe('worker-b');
    expect(listed.items[1]).not.toHaveProperty('enteredByName');
    const stored = await context.container.repositories.notifications.listMemos(
      NotificationIdSchema.parse(id),
    );
    expect(JSON.stringify(stored)).not.toContain('enteredByName');
  });
});
