/**
 * 更新されるファイルの取り込み（Issue #174・#199。ADR-0016 の D-08）の結合テスト。
 * 提供元は、1 つのファイルを随時更新する（更新のたびに全体が書き換わり、中身は最新の値だけ）。履歴は、こちらが、取得を繰り返して積み上げる。
 * 変わった分（新しい計測日時の観測値・同じ計測日時で値が違う観測値）だけを保存・連携に積み、同じ値は触らない（受信日時もそのまま）。
 * 消えた行は、反映しない。更新日時が 1 秒以内のファイルは、書き換えの最中かもしれないため、次の周期に回す（安全策つき）。
 */

import { describe, expect, it } from 'vitest';
import { ROBOT_ID } from '../support/builders.ts';
import { withHttpFiles, type HttpTestContext } from '../support/http-test-files.ts';
import type { TestContext } from '../support/test-context.ts';

const FILE = 'latest.json';
const T1 = '2026-10-09T01:00:00Z';
const T2 = '2026-10-09T01:15:00Z';
const T3 = '2026-10-09T01:30:00Z';

interface RecordInput {
  readonly timestamp: string;
  readonly harvestCount?: number;
  readonly statusCode?: string;
}

/** ロボットのファイルの内容（その時点のスナップショット 1 つ）。extra は、計測以外の項目（書き込みの時刻など）。 */
function robotFile(record: RecordInput, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, ...record });
}

/** 設備の一式を登録し、HTTP のテスト用ファイルサーバーに接続した組み立て（Issue #344。ADR-0025）。 */
async function setup(): Promise<HttpTestContext> {
  return withHttpFiles();
}

/**
 * ファイルの更新日時（HTTP の `Last-Modified`）を、「時計から見て、更新から ageMs ミリ秒たった」時刻にして返す（負は、時計より未来）。
 * `Last-Modified` は秒の精度（ミリ秒が落ちる）。更新日時を整数秒に置き、足りない端数（1 秒未満）だけ、時計を先に進めて、
 * 「更新から経過した時間」を、ミリ秒まで正確に再現する（時計は、進めるだけ。進める幅は 1 秒未満）。
 */
function modifiedAtFor(context: HttpTestContext, ageMs: number): Date {
  const now = context.clock.now().getTime();
  const modifiedAtMs = Math.ceil((now - ageMs) / 1000) * 1000;
  context.clock.advance(modifiedAtMs + ageMs - now);
  return new Date(modifiedAtMs);
}

/** 読んでよい（更新から 1 秒より後）更新日時にして、ファイルを置く（同じパスの上書き）。 */
async function place(context: HttpTestContext, content: string, ageMs = 60_000): Promise<void> {
  await context.files.placeFile('robot', FILE, content, {
    modifiedAt: modifiedAtFor(context, ageMs),
  });
}

async function observationsOf(context: TestContext) {
  return (
    await context.container.repositories.observations.query(
      { equipmentIds: [ROBOT_ID], includeDeleted: true },
      { limit: 200 },
    )
  ).items;
}

async function observationOf(context: TestContext, itemKey: string, observedAt: string) {
  return context.container.repositories.observations.findByKey(
    ROBOT_ID,
    itemKey,
    new Date(observedAt).toISOString(),
    'AUTO_IMPORT',
  );
}

async function queuedObservationCounts(context: TestContext): Promise<number[]> {
  const items = await context.container.repositories.federation.listDue(
    new Date(context.clock.now().getTime() + 24 * 3_600_000),
    1000,
  );
  return items
    .filter((item) => item.targetType === 'OBSERVATION')
    .map((item) => (item.payload.observations as unknown[]).length);
}

