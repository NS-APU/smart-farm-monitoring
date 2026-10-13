/**
 * UC-11 農業情報基盤へデータを連携する（SC-11 の連携の状況。FR-8.1〜FR-8.4、NFR-2.1、NFR-2.2）。
 * UI を持たないユースケースのため、連携キューに積まれたデータを、ジョブ（JB-03）で送信し、結果を SC-11 の連携の状況で確認する。
 * 農業情報基盤の停止・復旧・拒否は、モックの切り替え（開発用 API）で再現し、受け取った内容は、モックの記録で確認する（dev_spec.md 5.1）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. システムが、連携対象のデータを農業情報基盤へ送る
 *               2. 連携対象は、生データ（ロボットデータ・環境センサーデータ・人手入力データ）と、
 *                  派生データ（メトリクス・評価観点別診断結果・推奨アクション・分析結果・インサイト）とする
 *               3. システムが、連携の結果（成功・失敗）を記録する
 *   代替フロー  農業情報基盤が停止している場合は、連携を保留し、本システムの他のユースケース（UC-01〜UC-10）は影響を受けずに継続する。
 *               復旧後の扱い（暫定: 保留・失敗の項目を、積んだ順にすべて送る）。連携の結果（成功・失敗・保留）は記録し、UC-16 で確認する
 *   事後条件    連携対象のデータが農業情報基盤に反映されている。または、連携の保留が記録されている
 *
 * 値の同値分割: 連携対象の種類（ロボット・環境センサー・人手入力の生データ、評価結果の派生データ）、農業情報基盤の状態
 * （稼働・停止（保留）・拒否（失敗）・遅延）、再送の間隔（5分から倍々。上限12時間。間隔の前後）、停止の長さ（短い・長い）。
 * 連携の内容（取り込み元・人手入力ごとの生データ、観点別の評価結果）、人手入力の修正・削除、1回の送信の上限（100件）も確認する。
 * 関連するユースケース: UC-08・UC-09・UC-07（連携対象の元）、UC-10（評価・通知）、UC-16（連携の結果の確認）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  addEntry,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  ROBOT_ID,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  runJob,
  sensorCsv,
  setMock,
} from './support/app.ts';
import { federationRows } from './support/ingestion.ts';
import { hoursAgo, NOW, shot } from './support/viewpoint-scenarios.ts';

interface ReceivedItem {
  readonly federationItemId: string;
  readonly targetType: string;
  readonly targetRef: string;
  readonly payload: unknown;
}

interface Received {
  readonly items: readonly ReceivedItem[];
}

async function received(request: Parameters<typeof prepareApp>[0]): Promise<Received['items']> {
  return (await apiOk<Received>(request, 'GET', '/dev/mocks/federation/received')).items;
}

async function queue(request: Parameters<typeof prepareApp>[0]) {
  return (
    await apiOk<{ queue: Record<'PENDING' | 'SENT' | 'FAILED' | 'HELD', number> }>(
      request,
      'GET',
      '/federation/logs',
    )
  ).queue;
}

/** 連携対象を用意する: ロボットデータ・環境センサーデータの取り込み、人手入力。評価の結果（派生データ）も積まれる。 */
async function produceData(request: Parameters<typeof prepareApp>[0]): Promise<void> {
  placeFile('robot', 'robot.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]));
  placeFile(
    'environment-sensor',
    'sensor.csv',
    sensorCsv([{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
  );
  await apiOk(request, 'POST', '/ingestion/robot/run');
  await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
  await addEntry(request, {
    category: 'FAILURE',
    observedAt: hoursAgo(1),
    items: { failureCount: 1, recoveryMinutes: 30 },
  });
}

async function openStatus(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/settings/ingestion');
  await expect(page.getByTestId('federation-section')).toBeVisible();
}

const queueCount = (page: Page, status: string) =>
  page.getByTestId(`queue-${status}`).locator('strong');

test.describe('基本フロー: 連携対象のデータ（生データ・派生データ）を農業情報基盤へ送り、結果を記録する', () => {
  test('ロボットデータ・環境センサーデータ・人手入力の生データと、評価結果の派生データを、連携キューに積み、連携ジョブ（JB-03）で送信すると、農業情報基盤が受け取り、成功を記録する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await produceData(request);
    const pending = await queue(request);
    expect(pending.PENDING).toBeGreaterThanOrEqual(4);

    await runJob(request, 'JB-03');

    const items = await received(request);
    expect(items).toHaveLength(pending.PENDING);
    // 生データ（取り込みごと2件・人手入力1件）と、派生データ（評価結果）
    expect(items.filter((item) => item.targetType === 'OBSERVATION')).toHaveLength(3);
    expect(items.filter((item) => item.targetType === 'EVALUATION').length).toBeGreaterThan(0);
    await openStatus(page);
    await expect(federationRows(page)).toHaveCount(1);
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(federationRows(page).first().locator('td').nth(2)).toHaveText(
      String(pending.PENDING),
    );
    await expect(queueCount(page, 'SENT')).toHaveText(String(pending.PENDING));
    await expect(queueCount(page, 'PENDING')).toHaveText('0');
    await shot(page, testInfo, 'uc11-sent');
  });

  test('送信済みの項目は、もう一度送らない（連携ジョブを繰り返しても、二重に送らない）', async ({
    request,
  }) => {
    await prepareApp(request);
    await produceData(request);
    await runJob(request, 'JB-03');
    const first = (await received(request)).length;

    await runJob(request, 'JB-03');
    await runJob(request, 'JB-03');

    expect(await received(request)).toHaveLength(first);
  });

  test('連携のジョブは、定期の実行（スケジューラ。5分ごと）でも、送信する', async ({ request }) => {
    await prepareApp(request);
    await produceData(request);

    const first = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick', {});

    expect(first.executed).toContain('JB-03');
    expect((await received(request)).length).toBeGreaterThan(0);
    // 5分ごと: 4分後は実行せず、5分後に実行する
    await advanceMinutes(request, 4);
    const early = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick', {});
    expect(early.executed).not.toContain('JB-03');
    await advanceMinutes(request, 1);
    const due = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick', {});
    expect(due.executed).toContain('JB-03');
  });
});

test.describe('連携対象の内容: 生データ（ロボット・環境センサー・人手入力）と、派生データ（メトリクス・診断結果・推奨アクション）', () => {
  test('生データは、取り込み元・人手入力ごとに、設備・項目・値を含めて送る。派生データは、観点・ステータス・メトリクス・診断メッセージ・推奨アクションを含めて送る', async ({
    request,
  }) => {
    await prepareApp(request);
    await produceData(request);

    await runJob(request, 'JB-03');

    const items = await received(request);
    // 生データ: ロボットデータ（取り込み）
    const robot = items.filter((item) => item.targetRef.startsWith('robot#'));
    expect(robot).toHaveLength(1);
    expect(robot[0]).toMatchObject({
      targetType: 'OBSERVATION',
      payload: {
        sourceId: 'robot',
        observations: expect.arrayContaining([
          expect.objectContaining({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10 }),
        ]),
      },
    });
    // 生データ: 環境センサーデータ（取り込み）
    const sensor = items.filter((item) => item.targetRef.startsWith('environment-sensor#'));
    expect(sensor).toHaveLength(1);
    expect(sensor[0]).toMatchObject({
      targetType: 'OBSERVATION',
      payload: {
        sourceId: 'environment-sensor',
        observations: expect.arrayContaining([
          expect.objectContaining({ itemKey: 'temperatureCelsius', value: 40 }),
        ]),
      },
    });
    // 生データ: 人手入力データ
    const manual = items.filter((item) => item.targetRef.startsWith('manual-entry#'));
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      targetType: 'OBSERVATION',
      payload: {
        observations: expect.arrayContaining([
          expect.objectContaining({ itemKey: 'failureCount', value: 1, isDeleted: false }),
          expect.objectContaining({ itemKey: 'recoveryMinutes', value: 30, isDeleted: false }),
        ]),
      },
    });
    // 派生データ: 観点別の診断結果（ステータス・メトリクス・診断メッセージ・推奨アクション）
    const environment = items.filter(
      (item) =>
        item.targetType === 'EVALUATION' && item.targetRef.endsWith('#environmentalAdaptability'),
    );
    expect(environment).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          viewpointId: 'environmentalAdaptability',
          status: 'ERROR',
          metrics: expect.objectContaining({ temperatureCelsius: expect.anything() }),
          diagnosticMessage: expect.stringMatching(/.+/),
          recommendedAction: expect.anything(),
          evaluatedAt: expect.any(String),
        }),
      }),
    );
  });

  test('人手入力の修正・削除も、生データとして連携する（修正前の値は削除済みとして、修正後の値とあわせて送る）', async ({
    request,
  }) => {
    await prepareApp(request);
    const created = await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(3),
      items: { emergencyStopCount: 1 },
    });
    await runJob(request, 'JB-03');
    const sentBefore = (await received(request)).length;

    const entry = {
      equipmentId: ROBOT_ID,
      category: 'SAFETY',
      observedAt: hoursAgo(3),
      items: { emergencyStopCount: 2 },
    };
    const updated = await api(request, 'PUT', `/manual-entries/${created.entry.entryId}`, entry);
    expect(updated.status()).toBe(200);
    const deleted = await api(request, 'DELETE', `/manual-entries/${created.entry.entryId}`);
    expect(deleted.status()).toBe(204);
    await runJob(request, 'JB-03');

    const added = (await received(request))
      .slice(sentBefore)
      .filter((item) => item.targetRef === `manual-entry#${created.entry.entryId}`);
    expect(added).toHaveLength(2);
    // 修正: 修正前（1回・削除済み）と、修正後（2回）
    expect(added[0]).toMatchObject({
      payload: {
        observations: expect.arrayContaining([
          expect.objectContaining({ itemKey: 'emergencyStopCount', value: 1, isDeleted: true }),
          expect.objectContaining({ itemKey: 'emergencyStopCount', value: 2, isDeleted: false }),
        ]),
      },
    });
    // 削除: 削除時点の値（修正後の2回）が、削除済みとして送られる
    expect(added[1]).toMatchObject({
      payload: {
        observations: [
          expect.objectContaining({ itemKey: 'emergencyStopCount', value: 2, isDeleted: true }),
        ],
      },
    });
  });

  test('連携の対象が、1回の送信の上限（100件）を超えても、次の連携ジョブで続きを、積んだ順に送る（失われない）', async ({
    request,
  }) => {
    await prepareApp(request);
    const entryIds: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const created = await addEntry(request, {
        category: 'SAFETY',
        observedAt: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
        items: { emergencyStopCount: 0 },
      });
      entryIds.push(created.entry.entryId);
    }
    const total = (await queue(request)).PENDING;
    expect(total).toBeGreaterThan(100);

    await runJob(request, 'JB-03');
    expect(await received(request)).toHaveLength(100);
    expect((await queue(request)).PENDING).toBe(total - 100);

    await runJob(request, 'JB-03');
    expect(await received(request)).toHaveLength(total);
    expect((await queue(request)).PENDING).toBe(0);
    // 積んだ順（登録順）に送られる
    const refs = (await received(request))
      .filter((item) => item.targetRef.startsWith('manual-entry#'))
      .map((item) => item.targetRef);
    expect(refs).toEqual(entryIds.map((entryId) => `manual-entry#${entryId}`));
  });
});

