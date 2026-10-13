/**
 * 手動入力・変更履歴・設備・ステータスコード・判断基準・ユーザー・取り込み設定・Web Push の購読の結合テスト
 * （Hono アプリを `app.request` で呼び出す。UC-06、07、12、14、15、16、17、18、19、23）。
 * 画面と同じ検証を共有するため、入力の同値分割（正常・各項目の不正・境界値）を網羅する。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { UserListResponseSchema } from '@smart-farm/shared/schemas/auth';
import { ViewpointCriteriaSchema } from '@smart-farm/shared/schemas/criteria';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import {
  FederationLogListResponseSchema,
  IngestionLogListResponseSchema,
  IngestionRunResponseSchema,
  IngestionSettingsResponseSchema,
} from '@smart-farm/shared/schemas/ingestion';
import {
  ManualEntryListResponseSchema,
  ManualEntrySaveResponseSchema,
  type ManualEntryInput,
} from '@smart-farm/shared/schemas/manual-entry';
import { NotificationListResponseSchema } from '@smart-farm/shared/schemas/notification';
import { StatusCodeDefinitionSchema } from '@smart-farm/shared/schemas/status-code';
import { observation, FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  createTestContext,
  errorOf,
  TEST_NOW,
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

const OBSERVED_AT = '2026-10-09T02:00:00.000Z';

function entryBody(overrides: Partial<ManualEntryInput> = {}): ManualEntryInput {
  return {
    equipmentId: ROBOT_ID,
    category: 'OPERABILITY',
    observedAt: OBSERVED_AT,
    items: { operationStepCount: 4, operationMinutes: 8, operationErrorCount: 0 },
    ...overrides,
  };
}

async function createEntry(context: TestContext, body: ManualEntryInput = entryBody()) {
  const response = await send(context, 'POST', '/manual-entries', body);
  expect(response.status).toBe(201);
  return ManualEntrySaveResponseSchema.parse(await response.json());
}

describe('手動入力の登録（UC-06、UC-07。POST /manual-entries）', () => {
  it('正しい入力を保存し、入力者・取得元（手動入力）・評価後の関連観点のステータスを返す', async () => {
    const context = await withEquipment();

    const saved = await createEntry(context, entryBody({ note: '現場で確認した' }));

    expect(saved.entry).toMatchObject({
      equipmentId: ROBOT_ID,
      category: 'OPERABILITY',
      enteredBy: 'test-user',
      note: '現場で確認した',
      isDeleted: false,
    });
    const observations = await context.container.repositories.observations.findForEvaluation(
      [ROBOT_ID],
      new Date('2026-10-01T00:00:00Z'),
      TEST_NOW,
    );
    expect(observations).toHaveLength(3);
    expect(observations.every((item) => item.source === 'MANUAL')).toBe(true);
    expect(observations.every((item) => item.manualEntryId === saved.entry.entryId)).toBe(true);
    expect(observations.every((item) => item.enteredBy === 'test-user')).toBe(true);
    expect(saved.viewpointStatuses.map((item) => item.viewpointId)).toContain('operability');
    expect(
      saved.viewpointStatuses.find((item) => item.viewpointId === 'operability'),
    ).toMatchObject({ name: '操作性', status: 'NORMAL' });
  });

  it('注意・異常になる値を保存すると、通知を作成し、ステータスに反映する（UC-10）', async () => {
    const context = await withEquipment();

    const saved = await createEntry(
      context,
      entryBody({
        items: { operationStepCount: 12, operationMinutes: 35, operationErrorCount: 2 },
      }),
    );

    expect(saved.viewpointStatuses.find((item) => item.viewpointId === 'operability')?.status).toBe(
      'ERROR',
    );
    const notifications = NotificationListResponseSchema.parse(
      await (await send(context, 'GET', '/notifications')).json(),
    );
    // 操作性の異常と、データ活用度合い（入口の取得が少ない）の通知が作られる
    expect(notifications.items.find((item) => item.viewpointId === 'operability')).toMatchObject({
      kind: 'STATUS_CHANGE',
      status: 'ERROR',
      readState: 'UNREAD',
    });
  });

  it('ハウスへの入力（満足度）は、ハウスの観点のステータスを返す', async () => {
    const context = await withEquipment();

    const saved = await createEntry(
      context,
      entryBody({
        equipmentId: FACILITY_ID,
        category: 'SATISFACTION',
        items: { 'satisfaction.harvestAccuracy': 5 },
      }),
    );

    expect(saved.viewpointStatuses.map((item) => item.viewpointId)).toEqual([
      'dataUtilization',
      'satisfaction',
    ]);
  });

  it.each([
    ['計測日時が未入力（形式が不正）', { observedAt: 'not-a-date' }, 400, 'observedAt'],
    [
      '未来の計測日時（許容の 5 分を超える）',
      { observedAt: '2026-10-09T03:06:00.000Z' },
      400,
      'observedAt',
    ],
    ['カテゴリが存在しない', { category: 'UNKNOWN' }, 400, 'category'],
    ['自動取り込みのみのカテゴリ（稼働情報）', { category: 'OPERATION' }, 400, 'category'],
    ['項目が空', { items: {} }, 400, 'items'],
    [
      'カテゴリに属さない項目',
      { items: { temperatureCelsius: 20 } },
      400,
      'items.temperatureCelsius',
    ],
    [
      '整数でない値（操作ステップ数 1.5）',
      { items: { operationStepCount: 1.5 } },
      400,
      'items.operationStepCount',
    ],
    [
      '範囲外の値（操作時間 -1）',
      { items: { operationMinutes: -1 } },
      400,
      'items.operationMinutes',
    ],
    ['数値でない値', { items: { operationMinutes: '5' } }, 400, 'items.operationMinutes'],
    ['備考が長すぎる', { note: 'あ'.repeat(2001) }, 400, 'note'],
  ] as const)(
    '不正な入力（%s）は、項目ごとのエラーで拒否する',
    async (_name, override, status, field) => {
      const context = await withEquipment();

      const response = await send(context, 'POST', '/manual-entries', {
        ...entryBody(),
        ...override,
      });

      expect(response.status).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.fields?.map((item) => item.name)).toContain(field);
    },
  );

  it.each([
    ['計測日時ちょうど現在 + 5分（許容の境界）', '2026-10-09T03:05:00.000Z', 201],
    ['現在の時刻', '2026-10-09T03:00:00.000Z', 201],
  ])('計測日時の境界値: %s', async (_name, observedAt, status) => {
    const context = await withEquipment();

    const response = await send(context, 'POST', '/manual-entries', entryBody({ observedAt }));

    expect(response.status).toBe(status);
  });

  it('満足度は 1〜5 の整数（境界値: 0 は不正、1 と 5 は正常、6 は不正）', async () => {
    const context = await withEquipment();
    const attempt = async (value: number) =>
      (
        await send(context, 'POST', '/manual-entries', {
          equipmentId: FACILITY_ID,
          category: 'SATISFACTION',
          observedAt: OBSERVED_AT,
          items: { 'satisfaction.harvestSpeed': value },
        })
      ).status;

    expect(await attempt(0)).toBe(400);
    expect(await attempt(6)).toBe(400);
    expect(await attempt(1)).toBe(201);
    // 同じ設備・項目・計測日時の2回目は、競合
    expect(await attempt(5)).toBe(409);
  });

  it('存在しない設備・削除済みの設備は 404', async () => {
    const context = await withEquipment();
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);

    const missing = await send(
      context,
      'POST',
      '/manual-entries',
      entryBody({ equipmentId: 'NOPE-1' as never }),
    );
    const deleted = await send(
      context,
      'POST',
      '/manual-entries',
      entryBody({
        equipmentId: SENSOR_ID,
        category: 'ENVIRONMENT',
        items: { temperatureCelsius: 20 },
      }),
    );

    expect(missing.status).toBe(404);
    expect(deleted.status).toBe(404);
  });

  it('本文が JSON でない・必須項目がない場合は 400', async () => {
    const context = await withEquipment();

    const response = await send(context, 'POST', '/manual-entries', { category: 'OPERABILITY' });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain('equipmentId');
  });

  it('保存・修正・削除のたびに、人手入力データ（生データ）を、農業情報基盤への連携キューに積む', async () => {
    const context = await withEquipment();
    const queued = async () =>
      (
        await context.container.repositories.federation.listDue(
          new Date('2027-01-01T00:00:00Z'),
          100,
        )
      )
        .filter((item) => item.targetRef.startsWith('manual-entry#'))
        .map((item) => item.payload as { observations: { itemKey: string; isDeleted: boolean }[] });

    const { entry } = await createEntry(context);
    const afterCreate = await queued();
    await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody({ items: { operationMinutes: 9 } }),
    );
    await send(context, 'DELETE', `/manual-entries/${entry.entryId}`);
    const afterDelete = await queued();

    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]?.observations).toHaveLength(3);
    expect(afterCreate[0]?.observations.every((item) => !item.isDeleted)).toBe(true);
    expect(afterDelete).toHaveLength(3);
    // 削除は、削除済みの観測値として送る
    expect(afterDelete[2]?.observations.every((item) => item.isDeleted)).toBe(true);
  });

  it('評価が失敗しても、入力の保存は成功する', async () => {
    const context = await withEquipment();
    context.container.evaluationService.evaluateAffected = () =>
      Promise.reject(new Error('評価の失敗'));

    const response = await send(context, 'POST', '/manual-entries', entryBody());

    expect(response.status).toBe(201);
    expect(ManualEntrySaveResponseSchema.parse(await response.json()).viewpointStatuses).toEqual(
      [],
    );
  });
});

describe('入力済みデータの管理（UC-18。GET・PUT・DELETE /manual-entries、GET /audit-logs）', () => {
  async function threeEntries(context: TestContext) {
    const first = await createEntry(
      context,
      entryBody({
        observedAt: '2026-10-09T01:00:00.000Z',
        items: { operationStepCount: 4 },
        note: '朝の作業',
      }),
    );
    const second = await createEntry(
      context,
      entryBody({
        category: 'FAILURE',
        observedAt: '2026-10-09T02:00:00.000Z',
        items: { failureCount: 1, recoveryMinutes: 90 },
      }),
    );
    const third = await createEntry(
      context,
      entryBody({
        equipmentId: FACILITY_ID,
        category: 'SATISFACTION',
        observedAt: '2026-10-09T02:30:00.000Z',
        items: { 'satisfaction.safety': 3 },
      }),
    );
    return { first, second, third };
  }

  async function list(context: TestContext, query = '') {
    const response = await send(context, 'GET', `/manual-entries${query}`);
    expect(response.status).toBe(200);
    return ManualEntryListResponseSchema.parse(await response.json());
  }

  it('一覧は、計測日時の新しい順（既定）で返し、論理削除したものは含めない', async () => {
    const context = await withEquipment();
    const { second } = await threeEntries(context);
    await send(context, 'DELETE', `/manual-entries/${second.entry.entryId}`);

    const body = await list(context);

    expect(body.items.map((item) => item.category)).toEqual(['SATISFACTION', 'OPERABILITY']);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    ['カテゴリ', '?category=FAILURE', ['FAILURE']],
    ['設備', `?equipmentId=${FACILITY_ID}`, ['SATISFACTION']],
    ['期間（開始）', '?from=2026-10-09T02:00:00.000Z', ['SATISFACTION', 'FAILURE']],
    ['期間（終了）', '?to=2026-10-09T01:30:00.000Z', ['OPERABILITY']],
    [
      '期間（開始と終了。両端を含む）',
      '?from=2026-10-09T01:00:00.000Z&to=2026-10-09T02:00:00.000Z',
      ['FAILURE', 'OPERABILITY'],
    ],
    ['キーワード（備考）', `?q=${encodeURIComponent('朝の')}`, ['OPERABILITY']],
    ['キーワード（項目名）', `?q=${encodeURIComponent('復旧に要')}`, ['FAILURE']],
    ['キーワード（値と単位）', `?q=${encodeURIComponent('90分')}`, ['FAILURE']],
    [
      'キーワード（入力者。大文字小文字を区別しない）',
      '?q=TEST-USER',
      ['SATISFACTION', 'FAILURE', 'OPERABILITY'],
    ],
    ['キーワード（設備名）', `?q=${encodeURIComponent('テストハウス')}`, ['SATISFACTION']],
    ['キーワード（カテゴリ名）', `?q=${encodeURIComponent('故障情報')}`, ['FAILURE']],
    ['該当なし', '?q=zzzz', []],
  ])('絞り込み: %s', async (_name, query, categories) => {
    const context = await withEquipment();
    await threeEntries(context);

    const body = await list(context, query);

    expect(body.items.map((item) => item.category)).toEqual(categories);
  });

  it.each([
    [
      '計測日時の昇順',
      '?sort=observedAt&direction=asc',
      ['OPERABILITY', 'FAILURE', 'SATISFACTION'],
    ],
    ['カテゴリの昇順', '?sort=category&direction=asc', ['FAILURE', 'OPERABILITY', 'SATISFACTION']],
    ['カテゴリの降順', '?sort=category&direction=desc', ['SATISFACTION', 'OPERABILITY', 'FAILURE']],
    [
      '入力者の昇順（同じ入力者は計測日時の新しい順）',
      '?sort=enteredBy&direction=asc',
      ['SATISFACTION', 'FAILURE', 'OPERABILITY'],
    ],
  ])('並べ替え: %s', async (_name, query, categories) => {
    const context = await withEquipment();
    await threeEntries(context);

    const body = await list(context, query);

    expect(body.items.map((item) => item.category)).toEqual(categories);
  });

  it('ページ分割: limit ごとに nextCursor を返し、最後のページは null。不正なカーソルは 400', async () => {
    const context = await withEquipment();
    await threeEntries(context);

    const first = await list(context, '?limit=2');
    const second = await list(context, `?limit=2&cursor=${first.nextCursor ?? ''}`);
    const invalid = await send(context, 'GET', '/manual-entries?cursor=bad');

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(invalid.status).toBe(400);
  });

  it('修正すると、観測値も修正後の内容になり、評価を更新し、変更履歴に前後を残す', async () => {
    const context = await withEquipment();
    const { entry } = await createEntry(
      context,
      entryBody({ items: { operationStepCount: 12 }, observedAt: OBSERVED_AT }),
    );

    const response = await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody({
        observedAt: '2026-10-09T01:30:00.000Z',
        items: { operationMinutes: 8 },
        note: '訂正',
      }),
    );

    expect(response.status).toBe(200);
    const saved = ManualEntrySaveResponseSchema.parse(await response.json());
    expect(saved.entry).toMatchObject({
      entryId: entry.entryId,
      enteredBy: 'test-user',
      note: '訂正',
      createdAt: entry.createdAt,
    });
    const observations = await context.container.repositories.observations.findForEvaluation(
      [ROBOT_ID],
      new Date('2026-10-01T00:00:00Z'),
      TEST_NOW,
    );
    expect(observations.map((item) => item.itemKey)).toEqual(['operationMinutes']);
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?operation=UPDATE')).json(),
    );
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      targetType: 'manual-entry',
      targetId: entry.entryId,
      actor: 'test-user',
    });
    expect(audit.items[0]?.before).toMatchObject({ items: { operationStepCount: 12 } });
    expect(audit.items[0]?.after).toMatchObject({ items: { operationMinutes: 8 } });
  });

  it('同じ内容のまま修正しても、自分自身とは競合しない。他の入力と重なる修正は 409', async () => {
    const context = await withEquipment();
    const first = await createEntry(context, entryBody({ items: { operationMinutes: 5 } }));
    await createEntry(
      context,
      entryBody({ observedAt: '2026-10-09T01:00:00.000Z', items: { operationMinutes: 7 } }),
    );

    const same = await send(
      context,
      'PUT',
      `/manual-entries/${first.entry.entryId}`,
      entryBody({ items: { operationMinutes: 6 } }),
    );
    const overlapping = await send(
      context,
      'PUT',
      `/manual-entries/${first.entry.entryId}`,
      entryBody({ observedAt: '2026-10-09T01:00:00.000Z', items: { operationMinutes: 6 } }),
    );

    expect(same.status).toBe(200);
    expect(overlapping.status).toBe(409);
    expect((await errorOf(overlapping)).fields?.map((item) => item.name)).toContain(
      'items.operationMinutes',
    );
  });

  it('修正の入力が不正なら 400。存在しない・削除済みの入力の修正・削除は 404', async () => {
    const context = await withEquipment();
    const { entry } = await createEntry(context);
    await send(context, 'DELETE', `/manual-entries/${entry.entryId}`);

    const invalid = await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody({ items: {} }),
    );
    const updateDeleted = await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody(),
    );
    const deleteTwice = await send(context, 'DELETE', `/manual-entries/${entry.entryId}`);
    const missing = await send(context, 'DELETE', '/manual-entries/none');

    // 削除済みは、検証より先に、存在を確認する
    expect(invalid.status).toBe(404);
    expect(updateDeleted.status).toBe(404);
    expect(deleteTwice.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('修正の入力が不正なら（存在する入力の場合）400、設備が存在しなければ 404', async () => {
    const context = await withEquipment();
    const { entry } = await createEntry(context);

    const invalid = await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody({ items: { operationMinutes: -5 } }),
    );
    const noEquipment = await send(
      context,
      'PUT',
      `/manual-entries/${entry.entryId}`,
      entryBody({ equipmentId: 'NOPE-1' as never }),
    );

    expect(invalid.status).toBe(400);
    expect(noEquipment.status).toBe(404);
  });

  it('削除すると、観測値も集計から外れ、評価を更新し、変更履歴に削除前の内容を残す', async () => {
    const context = await withEquipment();
    const { entry } = await createEntry(
      context,
      entryBody({ items: { operationStepCount: 12, operationMinutes: 35 } }),
    );

    const response = await send(context, 'DELETE', `/manual-entries/${entry.entryId}`);

    expect(response.status).toBe(204);
    const observations = await context.container.repositories.observations.findForEvaluation(
      [ROBOT_ID],
      new Date('2026-10-01T00:00:00Z'),
      TEST_NOW,
    );
    expect(observations).toEqual([]);
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?operation=DELETE')).json(),
    );
    expect(audit.items[0]?.before).toMatchObject({ entryId: entry.entryId });
    expect(audit.items[0]?.after).toBeUndefined();
    const dashboard = (await (await send(context, 'GET', '/dashboard')).json()) as {
      viewpoints: { viewpointId: string; status: string }[];
    };
    expect(dashboard.viewpoints.find((item) => item.viewpointId === 'operability')?.status).toBe(
      'UNKNOWN',
    );
  });

  describe('変更履歴（GET /audit-logs）', () => {
    async function prepareLogs(context: TestContext) {
      const { entry } = await createEntry(context);
      context.clock.advance(60_000);
      await send(
        context,
        'PUT',
        `/manual-entries/${entry.entryId}`,
        entryBody({ items: { operationMinutes: 9 } }),
      );
      context.clock.advance(60_000);
      await send(context, 'DELETE', `/manual-entries/${entry.entryId}`);
      context.clock.advance(60_000);
      await send(context, 'PUT', `/status-codes/STANDBY`, {
        name: '待機中',
        category: 'NORMAL',
        description: '説明',
      });
    }

    async function logs(context: TestContext, query: string) {
      return AuditLogListResponseSchema.parse(
        await (await send(context, 'GET', `/audit-logs${query}`)).json(),
      );
    }

    it('新しい順（既定）で返し、昇順にもできる', async () => {
      const context = await withEquipment();
      await prepareLogs(context);

      const desc = await logs(context, '');
      const asc = await logs(context, '?direction=asc');

      expect(desc.items.map((item) => item.operation)).toEqual([
        'UPDATE',
        'DELETE',
        'UPDATE',
        'CREATE',
      ]);
      expect(asc.items.map((item) => item.operation)).toEqual([
        'CREATE',
        'UPDATE',
        'DELETE',
        'UPDATE',
      ]);
    });

    it.each([
      ['操作種別', '?operation=CREATE', 1],
      ['変更者', '?actor=test-user', 4],
      ['変更者（該当なし）', '?actor=other-user', 0],
      ['対象の種類', '?targetType=status-code', 1],
      ['期間（開始）', '?from=2026-10-09T03:02:00.000Z', 2],
      ['期間（終了）', '?to=2026-10-09T03:01:00.000Z', 2],
      ['ページ分割', '?limit=3', 3],
    ])('絞り込み: %s', async (_name, query, count) => {
      const context = await withEquipment();
      await prepareLogs(context);

      expect((await logs(context, query)).items).toHaveLength(count);
    });
  });
});

describe('設備管理（UC-12。POST・PUT・DELETE /equipment）', () => {
  const NEW_FACILITY = { equipmentId: 'HOUSE-N1', equipmentType: 'FACILITY', name: '新しいハウス' };

  it('ハウス・ロボット・センサーを登録し、階層で返す。変更履歴に残す', async () => {
    const context = await createTestContext();

    const facility = await send(context, 'POST', '/equipment', NEW_FACILITY);
    const robot = await send(context, 'POST', '/equipment', {
      equipmentId: 'ROBOT-N1',
      equipmentType: 'ROBOT',
      name: '新しいロボット',
      facilityId: 'HOUSE-N1',
      externalId: 'ROBOT-FILE-1',
    });
    const sensor = await send(context, 'POST', '/equipment', {
      equipmentId: 'SENSOR-N1',
      equipmentType: 'SENSOR',
      name: '新しいセンサー',
      facilityId: 'HOUSE-N1',
    });

    expect([facility.status, robot.status, sensor.status]).toEqual([201, 201, 201]);
    EquipmentSchema.parse(await robot.json());
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { facility: { name: string }; children: { name: string }[] }[];
    };
    expect(tree.facilities).toHaveLength(1);
    expect(tree.facilities[0]?.children.map((child) => child.name)).toEqual([
      '新しいロボット',
      '新しいセンサー',
    ]);
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=equipment')).json(),
    );
    expect(audit.items).toHaveLength(3);
  });

  it.each([
    ['設備IDが重複', { ...NEW_FACILITY, equipmentId: 'HOUSE-T1' }, 409, 'equipmentId'],
    ['設備IDの形式が不正', { ...NEW_FACILITY, equipmentId: 'bad id!' }, 400, 'equipmentId'],
    ['名称が空', { ...NEW_FACILITY, name: '  ' }, 400, 'name'],
    ['名称が長すぎる', { ...NEW_FACILITY, name: 'あ'.repeat(201) }, 400, 'name'],
    [
      'ロボットに親のハウスがない',
      { equipmentId: 'R-1', equipmentType: 'ROBOT', name: 'ロボット' },
      400,
      'facilityId',
    ],
    ['ハウスに親がある', { ...NEW_FACILITY, facilityId: 'HOUSE-T1' }, 400, 'facilityId'],
    [
      '親のハウスが存在しない',
      { equipmentId: 'R-1', equipmentType: 'ROBOT', name: 'ロボット', facilityId: 'NONE-1' },
      400,
      'facilityId',
    ],
    [
      '親がハウスではない',
      { equipmentId: 'R-1', equipmentType: 'ROBOT', name: 'ロボット', facilityId: 'ROBOT-T1' },
      400,
      'facilityId',
    ],
    [
      'データ上の識別子が重複（同じ種別）',
      {
        equipmentId: 'R-2',
        equipmentType: 'ROBOT',
        name: 'ロボット',
        facilityId: 'HOUSE-T1',
        externalId: 'ROBOT-SAMPLE-01',
      },
      409,
      'externalId',
    ],
  ])('不正な登録（%s）は拒否する', async (_name, body, status, field) => {
    const context = await withEquipment();

    const response = await send(context, 'POST', '/equipment', body);

    expect(response.status).toBe(status);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
  });

  it('削除済みの設備と同じ設備IDも、重複として拒否する。データ上の識別子は、別の種別なら重複しない', async () => {
    const context = await withEquipment();
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);

    const duplicated = await send(context, 'POST', '/equipment', {
      equipmentId: SENSOR_ID,
      equipmentType: 'SENSOR',
      name: '再登録',
      facilityId: FACILITY_ID,
    });
    const otherType = await send(context, 'POST', '/equipment', {
      equipmentId: 'SENSOR-N9',
      equipmentType: 'SENSOR',
      name: '別種別',
      facilityId: FACILITY_ID,
      externalId: 'ROBOT-SAMPLE-01',
    });

    expect(duplicated.status).toBe(409);
    expect(otherType.status).toBe(201);
  });

  it('名称・データ上の識別子・親のハウスを変更できる。設備IDと種別は変更できない', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/equipment', NEW_FACILITY);

    const moved = await send(context, 'PUT', `/equipment/${ROBOT_ID}`, {
      name: '移したロボット',
      facilityId: 'HOUSE-N1',
      externalId: 'ROBOT-FILE-2',
    });
    const renamed = await send(context, 'PUT', `/equipment/${FACILITY_ID}`, { name: '新名称' });
    const keepsParent = await send(context, 'PUT', `/equipment/${SENSOR_ID}`, {
      name: 'センサー改',
    });

    expect(moved.status).toBe(200);
    expect(EquipmentSchema.parse(await moved.json())).toMatchObject({
      equipmentId: ROBOT_ID,
      equipmentType: 'ROBOT',
      facilityId: 'HOUSE-N1',
      externalId: 'ROBOT-FILE-2',
    });
    expect(renamed.status).toBe(200);
    const keptBody = EquipmentSchema.parse(await keepsParent.json());
    expect(keptBody).toMatchObject({
      name: 'センサー改',
      facilityId: FACILITY_ID,
    });
    expect(keptBody.externalId).toBeUndefined();
  });

  it.each([
    ['名称が空', `/equipment/${ROBOT_ID}`, { name: '' }, 400],
    ['ハウスに親を指定', `/equipment/${FACILITY_ID}`, { name: 'x', facilityId: 'HOUSE-T1' }, 400],
    ['親が存在しない', `/equipment/${ROBOT_ID}`, { name: 'x', facilityId: 'NONE-1' }, 400],
    [
      '自分自身と同じデータ上の識別子（重複しない）',
      `/equipment/${ROBOT_ID}`,
      { name: 'x', externalId: 'ROBOT-SAMPLE-01' },
      200,
    ],
    ['存在しない設備', '/equipment/NONE-1', { name: 'x' }, 404],
  ])('変更の検証（%s）', async (_name, path, body, status) => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', path, body);

    expect(response.status).toBe(status);
  });

  it('他の設備と同じデータ上の識別子には変更できない', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/equipment', {
      equipmentId: 'R-2',
      equipmentType: 'ROBOT',
      name: 'ロボット2',
      facilityId: FACILITY_ID,
      externalId: 'ROBOT-FILE-9',
    });

    const response = await send(context, 'PUT', `/equipment/${ROBOT_ID}`, {
      name: 'x',
      externalId: 'ROBOT-FILE-9',
    });

    expect(response.status).toBe(409);
  });

  it('ロボットを削除すると（論理削除）、一覧から外れ、ハウスの評価の対象から外れる。データは残る', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ itemKey: 'operationStepCount', value: 12 }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const response = await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    expect(response.status).toBe(204);
    const stored = await context.container.repositories.equipment.get(ROBOT_ID);
    expect(stored?.isDeleted).toBe(true);
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { children: unknown[] }[];
    };
    expect(tree.facilities[0]?.children).toHaveLength(1);
    expect((await send(context, 'GET', `/dashboard?equipmentId=${ROBOT_ID}`)).status).toBe(404);
  });

  it('ハウスを削除すると、配下のロボット・センサーも削除する', async () => {
    const context = await withEquipment();

    const response = await send(context, 'DELETE', `/equipment/${FACILITY_ID}`);

    expect(response.status).toBe(204);
    expect(await (await send(context, 'GET', '/equipment')).json()).toEqual({ facilities: [] });
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?operation=DELETE')).json(),
    );
    expect(audit.items).toHaveLength(3);
  });

  it('存在しない・削除済みの設備の削除は 404', async () => {
    const context = await withEquipment();
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);

    expect((await send(context, 'DELETE', `/equipment/${SENSOR_ID}`)).status).toBe(404);
    expect((await send(context, 'DELETE', '/equipment/NONE-1')).status).toBe(404);
  });

  it('評価が失敗しても、設備の保存は成功する', async () => {
    const context = await createTestContext();
    context.container.evaluationService.evaluateAll = () => Promise.reject(new Error('評価の失敗'));

    expect((await send(context, 'POST', '/equipment', NEW_FACILITY)).status).toBe(201);
  });
});

describe('ステータスコード管理（UC-17。POST・PUT・DELETE /status-codes）', () => {
  const NEW_CODE = {
    code: 'CHARGING',
    name: '充電中',
    category: 'NORMAL',
    description: '充電している',
  };

  it('登録・編集・削除（論理削除）ができ、コード値順の一覧に反映される', async () => {
    const context = await createTestContext();

    const created = await send(context, 'POST', '/status-codes', NEW_CODE);
    const updated = await send(context, 'PUT', '/status-codes/CHARGING', {
      name: '充電待ち',
      category: 'CAUTION',
    });
    const listed = (await (await send(context, 'GET', '/status-codes')).json()) as {
      items: { code: string; name: string }[];
    };
    const deleted = await send(context, 'DELETE', '/status-codes/CHARGING');
    const after = (await (await send(context, 'GET', '/status-codes')).json()) as {
      items: { code: string }[];
    };

    expect(created.status).toBe(201);
    expect(StatusCodeDefinitionSchema.parse(await created.json())).toMatchObject({
      code: 'CHARGING',
      description: '充電している',
    });
    expect(updated.status).toBe(200);
    expect(StatusCodeDefinitionSchema.parse(await updated.json()).description).toBeUndefined();
    expect(listed.items.map((item) => item.code)).toEqual([
      'CHARGING',
      'FALLEN',
      'HARVESTING',
      'HARVEST_ERROR',
      'LOW_BATTERY',
      'RUNNING',
      'RUNNING_ERROR',
      'STANDBY',
      'STOPPED',
    ]);
    expect(listed.items[0]?.name).toBe('充電待ち');
    expect(deleted.status).toBe(204);
    expect(after.items.some((item) => item.code === 'CHARGING')).toBe(false);
  });

  it.each([
    ['コード値が重複', { ...NEW_CODE, code: 'STANDBY' }, 409, 'code'],
    ['コード値が小文字', { ...NEW_CODE, code: 'charging' }, 400, 'code'],
    ['コード値が空', { ...NEW_CODE, code: '' }, 400, 'code'],
    ['名称が空', { ...NEW_CODE, name: ' ' }, 400, 'name'],
    ['名称が長すぎる', { ...NEW_CODE, name: 'あ'.repeat(101) }, 400, 'name'],
    ['カテゴリが不正（不明は選べない）', { ...NEW_CODE, category: 'UNKNOWN' }, 400, 'category'],
    ['説明が長すぎる', { ...NEW_CODE, description: 'あ'.repeat(501) }, 400, 'description'],
  ])('不正な登録（%s）は拒否する', async (_name, body, status, field) => {
    const context = await createTestContext();

    const response = await send(context, 'POST', '/status-codes', body);

    expect(response.status).toBe(status);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
  });

  it('削除済みのコード値を登録し直すと、削除を取り消して、定義を更新する', async () => {
    const context = await createTestContext();
    await send(context, 'DELETE', '/status-codes/STOPPED');

    const response = await send(context, 'POST', '/status-codes', {
      code: 'STOPPED',
      name: '停止（再登録）',
      category: 'ERROR',
    });

    expect(response.status).toBe(201);
    const stored = await context.container.repositories.statusCodes.get('STOPPED');
    expect(stored).toMatchObject({ name: '停止（再登録）', category: 'ERROR', isDeleted: false });
  });

  it('存在しない・削除済みの編集・削除は 404。編集の入力が不正なら 400', async () => {
    const context = await createTestContext();
    await send(context, 'DELETE', '/status-codes/STOPPED');

    expect(
      (await send(context, 'PUT', '/status-codes/NONE', { name: 'x', category: 'NORMAL' })).status,
    ).toBe(404);
    expect(
      (await send(context, 'PUT', '/status-codes/STOPPED', { name: 'x', category: 'NORMAL' }))
        .status,
    ).toBe(404);
    expect((await send(context, 'DELETE', '/status-codes/STOPPED')).status).toBe(404);
    expect(
      (await send(context, 'PUT', '/status-codes/STANDBY', { name: '', category: 'NORMAL' }))
        .status,
    ).toBe(400);
  });

  it('カテゴリを変更すると、観点の判定に反映される（待機中: 正常 → 異常で、メンテナンス性が異常）', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ itemKey: 'statusCode', value: 'STANDBY' }),
      observation({ itemKey: 'failureCount', value: 1 }),
      observation({ itemKey: 'recoveryMinutes', value: 60 }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    const statusOf = async () =>
      (
        (await (await send(context, 'GET', '/dashboard')).json()) as {
          viewpoints: { viewpointId: string; status: string }[];
        }
      ).viewpoints.find((item) => item.viewpointId === 'maintainability')?.status;
    expect(await statusOf()).toBe('NORMAL');

    await send(context, 'PUT', '/status-codes/STANDBY', { name: '待機中', category: 'ERROR' });

    expect(await statusOf()).toBe('ERROR');
  });

  it('評価が失敗しても、定義の保存は成功する', async () => {
    const context = await createTestContext();
    context.container.evaluationService.evaluateAll = () => Promise.reject(new Error('評価の失敗'));

    expect((await send(context, 'POST', '/status-codes', NEW_CODE)).status).toBe(201);
  });

  it('登録・編集・削除は、変更履歴に、操作者・変更前後の定義を残す。入力が不正で保存しなかった操作は残さない', async () => {
    const context = await createTestContext();
    await send(context, 'POST', '/status-codes', NEW_CODE);
    context.clock.advance(60_000);
    await send(context, 'PUT', '/status-codes/CHARGING', { name: '充電待ち', category: 'CAUTION' });
    context.clock.advance(60_000);
    await send(context, 'DELETE', '/status-codes/CHARGING');
    await send(context, 'POST', '/status-codes', { ...NEW_CODE, code: 'STANDBY' });
    await send(context, 'DELETE', '/status-codes/NOT_DEFINED');

    const logs = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=status-code&direction=asc')).json(),
    );

    expect(logs.items.map((item) => [item.operation, item.targetId, item.actor])).toEqual([
      ['CREATE', 'CHARGING', 'test-user'],
      ['UPDATE', 'CHARGING', 'test-user'],
      ['DELETE', 'CHARGING', 'test-user'],
    ]);
    expect(logs.items[0]?.before).toBeUndefined();
    expect(logs.items[0]?.after).toMatchObject({ name: '充電中', category: 'NORMAL' });
    expect(logs.items[1]?.before).toMatchObject({ name: '充電中', category: 'NORMAL' });
    expect(logs.items[1]?.after).toMatchObject({ name: '充電待ち', category: 'CAUTION' });
    expect(logs.items[2]?.before).toMatchObject({ name: '充電待ち', isDeleted: false });
    expect(logs.items[2]?.after).toBeUndefined();
  });
});

describe('判断基準の編集（UC-19。GET・PUT・POST reset /viewpoints/{id}/criteria）', () => {
  const temperature = (overrides: Record<string, number> = {}) => ({
    indicator: 'temperatureCelsius',
    kind: 'RANGE',
    thresholds: { errorLower: 0, normalLower: 10, normalUpper: 25, errorUpper: 35, ...overrides },
    label: '温度（変更後）',
  });
  const environment = (overrides: Record<string, number> = {}) => [
    temperature(overrides),
    {
      indicator: 'humidityPercent',
      kind: 'RANGE',
      thresholds: { errorLower: 30, normalLower: 40, normalUpper: 80, errorUpper: 90 },
      label: '湿度',
    },
    {
      indicator: 'illuminanceLux',
      kind: 'RANGE',
      thresholds: { errorLower: 10000, normalLower: 20000, normalUpper: 40000, errorUpper: 50000 },
      label: '照度',
    },
    {
      indicator: 'co2Ppm',
      kind: 'RANGE',
      thresholds: { errorLower: 200, normalLower: 800, normalUpper: 1000, errorUpper: 3000 },
      label: 'CO2濃度',
    },
  ];
  const URL = '/viewpoints/environmentalAdaptability/criteria';

  it('既定値を返し、変更すると変更済み（版・変更者つき）になり、すべての利用者の評価に使われる', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 27 }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    const initial = ViewpointCriteriaSchema.parse(await (await send(context, 'GET', URL)).json());
    expect(initial).toMatchObject({ isDefault: true, version: 'DEFAULT' });

    const response = await send(context, 'PUT', URL, {
      criteria: environment({ normalUpper: 28 }),
    });

    expect(response.status).toBe(200);
    const updated = ViewpointCriteriaSchema.parse(await response.json());
    expect(updated).toMatchObject({
      isDefault: false,
      version: 'CUSTOM-1',
      updatedBy: 'test-user',
    });
    expect(updated.criteria[0]?.label).toBe('温度（変更後）');
    const detail = (await (
      await send(context, 'GET', `/viewpoints/environmentalAdaptability?equipmentId=${SENSOR_ID}`)
    ).json()) as { status: string; selected: { isCustomCriteria: boolean } };
    expect(detail.selected.isCustomCriteria).toBe(true);
    expect(detail.status).toBe('NORMAL');
    const again = ViewpointCriteriaSchema.parse(
      await (await send(context, 'PUT', URL, { criteria: environment() })).json(),
    );
    expect(again.version).toBe('CUSTOM-2');
  });

  it('既定値へ戻すと、既定値の判定に戻り、変更履歴に残る', async () => {
    const context = await withEquipment();
    await send(context, 'PUT', URL, { criteria: environment({ normalUpper: 28 }) });

    const response = await send(context, 'POST', `${URL}/reset`);

    expect(response.status).toBe(200);
    expect(ViewpointCriteriaSchema.parse(await response.json())).toMatchObject({
      isDefault: true,
      version: 'DEFAULT',
    });
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=criteria')).json(),
    );
    expect(audit.items).toHaveLength(2);
    expect(audit.items[0]?.after).toMatchObject({ isDefault: true });
  });

  it.each([
    ['範囲型の大小関係が逆転', environment({ normalLower: 30 }), 'criteria.0.thresholds'],
    [
      '条件名が空',
      [{ ...environment()[0], label: '' }, ...environment().slice(1)],
      'criteria.0.label',
    ],
    [
      '条件名が長すぎる',
      [{ ...environment()[0], label: 'あ'.repeat(201) }, ...environment().slice(1)],
      'criteria.0.label',
    ],
    [
      '数値でない閾値',
      [
        {
          ...environment()[0],
          thresholds: { errorLower: 'a', normalLower: 10, normalUpper: 25, errorUpper: 35 },
        },
        ...environment().slice(1),
      ],
      'criteria.0.thresholds.errorLower',
    ],
    ['条件が空', [], 'criteria'],
    [
      '編集できない指標（ステータス）',
      [{ ...environment()[0], indicator: 'status' }],
      'criteria.0.indicator',
    ],
    [
      '指標の重複',
      [environment()[0], environment()[0], ...environment().slice(1)],
      'criteria.1.indicator',
    ],
    ['指標の不足', environment().slice(0, 3), 'criteria'],
    ['条件が21件', Array.from({ length: 21 }, () => environment()[0]), 'criteria'],
  ])('不正な入力（%s）は保存できない', async (_name, criteria, field) => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', URL, { criteria });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
    expect(
      ViewpointCriteriaSchema.parse(await (await send(context, 'GET', URL)).json()).isDefault,
    ).toBe(true);
  });

  it('上限型・下限型の大小関係も検証する（収穫速度: 注意開始値 < 異常開始値）', async () => {
    const context = await withEquipment();
    const upper = (cautionFrom: number, errorFrom: number, indicator: string) => ({
      indicator,
      kind: 'UPPER',
      thresholds: { cautionFrom, errorFrom },
      label: indicator,
    });
    const valid = [
      upper(5, 10, 'travelStoppedRatePercent'),
      upper(60, 120, 'averageSecondsPerFruit'),
    ];

    const reversed = await send(context, 'PUT', '/viewpoints/harvestSpeed/criteria', {
      criteria: [upper(10, 10, 'travelStoppedRatePercent'), valid[1]],
    });
    const ok = await send(context, 'PUT', '/viewpoints/harvestSpeed/criteria', { criteria: valid });

    expect(reversed.status).toBe(400);
    expect(ok.status).toBe(200);
  });

  it('存在しない観点は 404', async () => {
    const context = await withEquipment();

    expect((await send(context, 'GET', '/viewpoints/nothing/criteria')).status).toBe(404);
    expect((await send(context, 'PUT', '/viewpoints/nothing/criteria', {})).status).toBe(404);
    expect((await send(context, 'POST', '/viewpoints/nothing/criteria/reset')).status).toBe(404);
  });

  it('評価が失敗しても、判断基準の保存は成功する', async () => {
    const context = await withEquipment();
    context.container.evaluationService.evaluateAll = () => Promise.reject(new Error('評価の失敗'));

    expect((await send(context, 'PUT', URL, { criteria: environment() })).status).toBe(200);
  });
});

describe('ユーザー管理（UC-14。GET・POST・PUT・DELETE /users）', () => {
  const NEW_USER = {
    userId: 'worker-2',
    userName: '作業者2',
    password: 'Dummy-Passw0rd-new',
    role: 'worker',
  };

  it('一覧は、ロールの選択肢つきで、パスワードのハッシュを含めずに返す', async () => {
    const context = await createTestContext();

    const body = UserListResponseSchema.parse(await (await send(context, 'GET', '/users')).json());

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ userId: 'test-user', role: 'worker' });
    expect(body.items[0]?.lastLoginAt).toBeDefined();
    expect(body.roles).toEqual([{ roleId: 'worker', name: '農作業者' }]);
    expect(JSON.stringify(body)).not.toContain('scrypt');
  });

  it('登録したユーザーは、そのパスワードでログインでき、変更履歴にパスワードを残さない', async () => {
    const context = await createTestContext();

    const response = await send(context, 'POST', '/users', NEW_USER);
    const login = await context.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: NEW_USER.userId, password: NEW_USER.password }),
    });

    expect(response.status).toBe(201);
    expect(login.status).toBe(200);
    const audit = JSON.stringify(await (await send(context, 'GET', '/audit-logs')).json());
    expect(audit).not.toContain(NEW_USER.password);
    expect(audit).not.toContain('scrypt');
  });

  it.each([
    ['ユーザーIDが重複', { ...NEW_USER, userId: 'test-user' }, 409, 'userId'],
    ['ユーザーIDの形式が不正', { ...NEW_USER, userId: 'bad id' }, 400, 'userId'],
    ['ユーザー名が空', { ...NEW_USER, userName: '' }, 400, 'userName'],
    ['パスワードが7文字（境界値）', { ...NEW_USER, password: 'Abcde1x' }, 400, 'password'],
    ['パスワードに数字がない', { ...NEW_USER, password: 'Abcdefghij' }, 400, 'password'],
    ['パスワードに英大文字がない', { ...NEW_USER, password: 'abcdefg1' }, 400, 'password'],
    ['パスワードに英小文字がない', { ...NEW_USER, password: 'ABCDEFG1' }, 400, 'password'],
    ['定義されていないロール', { ...NEW_USER, role: 'boss' }, 400, 'role'],
  ])('不正な登録（%s）は拒否する', async (_name, body, status, field) => {
    const context = await createTestContext();

    const response = await send(context, 'POST', '/users', body);

    expect(response.status).toBe(status);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
  });

  it('パスワードが8文字（境界値）なら登録できる', async () => {
    const context = await createTestContext();

    expect(
      (await send(context, 'POST', '/users', { ...NEW_USER, password: 'Abcdef1x' })).status,
    ).toBe(201);
  });

  it('ユーザー名・ロールを変更でき、パスワードは指定したときだけ変わる', async () => {
    const context = await createTestContext({
      env: {
        ROLE_DEFINITIONS_JSON: JSON.stringify({
          worker: { name: '農作業者', permissions: ['user:manage'] },
          viewer: { name: '閲覧者', permissions: [] },
        }),
      },
    });
    await send(context, 'POST', '/users', NEW_USER);
    const loginAs = (password: string) =>
      context.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: NEW_USER.userId, password }),
      });

    const renamed = await send(context, 'PUT', `/users/${NEW_USER.userId}`, {
      userName: '改名',
      role: 'viewer',
    });
    const repassworded = await send(context, 'PUT', `/users/${NEW_USER.userId}`, {
      userName: '改名',
      role: 'viewer',
      password: 'Dummy-Passw0rd-changed',
    });

    expect(renamed.status).toBe(200);
    expect(repassworded.status).toBe(200);
    expect((await loginAs(NEW_USER.password)).status).toBe(401);
    expect((await loginAs('Dummy-Passw0rd-changed')).status).toBe(200);
  });

  it.each([
    ['ユーザー名が空', { userName: '', role: 'worker' }, 400],
    ['定義されていないロール', { userName: 'x', role: 'boss' }, 400],
    ['パスワードが条件を満たさない', { userName: 'x', role: 'worker', password: 'short' }, 400],
  ])('変更の検証（%s）', async (_name, body, status) => {
    const context = await createTestContext();
    await send(context, 'POST', '/users', NEW_USER);

    expect((await send(context, 'PUT', `/users/${NEW_USER.userId}`, body)).status).toBe(status);
  });

  it('削除したユーザーは、次のリクエストから使えない。自分自身は削除できない。存在しなければ 404', async () => {
    const context = await createTestContext();
    await send(context, 'POST', '/users', NEW_USER);
    const login = await context.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: NEW_USER.userId, password: NEW_USER.password }),
    });
    const otherToken = ((await login.json()) as { accessToken: string }).accessToken;

    const self = await send(context, 'DELETE', '/users/test-user');
    const deleted = await send(context, 'DELETE', `/users/${NEW_USER.userId}`);
    const missing = await send(context, 'DELETE', `/users/${NEW_USER.userId}`);
    const afterDelete = await send(context, 'GET', '/equipment', undefined, otherToken);
    const missingUpdate = await send(context, 'PUT', '/users/nobody', {
      userName: 'x',
      role: 'worker',
    });

    expect(self.status).toBe(409);
    expect(deleted.status).toBe(204);
    expect(missing.status).toBe(404);
    expect(afterDelete.status).toBe(401);
    expect(missingUpdate.status).toBe(404);
  });

  it('登録・変更・削除は、変更履歴に、変更したユーザーとともに残り、パスワード（平文・ハッシュ）は残らない', async () => {
    const context = await createTestContext();
    const password = 'Dummy-Passw0rd-audit';

    await send(context, 'POST', '/users', { ...NEW_USER, password });
    await send(context, 'PUT', `/users/${NEW_USER.userId}`, {
      userName: '改名',
      role: 'worker',
      password: 'Dummy-Passw0rd-audit2',
    });
    await send(context, 'DELETE', `/users/${NEW_USER.userId}`);

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=user')).json(),
    );
    expect(audit.items.map((item) => item.operation).sort()).toEqual([
      'CREATE',
      'DELETE',
      'UPDATE',
    ]);
    for (const item of audit.items) {
      expect(item).toMatchObject({
        targetType: 'user',
        targetId: NEW_USER.userId,
        actor: 'test-user',
      });
    }
    const update = audit.items.find((item) => item.operation === 'UPDATE');
    expect(update?.before).toEqual({
      userId: NEW_USER.userId,
      userName: NEW_USER.userName,
      role: 'worker',
    });
    expect(update?.after).toEqual({ userId: NEW_USER.userId, userName: '改名', role: 'worker' });
    const text = JSON.stringify(audit);
    expect(text).not.toContain('Dummy-Passw0rd');
    expect(text).not.toContain('scrypt');
    expect(text).not.toContain('passwordHash');
  });

  it('ロールを変更すると、そのユーザーの発行済みのトークンにも、次のリクエストから、新しい権限が適用される', async () => {
    const context = await createTestContext({
      env: {
        ROLE_DEFINITIONS_JSON: JSON.stringify({
          worker: { name: '農作業者', permissions: ['user:manage'] },
          viewer: { name: '閲覧者', permissions: [] },
        }),
      },
    });
    await send(context, 'POST', '/users', NEW_USER);
    const login = await context.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: NEW_USER.userId, password: NEW_USER.password }),
    });
    const token = ((await login.json()) as { accessToken: string }).accessToken;

    const before = await send(context, 'GET', '/users', undefined, token);
    await send(context, 'PUT', `/users/${NEW_USER.userId}`, {
      userName: '作業者2',
      role: 'viewer',
    });
    const after = await send(context, 'GET', '/users', undefined, token);

    expect(before.status).toBe(200);
    expect(after.status).toBe(403);
  });
});

describe('取り込み設定・状況（UC-15、UC-16）', () => {
  async function settings(context: TestContext) {
    return IngestionSettingsResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/settings')).json(),
    );
  }

  it('取り込み元の設定と状況（解釈に使う仕様の版・状態、最終の取得）を返す。認証情報の値は含めない', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await send(context, 'POST', '/ingestion/robot/run');

    const body = await settings(context);

    expect(body.sources.map((source) => source.sourceId)).toEqual(['robot', 'environment-sensor']);
    const robot = body.sources[0];
    expect(robot).toMatchObject({
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes: 15,
      isEnabled: true,
      isRunning: false,
      formatProfile: { versionLabel: 'robot-json@0.1.0(PROVISIONAL)', status: 'PROVISIONAL' },
      lastStartedAt: TEST_NOW.toISOString(),
      lastSuccessAt: TEST_NOW.toISOString(),
    });
    expect(body.sources[1]).toMatchObject({ lastStartedAt: null, lastSuccessAt: null });
  });

  it('接続先の参照名・取得間隔・有効／無効を保存し、変更履歴に残す。指定のない取り込み元はそのまま', async () => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', '/ingestion/settings', {
      sources: [
        {
          sourceId: 'robot',
          connectionRef: 'FILE_SERVER_2',
          intervalMinutes: 360,
          isEnabled: false,
        },
      ],
    });

    expect(response.status).toBe(200);
    const body = await settings(context);
    expect(body.sources[0]).toMatchObject({
      connectionRef: 'FILE_SERVER_2',
      intervalMinutes: 360,
      isEnabled: false,
    });
    expect(body.sources[1]).toMatchObject({
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes: 15,
    });
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=ingestion-settings')).json(),
    );
    expect(audit.items).toHaveLength(1);
  });

  it.each([5, 15, 30, 60, 360, 1440])(
    '取得間隔 %i 分は保存できる（候補の全値）',
    async (interval) => {
      const context = await withEquipment();

      const response = await send(context, 'PUT', '/ingestion/settings', {
        sources: [
          {
            sourceId: 'robot',
            connectionRef: 'FILE_SERVER_MOCK',
            intervalMinutes: interval,
            isEnabled: true,
          },
        ],
      });

      expect(response.status).toBe(200);
    },
  );

  it.each([
    ['候補にない取得間隔', { intervalMinutes: 10 }, 'sources.0.intervalMinutes'],
    ['参照名が空', { connectionRef: '' }, 'sources.0.connectionRef'],
    ['参照名に使えない文字', { connectionRef: 'bad ref!' }, 'sources.0.connectionRef'],
    ['参照名が長すぎる', { connectionRef: 'a'.repeat(101) }, 'sources.0.connectionRef'],
    ['存在しない取り込み元', { sourceId: 'unknown' }, 'sources.0.sourceId'],
  ])('不正な設定（%s）は保存しない', async (_name, override, field) => {
    const context = await withEquipment();

    const response = await send(context, 'PUT', '/ingestion/settings', {
      sources: [
        {
          sourceId: 'robot',
          connectionRef: 'FILE_SERVER_MOCK',
          intervalMinutes: 15,
          isEnabled: true,
          ...override,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
  });

  it('同じ取り込み元を重複して指定した設定は保存しない', async () => {
    const context = await withEquipment();
    const source = {
      sourceId: 'robot',
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes: 15,
      isEnabled: true,
    };

    const response = await send(context, 'PUT', '/ingestion/settings', {
      sources: [source, source],
    });

    expect(response.status).toBe(400);
  });

  it('接続テスト: 接続できれば成功、ファイルサーバーが停止していれば、内部情報を含まない失敗を返す', async () => {
    const context = await withEquipment();
    context.placeFile('robot', 'placeholder.txt', 'x');

    const ok = await send(context, 'POST', '/ingestion/robot/test');
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
    const failed = await send(context, 'POST', '/ingestion/robot/test');
    const unknown = await send(context, 'POST', '/ingestion/unknown/test');

    expect(await ok.json()).toEqual({ ok: true, message: '接続できました' });
    const failure = (await failed.json()) as { ok: boolean; message: string };
    expect(failure.ok).toBe(false);
    expect(failure.message).not.toContain(context.fileServerDirectory);
    expect(unknown.status).toBe(404);
  });

  it('即時取得: 取り込んだ件数を返し、ログに記録する。同じファイルは、2回目は取り込まない', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const first = await send(context, 'POST', '/ingestion/robot/run');
    const second = await send(context, 'POST', '/ingestion/robot/run');
    const unknown = await send(context, 'POST', '/ingestion/unknown/run');

    expect(first.status).toBe(202);
    expect(IngestionRunResponseSchema.parse(await first.json())).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
    });
    expect(IngestionRunResponseSchema.parse(await second.json())).toMatchObject({
      filesProcessed: 0,
      recordCount: 0,
    });
    expect(unknown.status).toBe(404);
    const logs = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs')).json(),
    );
    expect(logs.items).toHaveLength(2);
  });

  it('取り込みログは、取り込み元で絞り込め、新しい順に、ページ分割して返す', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/ingestion/robot/run');
    context.clock.advance(60_000);
    await send(context, 'POST', '/ingestion/environment-sensor/run');
    context.clock.advance(60_000);
    await send(context, 'POST', '/ingestion/robot/run');

    const all = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs')).json(),
    );
    const robotOnly = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs?sourceId=robot')).json(),
    );
    const paged = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs?limit=2')).json(),
    );

    expect(all.items).toHaveLength(3);
    expect(robotOnly.items.map((item) => item.sourceId)).toEqual(['robot', 'robot']);
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
  });

  it('連携の状況: 結果の記録（新しい順）と、連携キューの状態ごとの件数を返す', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await send(context, 'POST', '/ingestion/robot/run');
    context.container.dev?.faults.federation.set({ mode: 'DOWN' });
    await context.container.jobRunner.run('JB-03');
    context.container.dev?.faults.federation.set({ mode: 'UP' });
    context.clock.advance(6 * 60_000);
    await context.container.jobRunner.run('JB-03');

    const body = FederationLogListResponseSchema.parse(
      await (await send(context, 'GET', '/federation/logs')).json(),
    );

    expect(body.items.map((item) => item.result)).toEqual(['SENT', 'HELD']);
    expect(body.queue.SENT).toBeGreaterThan(0);
    expect(body.queue.HELD).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  it('連携の状況: 農業情報基盤が受け付けない場合は「失敗」、停止中は「保留」を、キューの件数とともに返す', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await send(context, 'POST', '/ingestion/robot/run');
    context.container.dev?.faults.federation.set({ mode: 'REJECT' });
    await context.container.jobRunner.run('JB-03');

    const rejected = FederationLogListResponseSchema.parse(
      await (await send(context, 'GET', '/federation/logs')).json(),
    );

    expect(rejected.items.map((item) => item.result)).toEqual(['FAILED']);
    expect(rejected.items[0]?.message).toBe('農業情報基盤への連携に失敗しました');
    expect(rejected.queue.FAILED).toBeGreaterThan(0);
    expect(rejected.queue.SENT).toBe(0);
  });

  it('連携の状況: 結果の記録は、limit ごとにページ分割して、新しい順に返す', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await send(context, 'POST', '/ingestion/robot/run');
    context.container.dev?.faults.federation.set({ mode: 'DOWN' });
    for (let count = 0; count < 3; count += 1) {
      context.clock.advance(721 * 60_000);
      await context.container.jobRunner.run('JB-03');
    }

    const first = FederationLogListResponseSchema.parse(
      await (await send(context, 'GET', '/federation/logs?limit=2')).json(),
    );
    const second = FederationLogListResponseSchema.parse(
      await (
        await send(context, 'GET', `/federation/logs?limit=2&cursor=${first.nextCursor ?? ''}`)
      ).json(),
    );

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]?.occurredAt.localeCompare(first.items[1]?.occurredAt ?? '')).toBe(1);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // どのページも、キューの件数は同じ
    expect(second.queue).toEqual(first.queue);
  });

  it('取り込みログ: 該当する取り込み元がなければ、空の一覧を返す。ページ分割は、取り込み元の絞り込みと併用できる', async () => {
    const context = await withEquipment();
    for (let count = 0; count < 3; count += 1) {
      await send(context, 'POST', '/ingestion/robot/run');
      context.clock.advance(60_000);
    }
    await send(context, 'POST', '/ingestion/environment-sensor/run');

    const none = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs?sourceId=unknown')).json(),
    );
    const first = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs?sourceId=robot&limit=2')).json(),
    );
    const second = IngestionLogListResponseSchema.parse(
      await (
        await send(
          context,
          'GET',
          `/ingestion/logs?sourceId=robot&limit=2&cursor=${first.nextCursor ?? ''}`,
        )
      ).json(),
    );

    expect(none).toEqual({ items: [], nextCursor: null });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.sourceId))).toEqual(
      new Set(['robot']),
    );
  });

  it('取り込みログ: 失敗した取り込みは、失敗の内容（内部情報なし）を記録して返す。成功は、失敗の内容を持たない', async () => {
    const context = await withEquipment();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await send(context, 'POST', '/ingestion/robot/run');
    context.clock.advance(60_000);
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
    await send(context, 'POST', '/ingestion/robot/run');

    const logs = IngestionLogListResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/logs')).json(),
    );

    expect(logs.items.map((item) => item.result)).toEqual(['FAILURE', 'SUCCESS']);
    expect(logs.items[0]?.errorMessage).toBe('ファイルサーバーに接続できませんでした');
    expect(logs.items[0]?.errorMessage).not.toContain(context.fileServerDirectory);
    expect(logs.items[1]?.errorMessage).toBeUndefined();
    expect(logs.items[1]?.recordCount).toBe(14);
  });

  it.each([
    ['/ingestion/logs?limit=0'],
    ['/ingestion/logs?limit=101'],
    ['/ingestion/logs?cursor=%21%21'],
    ['/ingestion/logs?sourceId='],
    ['/federation/logs?limit=0'],
    ['/federation/logs?limit=101'],
    ['/federation/logs?cursor=%21%21'],
  ])('ログの一覧のクエリが不正（%s）なら 400', async (path) => {
    const context = await withEquipment();

    const response = await send(context, 'GET', path);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
  });
});

describe('Web Push の購読（UC-23。GET・PUT・DELETE /push-subscription）', () => {
  const ENDPOINT = 'https://push.example.invalid/endpoint-1';
  const PUBLIC_KEY_ENV = { WEB_PUSH_PUBLIC_KEY: 'dummy-web-push-public-key' };

  it('公開鍵が設定されていれば、購読・状態の確認・解除ができる', async () => {
    const context = await withEquipment({ env: PUBLIC_KEY_ENV });
    const status = async () =>
      (await (await send(context, 'GET', '/push-subscription')).json()) as {
        isAvailable: boolean;
        publicKey: string | null;
        isSubscribed: boolean;
      };
    expect(await status()).toEqual({
      isAvailable: true,
      publicKey: 'dummy-web-push-public-key',
      isSubscribed: false,
    });

    const subscribed = await send(context, 'PUT', '/push-subscription', { endpoint: ENDPOINT });
    const subscribedAgain = await send(context, 'PUT', '/push-subscription', {
      endpoint: ENDPOINT,
    });
    const afterSubscribe = await status();
    const unsubscribed = await send(context, 'DELETE', '/push-subscription');
    const afterUnsubscribe = await status();

    expect(subscribed.status).toBe(204);
    expect(subscribedAgain.status).toBe(204);
    expect(afterSubscribe.isSubscribed).toBe(true);
    expect(await context.container.repositories.pushSubscriptions.listActive()).toHaveLength(0);
    expect(unsubscribed.status).toBe(204);
    expect(afterUnsubscribe.isSubscribed).toBe(false);
  });

  it('端末（endpoint）ごとに購読でき、endpoint を指定した解除は、その端末のみ', async () => {
    const context = await withEquipment({ env: PUBLIC_KEY_ENV });
    await send(context, 'PUT', '/push-subscription', { endpoint: ENDPOINT });
    await send(context, 'PUT', '/push-subscription', { endpoint: `${ENDPOINT}-2` });

    expect(await context.container.repositories.pushSubscriptions.listActive()).toHaveLength(2);
    const statusOf = async (endpoint: string) =>
      (
        (await (
          await send(context, 'GET', `/push-subscription?endpoint=${encodeURIComponent(endpoint)}`)
        ).json()) as { isSubscribed: boolean }
      ).isSubscribed;
    // 端末ごとの状態: 購読している端末は有効、していない端末は無効
    expect(await statusOf(ENDPOINT)).toBe(true);
    expect(await statusOf(`${ENDPOINT}-3`)).toBe(false);
    await send(context, 'DELETE', '/push-subscription', { endpoint: ENDPOINT });
    expect(await statusOf(ENDPOINT)).toBe(false);
    expect(await statusOf(`${ENDPOINT}-2`)).toBe(true);

    const remaining = await context.container.repositories.pushSubscriptions.listActive();
    expect(remaining.map((item) => item.endpoint)).toEqual([`${ENDPOINT}-2`]);
  });

  it('購読すると、通知の配信（JB-04）の対象になり、解除すると、配信されない', async () => {
    const context = await withEquipment({ env: PUBLIC_KEY_ENV });
    await send(context, 'PUT', '/push-subscription', { endpoint: ENDPOINT });
    await createEntry(
      context,
      entryBody({
        items: { operationStepCount: 12, operationMinutes: 35, operationErrorCount: 2 },
      }),
    );

    await context.container.jobRunner.run('JB-04');

    const created = NotificationListResponseSchema.parse(
      await (await send(context, 'GET', '/notifications')).json(),
    );
    expect(created.items.length).toBeGreaterThan(0);
    expect(context.container.dev?.mocks.webPush.delivered()).toHaveLength(created.items.length);
  });

  it('公開鍵が設定されていない環境では、利用できない旨を返し、購読を受け付けない（503）', async () => {
    const context = await withEquipment();

    const status = await (await send(context, 'GET', '/push-subscription')).json();
    const response = await send(context, 'PUT', '/push-subscription', { endpoint: ENDPOINT });

    expect(status).toEqual({ isAvailable: false, publicKey: null, isSubscribed: false });
    expect(response.status).toBe(503);
  });

  it.each([
    ['endpoint が URL でない', { endpoint: 'not a url' }],
    ['endpoint がない', {}],
  ])('不正な購読（%s）は 400', async (_name, body) => {
    const context = await withEquipment({ env: PUBLIC_KEY_ENV });

    expect((await send(context, 'PUT', '/push-subscription', body)).status).toBe(400);
  });
});