describe('変わった分だけ取り込む（D-08）', () => {
  it('初回は、すべて新しい観測値として保存し、連携に積む', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12, statusCode: 'RUNNING' }));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 2, result: 'SUCCESS' });
    expect(await queuedObservationCounts(context)).toEqual([2]);
  });

  it('新しい計測日時のスナップショットに変わったら、その分を、保存・連携に積む。古い観測値の受信日時は、変えない', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }));
    await context.container.ingestionService.runSource('robot');
    const firstReceivedAt = (await observationOf(context, 'harvestCount', T1))?.receivedAt;
    context.clock.advance(15 * 60_000);
    await place(context, robotFile({ timestamp: T2, harvestCount: 9 }));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 1 });
    expect((await observationOf(context, 'harvestCount', T1))?.receivedAt).toBe(firstReceivedAt);
    expect((await observationOf(context, 'harvestCount', T2))?.receivedAt).toBe(
      context.clock.now().toISOString(),
    );
    expect(await queuedObservationCounts(context)).toEqual([1, 1]);
  });

  it('同じ計測日時で値が違えば、上書きする（受信日時も更新）。保存・連携に積むのは、その分だけ', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T2, harvestCount: 9 }));
    await context.container.ingestionService.runSource('robot');
    context.clock.advance(60_000);
    await place(context, robotFile({ timestamp: T2, harvestCount: 10 }));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary.recordCount).toBe(1);
    const changed = await observationOf(context, 'harvestCount', T2);
    expect(changed?.value).toBe(10);
    expect(changed?.receivedAt).toBe(context.clock.now().toISOString());
    expect(await queuedObservationCounts(context)).toEqual([1, 1]);
  });

  it('計測以外の部分だけが変わった（ファイルの内容は変わった）ときは、何も保存せず、連携にも積まず、受信日時も更新しない（停止を検知できる）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }, { writtenAt: 1 }));
    await context.container.ingestionService.runSource('robot');
    const firstReceivedAt = (await observationOf(context, 'harvestCount', T1))?.receivedAt;
    const latestBefore = await context.container.repositories.observations.latestReceivedAt();
    context.clock.advance(5 * 60_000);
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }, { writtenAt: 2 }));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 0, result: 'SUCCESS' });
    expect((await observationOf(context, 'harvestCount', T1))?.receivedAt).toBe(firstReceivedAt);
    expect(await context.container.repositories.observations.latestReceivedAt()).toEqual(
      latestBefore,
    );
    expect(await queuedObservationCounts(context)).toEqual([1]);
  });

  it('ファイルの内容が同じなら、何もしない（読み取りのあと、重複として扱う）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }));
    await context.container.ingestionService.runSource('robot');

    const again = await context.container.ingestionService.runSource('robot');

    expect(again).toMatchObject({ filesProcessed: 0, recordCount: 0 });
    expect(await queuedObservationCounts(context)).toEqual([1]);
  });

  it('古い計測日時の値は、ファイルから消えても、反映しない（観測値を消さない）。最新の値だけのファイルに、書き換わっても、履歴が積み上がる', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }));
    await context.container.ingestionService.runSource('robot');
    context.clock.advance(15 * 60_000);
    await place(context, robotFile({ timestamp: T2, harvestCount: 9 }));
    await context.container.ingestionService.runSource('robot');
    context.clock.advance(15 * 60_000);
    await place(context, robotFile({ timestamp: T3, harvestCount: 7 }));

    await context.container.ingestionService.runSource('robot');

    const harvest = (await observationsOf(context))
      .filter((item) => item.itemKey === 'harvestCount')
      .map((item) => [item.observedAt, item.value, item.isDeleted]);
    expect(harvest).toEqual(
      expect.arrayContaining([
        [new Date(T1).toISOString(), 12, false],
        [new Date(T2).toISOString(), 9, false],
        [new Date(T3).toISOString(), 7, false],
      ]),
    );
    expect(harvest).toHaveLength(3);
  });

  it('評価は、変わった設備だけを更新する（変わらなければ、評価し直さない）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }, { writtenAt: 1 }));
    await context.container.ingestionService.runSource('robot');
    const before = await context.container.repositories.evaluations.listLatest(ROBOT_ID);
    context.clock.advance(5 * 60_000);
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }, { writtenAt: 2 }));

    await context.container.ingestionService.runSource('robot');

    expect(await context.container.repositories.evaluations.listLatest(ROBOT_ID)).toEqual(before);
  });

  it('不正な値も、同じ規則で扱う（値が変わらなければ触らない。変わったら、上書きする）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, statusCode: 'NO_SUCH_CODE' }));
    const first = await context.container.ingestionService.runSource('robot');
    context.clock.advance(60_000);
    await place(
      context,
      robotFile({ timestamp: T1, statusCode: 'NO_SUCH_CODE' }, { writtenAt: 2 }),
    );
    const second = await context.container.ingestionService.runSource('robot');
    context.clock.advance(60_000);
    await place(context, robotFile({ timestamp: T1, statusCode: 'RUNNING' }));
    const third = await context.container.ingestionService.runSource('robot');

    expect(first.rejectedCount).toBe(1);
    expect(second.recordCount).toBe(0);
    expect(third.recordCount).toBe(1);
    expect((await observationOf(context, 'statusCode', T1))?.value).toBe('RUNNING');
  });
});