test.describe('代替フロー: 農業情報基盤が停止している場合は、連携を保留し、他のユースケースは影響を受けずに継続する', () => {
  test('停止中は、連携を「保留」にして記録する（連携キューの保留の件数が増える）。取り込み・ダッシュボード・手動入力・通知は、通常どおり動く', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');

    await produceData(request);
    await runJob(request, 'JB-03');

    expect(await received(request)).toHaveLength(0);
    await openStatus(page);
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('保留');
    await expect(federationRows(page).first()).toContainText(
      '農業情報基盤が利用できないため、連携を保留しました',
    );
    await expect(queueCount(page, 'HELD')).not.toHaveText('0');
    await expect(queueCount(page, 'SENT')).toHaveText('0');
    await shot(page, testInfo, 'uc11-held');
    // 他のユースケースは継続する（UC-01〜UC-10）
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');
    await page.goto('/notifications');
    await expect(page.getByTestId('notification-row').first()).toBeVisible();
    await page.goto('/data-entry/list');
    await expect(page.getByTestId('entry-row')).toHaveCount(1);
    await page.goto('/observations');
    await expect(page.getByTestId('observation-row').first()).toBeVisible();
  });

  test('農業情報基盤が復旧すると、保留していた項目をすべて送る（失われない。停止中に増えたデータも含む）', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    await produceData(request);
    await runJob(request, 'JB-03');
    const held = (await queue(request)).HELD;
    expect(held).toBeGreaterThan(0);
    // 停止中も、データは増える
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(2),
      items: { emergencyStopCount: 0 },
    });
    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 6);

    await runJob(request, 'JB-03');

    const after = await queue(request);
    expect(after.HELD).toBe(0);
    expect(after.PENDING).toBe(0);
    expect(after.SENT).toBeGreaterThan(held);
    expect((await received(request)).length).toBe(after.SENT);
  });

  test('停止が長く続いても（数日）、連携を保留したまま、本システムは単独で稼働し続ける。復旧後に、まとめて送る', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    await produceData(request);
    for (let day = 0; day < 3; day += 1) {
      await advanceMinutes(request, 24 * 60);
      await runJob(request, 'JB-03');
    }
    // 停止中も、取り込み・評価・通知は動く
    await apiOk(request, 'POST', '/ingestion/robot/run');
    expect(await received(request)).toHaveLength(0);

    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 24 * 60);
    await runJob(request, 'JB-03');

    expect((await queue(request)).HELD).toBe(0);
    expect((await received(request)).length).toBeGreaterThan(0);
  });
});

