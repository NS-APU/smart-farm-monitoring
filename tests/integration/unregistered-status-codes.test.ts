/**
 * 未登録のコード値（SC-12-5。UC-08・UC-17。ADR-0017 の D-23。Issue #158）の結合テスト。
 * 取り込みで、定義にないステータスコードを、不正の品質で保存した観測値から、コード値ごとに（件数・最終の日時）記録し、
 * `GET /status-codes/unregistered`（管理者のみ）で返す。登録済み（論理削除でない）のコード値は、読むときに除く。
 * 合成データ（ダミーのコード値）だけを使う。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  UnregisteredStatusCodeListResponseSchema,
  type UnregisteredStatusCode,
} from '@smart-farm/shared/schemas/status-code';
import type { Logger } from '../../src/backend/application/ports/logger-port.ts';
import { ROUTE_TABLE, routeKey } from '../../src/backend/presentation/route-table.ts';
import { ROBOT_ID } from '../support/builders.ts';
import { withHttpFiles, type HttpTestContext } from '../support/http-test-files.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  TEST_NOW,
  type TestContext,
} from '../support/test-context.ts';

const FILE = 'latest.json';
const T1 = '2026-10-09T01:00:00Z';
const T2 = '2026-10-09T01:15:00Z';
const T3 = '2026-10-09T01:30:00Z';

interface RecordInput {
  readonly timestamp: string;
  readonly statusCode?: string | number | null;
  readonly harvestCount?: number;
}

/** ロボットのファイルの内容（合成データ）。 */
function robotFile(records: readonly RecordInput[]): string {
  return JSON.stringify({ robotId: 'ROBOT-SAMPLE-01', records });
}

/** 読んでよい（更新から 1 秒より後）更新日時にして、ファイルを置く（同じパスの上書き）。 */
async function place(context: HttpTestContext, records: readonly RecordInput[]): Promise<void> {
  await context.files.placeFile('robot', FILE, robotFile(records), {
    modifiedAt: new Date(context.clock.now().getTime() - 60_000),
  });
}

/** ログの呼び出しを集めるロガー（値が、ログに出ないことの確認用）。 */
function recordingLogger() {
  const lines: { readonly level: string; readonly message: string; readonly fields: unknown }[] =
    [];
  const logger: Logger = {
    debug: (message, fields) => lines.push({ level: 'debug', message, fields }),
    info: (message, fields) => lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => lines.push({ level: 'error', message, fields }),
    child: () => logger,
  };
  return { logger, lines };
}

async function setup(logger?: Logger): Promise<HttpTestContext> {
  return withHttpFiles(logger === undefined ? {} : { logger });
}

async function run(context: TestContext) {
  return context.container.ingestionService.runSource('robot');
}

async function recorded(context: TestContext) {
  const items = await context.container.repositories.unregisteredStatusCodes.list();
  return Object.fromEntries(
    items
      .sort((left, right) => left.code.localeCompare(right.code))
      .map((item) => [item.code, { count: item.count, lastSeenAt: item.lastSeenAt }]),
  );
}

async function listApi(context: TestContext, token?: string): Promise<UnregisteredStatusCode[]> {
  const response = await context.request('/status-codes/unregistered', {
    ...(token === undefined ? {} : { token }),
  });
  expect(response.status).toBe(200);
  return UnregisteredStatusCodeListResponseSchema.parse(await response.json()).items;
}