describe('書き換えの最中のファイルを読まない（更新日時が 1 秒以内は、次の周期に回す）', () => {
  it('更新日時が 1 秒以内のファイルは、読まずに、次の周期に回す。更新から 1 秒より後になったら、読む', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }), 500);

    const deferred = await context.container.ingestionService.runSource('robot');
    context.clock.advance(5_000);
    const next = await context.container.ingestionService.runSource('robot');

    expect(deferred).toMatchObject({ filesProcessed: 0, recordCount: 0, result: 'SUCCESS' });
    expect(await observationsOf(context)).toHaveLength(next.recordCount);
    expect(next).toMatchObject({ filesProcessed: 1, recordCount: 1 });
  });

  it('更新日時がちょうど 1 秒前でも、回す（1 秒以内）。1 秒を超えたら、読む', async () => {
    const context = await setup();
    const content = robotFile({ timestamp: T1, harvestCount: 12 });
    await place(context, content, 1_000);
    const atBoundary = await context.container.ingestionService.runSource('robot');
    // 更新日時は、整数秒のまま。時計を 1 ミリ秒だけ進めて、更新から 1,001 ミリ秒にする
    await place(context, content, 1_001);

    const beyond = await context.container.ingestionService.runSource('robot');

    expect(atBoundary.filesProcessed).toBe(0);
    expect(beyond.filesProcessed).toBe(1);
  });

  it('安全策: 更新日時が、こちらの現在時刻より未来のときは、回さずに読む（時計のずれで、永遠に取り込まれないのを避ける）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }), -60_000);

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 1 });
  });

  it('安全策: 同じファイルが、2 周期続けて回されたら、3 周期目は、回さずに読む', async () => {
    const context = await setup();
    const content = robotFile({ timestamp: T1, harvestCount: 12 });
    await place(context, content, 100);
    const first = await context.container.ingestionService.runSource('robot');
    // 書き換えが続く（1 秒後に、また書き換わり、更新から 100 ミリ秒）
    context.clock.advance(1_000);
    await place(context, content, 100);
    const second = await context.container.ingestionService.runSource('robot');
    context.clock.advance(1_000);
    await place(context, content, 100);

    const third = await context.container.ingestionService.runSource('robot');

    expect([first.filesProcessed, second.filesProcessed, third.filesProcessed]).toEqual([0, 0, 1]);
  });

  it('回したあと、読めたら、数えをやり直す（次に回されるときは、また 2 周期まで）', async () => {
    const context = await setup();
    await place(context, robotFile({ timestamp: T1, harvestCount: 12 }), 100);
    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');
    await place(context, robotFile({ timestamp: T2, harvestCount: 9 }), 100);

    const again = await context.container.ingestionService.runSource('robot');

    expect(again.filesProcessed).toBe(0);
  });
});