test.describe('農業情報基盤が受け付けない場合（拒否）と、再送の間隔', () => {
  test('拒否された場合は、「失敗」を記録し、連携キューの失敗の件数が増える。受け付けるようになれば、再送で送られる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'REJECT');
    await produceData(request);

    await runJob(request, 'JB-03');

    await openStatus(page);
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('失敗');
    await expect(federationRows(page).first()).toContainText('農業情報基盤への連携に失敗しました');
    const failed = (await queue(request)).FAILED;
    expect(failed).toBeGreaterThan(0);
    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-03');
    expect((await queue(request)).FAILED).toBe(0);
    expect((await received(request)).length).toBeGreaterThanOrEqual(failed);
  });

  test('再送の間隔は、5分から倍々（5分・10分・20分）。次の試行の時刻の前は、再送しない（間隔の境界）', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    await produceData(request);
    const logCount = async () =>
      (await apiOk<{ items: unknown[] }>(request, 'GET', '/federation/logs?limit=100')).items
        .length;

    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(1);
    // 1回目の失敗 → 次の試行は、5分後。4分では、再送しない
    await advanceMinutes(request, 4);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(1);
    // 5分（境界）で、再送する。2回目の失敗 → 次は、10分後
    await advanceMinutes(request, 1);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(2);
    await advanceMinutes(request, 9);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(2);
    await advanceMinutes(request, 1);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(3);
    // 3回目の失敗 → 次は、20分後
    await advanceMinutes(request, 19);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(3);
    await advanceMinutes(request, 1);
    await runJob(request, 'JB-03');
    expect(await logCount()).toBe(4);
  });

  test('農業情報基盤の応答が遅くても（遅延）、連携は成功する（待たずに、時計だけが進む）', async ({
    request,
  }) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/dev/mocks/federation', { mode: 'SLOW', delayMs: 30_000 });
    await produceData(request);

    await runJob(request, 'JB-03');

    expect((await received(request)).length).toBeGreaterThan(0);
  });
});