describe('取り込み: 未登録のコード値の記録（UC-08）', () => {
  it('不正で保存した、定義にないステータスコードを、コード値ごとに、件数・最終の日時つきで記録する。登録済みのコード値は、記録しない', async () => {
    const context = await setup();
    await place(context, [
      { timestamp: T1, statusCode: 'ERR_X' },
      { timestamp: T2, statusCode: 'ERR_X' },
      { timestamp: T3, statusCode: 'ERR_Y' },
      { timestamp: '2026-10-09T01:45:00Z', statusCode: 'RUNNING' },
    ]);

    const summary = await run(context);

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 1, rejectedCount: 3 });
    expect(await recorded(context)).toEqual({
      ERR_X: { count: 2, lastSeenAt: TEST_NOW.toISOString() },
      ERR_Y: { count: 1, lastSeenAt: TEST_NOW.toISOString() },
    });
    // 観測値は、不正の品質で、元の値を残して保存している（ADR-0016 の D-10）
    const stored = (
      await context.container.repositories.observations.query(
        { equipmentIds: [ROBOT_ID], itemKey: 'statusCode', includeDeleted: true },
        { limit: 50 },
      )
    ).items;
    expect(
      stored
        .filter((item) => item.quality === 'INVALID')
        .map((item) => item.value)
        .sort(),
    ).toEqual(['ERR_X', 'ERR_X', 'ERR_Y']);
  });

  it('新しい計測日時の同じ値は、件数を加算し、最終の日時を更新する。変わらないファイルの再取り込みと、同じ内容の再読み込みは、加算しない', async () => {
    const context = await setup();
    await place(context, [{ timestamp: T1, statusCode: 'ERR_X' }]);
    await run(context);
    // 同じ内容（変わらない）: 取り込み済みで、観測値も増えない
    await run(context);
    context.clock.advance(10 * 60_000);
    // 同じ計測日時の行 + 新しい計測日時の行（D-08: 変わった分だけ保存する）
    await place(context, [
      { timestamp: T1, statusCode: 'ERR_X' },
      { timestamp: T2, statusCode: 'ERR_X' },
    ]);

    await run(context);

    expect(await recorded(context)).toEqual({
      ERR_X: { count: 2, lastSeenAt: context.clock.now().toISOString() },
    });
  });

  it('ファイルの内容が変わっても、変わっていない観測値（同じ一意キー・同じ値・同じ品質）は、もう一度、数えない', async () => {
    const context = await setup();
    await place(context, [{ timestamp: T1, statusCode: 'ERR_X' }]);
    await run(context);
    // ファイルの内容（ハッシュ）が変わる（別の計測日時の、登録済みのコード値を足す）が、ERR_X の行は同じ
    await place(context, [
      { timestamp: T1, statusCode: 'ERR_X' },
      { timestamp: T2, statusCode: 'RUNNING' },
    ]);

    await run(context);

    expect(await recorded(context)).toEqual({
      ERR_X: { count: 1, lastSeenAt: TEST_NOW.toISOString() },
    });
  });

  it('論理削除したコード値は、未登録として記録する', async () => {
    const context = await setup();
    expect((await context.request('/status-codes/RUNNING', { method: 'DELETE' })).status).toBe(204);
    await place(context, [{ timestamp: T1, statusCode: 'RUNNING' }]);

    await run(context);

    expect(await recorded(context)).toEqual({
      RUNNING: { count: 1, lastSeenAt: TEST_NOW.toISOString() },
    });
  });

  it('不正でない値（有効・欠損・数値の不正・ほかの項目の不正）は、記録しない', async () => {
    const context = await setup();
    await place(context, [
      { timestamp: T1, statusCode: 'RUNNING' },
      { timestamp: T2, statusCode: null },
      { timestamp: T3, statusCode: 42, harvestCount: -3 },
    ]);

    await run(context);

    expect(await recorded(context)).toEqual({});
  });

  it('値は 100 文字で切って記録する（登録できない形式の値も、そのまま記録する）', async () => {
    const context = await setup();
    await place(context, [
      { timestamp: T1, statusCode: `${'A'.repeat(100)}-OVER` },
      { timestamp: T2, statusCode: 'low battery' },
    ]);

    await run(context);

    expect(await recorded(context)).toEqual({
      ['A'.repeat(100)]: { count: 1, lastSeenAt: TEST_NOW.toISOString() },
      'low battery': { count: 1, lastSeenAt: TEST_NOW.toISOString() },
    });
  });

  describe('記録の上限（1 回の取り込みで新しい値 20 種類・全体で 50 件）', () => {
    const codeName = (index: number) => `CODE_${String(index).padStart(2, '0')}`;
    const minuteOf = (index: number) => `2026-10-09T01:${String(index % 60).padStart(2, '0')}:00Z`;

    it('1 回の取り込みで新しく記録するのは 20 種類まで（件数の多い順）。観測値の保存は、止めない', async () => {
      const { logger, lines } = recordingLogger();
      const context = await setup(logger);
      const records: RecordInput[] = Array.from({ length: 25 }, (_unused, index) => ({
        timestamp: `2026-10-09T01:${String(index).padStart(2, '0')}:00Z`,
        statusCode: codeName(index),
      }));
      // CODE_24 は 3 件（ほかは 1 件）にして、先に選ばれる
      records.push(
        { timestamp: '2026-10-09T02:00:00Z', statusCode: codeName(24) },
        { timestamp: '2026-10-09T02:05:00Z', statusCode: codeName(24) },
      );
      await place(context, records);

      const summary = await run(context);

      expect(summary).toMatchObject({ filesProcessed: 1, rejectedCount: 27 });
      const keys = Object.keys(await recorded(context));
      expect(keys).toHaveLength(20);
      expect(keys).toContain(codeName(24));
      expect(await recorded(context)).toMatchObject({ [codeName(24)]: { count: 3 } });
      // 上限に達して記録しなかった種類の数は、警告に残す（値は、ログに出さない）
      const warning = lines.find((line) => line.level === 'warn' && line.message.includes('上限'));
      expect(warning?.fields).toMatchObject({ skippedKinds: 5 });
      expect(JSON.stringify(lines)).not.toContain('CODE_');
    });

    it('全体で 50 件に達したら、新しい値は記録しない。すでにある値の件数の加算は、続ける', async () => {
      const context = await setup();
      // 3 回の取り込み（20 + 20 + 10）で、50 件にする
      for (const [start, end] of [
        [0, 20],
        [20, 40],
        [40, 50],
      ] as const) {
        const records: RecordInput[] = [];
        for (let index = start; index < end; index += 1) {
          records.push({ timestamp: minuteOf(index), statusCode: codeName(index) });
        }
        await place(context, records);
        context.clock.advance(1000);
        await run(context);
      }
      expect(Object.keys(await recorded(context))).toHaveLength(50);

      context.clock.advance(60_000);
      await place(context, [
        { timestamp: '2026-10-09T02:00:00Z', statusCode: 'BRAND_NEW' },
        { timestamp: '2026-10-09T02:05:00Z', statusCode: codeName(3) },
      ]);
      const summary = await run(context);

      expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 0, rejectedCount: 2 });
      const after = await recorded(context);
      expect(Object.keys(after)).toHaveLength(50);
      expect(after).not.toHaveProperty('BRAND_NEW');
      expect(after[codeName(3)]?.count).toBe(2);
      // 観測値は、記録とは別に、不正で保存されている
      const stored = await context.container.repositories.observations.findByKey(
        ROBOT_ID,
        'statusCode',
        new Date('2026-10-09T02:00:00Z').toISOString(),
        'AUTO_IMPORT',
      );
      expect(stored).toMatchObject({ value: 'BRAND_NEW', quality: 'INVALID' });
    });
  });

  describe('記録の失敗・ログ', () => {
    it('記録に失敗しても、取り込みは失敗にしない（観測値の保存・取り込み済みの記録・結果は、そのまま）。失敗は、原因を、値を含めずにログに残す', async () => {
      const { logger, lines } = recordingLogger();
      const context = await setup(logger);
      vi.spyOn(context.container.repositories.unregisteredStatusCodes, 'record').mockRejectedValue(
        new Error('記録の失敗（テスト）'),
      );
      await place(context, [
        { timestamp: T1, statusCode: 'ERR_SECRET_LIKE_VALUE' },
        { timestamp: T2, statusCode: 'RUNNING' },
      ]);

      const summary = await run(context);

      // 記録の失敗がない場合（同じ内容）と、結果が同じ
      const control = await setup();
      await place(control, [
        { timestamp: T1, statusCode: 'ERR_SECRET_LIKE_VALUE' },
        { timestamp: T2, statusCode: 'RUNNING' },
      ]);
      expect(summary).toEqual(await run(control));
      expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 1, rejectedCount: 1 });
      expect(await recorded(context)).toEqual({});
      const stored = await context.container.repositories.observations.findByKey(
        ROBOT_ID,
        'statusCode',
        new Date(T1).toISOString(),
        'AUTO_IMPORT',
      );
      expect(stored).toMatchObject({ value: 'ERR_SECRET_LIKE_VALUE', quality: 'INVALID' });
      const failure = lines.find(
        (line) => line.level === 'error' && line.message.includes('未登録'),
      );
      expect(failure?.fields).toMatchObject({ sourceId: 'robot' });
      expect(JSON.stringify(lines)).not.toContain('ERR_SECRET_LIKE_VALUE');
    });

    it('ログには、値そのものを出さない（件数・種類数だけ）', async () => {
      const { logger, lines } = recordingLogger();
      const context = await setup(logger);
      await place(context, [{ timestamp: T1, statusCode: 'ERR_SECRET_LIKE_VALUE' }]);

      await run(context);

      expect(JSON.stringify(lines)).not.toContain('ERR_SECRET_LIKE_VALUE');
      const info = lines.find((line) => line.message.includes('未登録のステータスコード'));
      expect(info?.fields).toMatchObject({ sourceId: 'robot', kinds: 1, observations: 1 });
    });

    it('未登録の値がなければ、記録もログも、しない', async () => {
      const { logger, lines } = recordingLogger();
      const context = await setup(logger);
      const spy = vi.spyOn(context.container.repositories.unregisteredStatusCodes, 'record');
      await place(context, [{ timestamp: T1, statusCode: 'RUNNING' }]);

      await run(context);

      expect(spy).not.toHaveBeenCalled();
      expect(lines.some((line) => line.message.includes('未登録'))).toBe(false);
    });
  });
});