test.describe('シナリオ: 取り込み → 評価・通知 → 連携 → 連携の結果の確認（UC-09 → UC-10 → UC-11 → UC-16）', () => {
  test('異常なセンサーデータを取り込んで通知が作られ、農業情報基盤の停止中は保留し、復旧後に、評価結果を含めて送られ、連携の状況に反映される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    placeFile(
      'environment-sensor',
      'sensor.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');
    await page
      .getByTestId('source-environment-sensor')
      .getByRole('button', { name: '即時取得' })
      .click();
    await expect(page.getByTestId('result-environment-sensor')).toContainText(
      '取得しました（成功）',
    );
    // UC-10: 異常の通知
    await page.goto('/notifications');
    await expect(
      page.getByTestId('notification-row').filter({ hasText: '環境適応性' }).first(),
    ).toContainText('異常');
    // UC-11: 停止中は、保留
    await runJob(request, 'JB-03');
    await page.goto('/settings/ingestion');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('保留');

    // 復旧 → 送信（評価結果を含む）
    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-03');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();

    await expect(federationRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(queueCount(page, 'HELD')).toHaveText('0');
    const items = await received(request);
    expect(items.some((item) => item.targetType === 'EVALUATION')).toBe(true);
    expect(items.some((item) => item.targetType === 'OBSERVATION')).toBe(true);
    await shot(page, testInfo, 'uc11-scenario');
  });
});