describe('GET /status-codes/unregistered（UC-17。SC-12-5。管理者のみ）', () => {
  const T = new Date('2026-11-01T01:00:00.000Z');

  it('ルート一覧にあり、管理者のステータスコードの管理の権限（status-code:manage）が要る', () => {
    const route = ROUTE_TABLE.find((spec) => routeKey(spec) === 'GET /status-codes/unregistered');

    expect(route).toMatchObject({ access: 'status-code:manage', useCases: ['UC-17'] });
  });

  it('記録がなければ、空の一覧', async () => {
    const context = await setup();

    expect(await listApi(context)).toEqual([]);
  });

  it('コード値・件数・最終の日時・登録できる形式か・初期値の案を返す。件数の多い順（同じなら、最終の日時の新しい順、コード値の順）', async () => {
    const context = await setup();
    const repository = context.container.repositories.unregisteredStatusCodes;
    await repository.record('ERR_ONE', 1, new Date('2026-11-01T01:00:00.000Z'));
    await repository.record('low battery', 7, new Date('2026-11-01T02:00:00.000Z'));
    await repository.record('ERR_TIE_OLD', 3, new Date('2026-11-01T01:00:00.000Z'));
    await repository.record('ERR_TIE_NEW', 3, new Date('2026-11-01T03:00:00.000Z'));
    await repository.record('エラー', 3, new Date('2026-11-01T03:00:00.000Z'));
    await repository.record('err_lower', 2, new Date('2026-11-01T01:00:00.000Z'));
    await repository.record('1ERR', 1, new Date('2026-11-01T00:00:00.000Z'));

    const items = await listApi(context);

    expect(items).toEqual([
      {
        code: 'low battery',
        count: 7,
        lastSeenAt: '2026-11-01T02:00:00.000Z',
        isRegistrable: false,
        suggestedCode: 'LOW_BATTERY',
      },
      {
        code: 'ERR_TIE_NEW',
        count: 3,
        lastSeenAt: '2026-11-01T03:00:00.000Z',
        isRegistrable: true,
        suggestedCode: 'ERR_TIE_NEW',
      },
      // 件数も最終の日時も同じなら、コード値の順（文字コード順）
      {
        code: 'エラー',
        count: 3,
        lastSeenAt: '2026-11-01T03:00:00.000Z',
        isRegistrable: false,
      },
      {
        code: 'ERR_TIE_OLD',
        count: 3,
        lastSeenAt: '2026-11-01T01:00:00.000Z',
        isRegistrable: true,
        suggestedCode: 'ERR_TIE_OLD',
      },
      {
        code: 'err_lower',
        count: 2,
        lastSeenAt: '2026-11-01T01:00:00.000Z',
        isRegistrable: false,
        suggestedCode: 'ERR_LOWER',
      },
      {
        code: 'ERR_ONE',
        count: 1,
        lastSeenAt: '2026-11-01T01:00:00.000Z',
        isRegistrable: true,
        suggestedCode: 'ERR_ONE',
      },
      {
        code: '1ERR',
        count: 1,
        lastSeenAt: '2026-11-01T00:00:00.000Z',
        isRegistrable: false,
      },
    ]);
  });

  it('登録済み（論理削除でない）のコード値は除く。記録は消えず、あとで、そのコードを削除すると、一覧に戻る。再登録すると、また除く', async () => {
    const context = await setup();
    await context.container.repositories.unregisteredStatusCodes.record('ERR_X', 4, T);
    await context.container.repositories.unregisteredStatusCodes.record('ERR_Y', 1, T);

    const created = await context.request('/status-codes', {
      method: 'POST',
      body: { code: 'ERR_X', name: '想定外のエラー', category: 'ERROR' },
    });
    const afterCreate = await listApi(context);
    const deleted = await context.request('/status-codes/ERR_X', { method: 'DELETE' });
    const afterDelete = await listApi(context);
    await context.request('/status-codes', {
      method: 'POST',
      body: { code: 'ERR_X', name: '想定外のエラー', category: 'ERROR' },
    });
    const afterRecreate = await listApi(context);

    expect(created.status).toBe(201);
    expect(afterCreate.map((item) => item.code)).toEqual(['ERR_Y']);
    expect(deleted.status).toBe(204);
    expect(afterDelete.map((item) => `${item.code}:${String(item.count)}`)).toEqual([
      'ERR_X:4',
      'ERR_Y:1',
    ]);
    expect(afterRecreate.map((item) => item.code)).toEqual(['ERR_Y']);
    // 記録は、読み取りでは、削除しない
    expect(await context.container.repositories.unregisteredStatusCodes.list()).toHaveLength(2);
  });

  it('取り込んだ未登録の値が、そのまま、一覧に出る（取り込み → 一覧 → 登録 → 一覧から消える）', async () => {
    const context = await setup();
    await place(context, [
      { timestamp: T1, statusCode: 'ERR_X' },
      { timestamp: T2, statusCode: 'ERR_X' },
    ]);
    await run(context);

    const before = await listApi(context);
    await context.request('/status-codes', {
      method: 'POST',
      body: { code: 'ERR_X', name: '想定外のエラー', category: 'ERROR' },
    });
    const after = await listApi(context);

    expect(before).toEqual([
      {
        code: 'ERR_X',
        count: 2,
        lastSeenAt: TEST_NOW.toISOString(),
        isRegistrable: true,
        suggestedCode: 'ERR_X',
      },
    ]);
    expect(after).toEqual([]);
  });

  it('一般ユーザーは、403（FORBIDDEN）。未認証は、401', async () => {
    const context = await setup();
    await context.container.repositories.unregisteredStatusCodes.record('ERR_X', 1, T);
    const token = await addUserAndLogin(context, { userId: 'general-1', role: 'general' });
    await markPasswordChanged(context, 'general-1');

    const denied = await context.request('/status-codes/unregistered', { token });
    const anonymous = await context.app.request('/api/v1/status-codes/unregistered');

    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).code).toBe('FORBIDDEN');
    expect(anonymous.status).toBe(401);
  });
});
