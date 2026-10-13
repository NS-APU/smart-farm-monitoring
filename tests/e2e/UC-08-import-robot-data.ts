/**
 * UC-08 ロボットデータを自動で取り込む（SC-11 の即時取得、確認は SC-09・SC-02・SC-11。FR-1.1、FR-1.3、FR-1.6、FR-1.9〜FR-1.12）。
 * UI を持たないユースケースのため、画面（SC-11 の即時取得）と、開発用 API（ジョブの起動・時計・モックの停止）で、
 * 取り込みを起動し、結果を、SC-09（取り込み済みデータ）・SC-02（評価の更新）・SC-11（取り込みのログ）で確認する（dev_spec.md 5.1）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. システムが、ファイルサーバー上の新しいロボットデータを検知する
 *               2. システムが、ファイルを読み込み、内容を検証する
 *               3. システムが、ロボットとハウスに対応づけて保存する
 *               4. システムが、評価（メトリクス・診断）を更新する
 *   代替フロー  ・ファイルが読めない、形式・項目が仕様と異なる場合は、エラーとして記録し、取り込みを継続する
 *               ・接続できない場合は、再試行する。再試行しても失敗した場合は、通知する（UC-24）。取り込みの失敗が他のユースケースを妨げない
 *               ・取り込みの成否は、ログとして記録する（UC-16）
 *               ・同じファイルを重複して取り込まない
 *
 * 値の同値分割: ファイルの内容（正常・一部の記録が不正・欠損・形式違い・空の記録・登録のない機体ID・遅延・未来の計測日時・
 * 複数のロボット（別のハウス））、ステータスコード
 * （正常・注意・異常のカテゴリ、未定義）、起動の経路（即時取得・定期（JB-01）・スケジューラ）、同じファイルの再取り込み
 * （同じ内容・名前を変えた同じ内容・同じ名前で内容が変わった）、接続（成功・停止）。
 * 関連するユースケース: UC-15（設定）・UC-16（ログ）・UC-20（SC-09 で確認）・UC-01（評価）・UC-24（失敗の通知）・UC-11（連携）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_EXTERNAL_ID,
  ROBOT_ID,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  openAs,
  placeFile,
  placeFixture,
  prepareApp,
  robotJson,
  runJob,
  sensorCsv,
  setMock,
  unreadBadge,
} from './support/app.ts';
import { logRows, runNow } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';
import { openIngestion, openObservationsPage as openObservations } from './support/pages.ts';

const observationRows = (page: Page) => page.getByTestId('observation-row');

async function dashboardStatus(page: Page, viewpointId: string): Promise<string> {
  await page.goto('/');
  const badge = page.getByTestId(`card-${viewpointId}`).locator('.status-badge');
  await expect(badge).toBeVisible();
  return (await badge.textContent())?.replace(/[^正常注意異常不明]/g, '') ?? '';
}

/** 収穫速度の評価に必要な、15分前・30分前の2件の記録（収穫数 10 / 収穫稼働時間 0.1h = 36秒/果実、走行停止率 2%）。 */
function speedRecords(statusCode: string) {
  const fields = {
    harvestCount: 10,
    harvestSecondsPerFruit: 36,
    operatingHours: 0.25,
    standbyHours: 0.01,
    harvestOperatingHours: 0.1,
    travelStoppedHours: 0.002,
    statusCode,
  };
  return [
    { hoursAgo: 0.5, fields },
    { hoursAgo: 0.25, fields },
  ];
}

test.describe('基本フロー: 新しいロボットデータを検知し、検証して、ロボットとハウスに対応づけて保存し、評価を更新する', () => {
  test('ファイルサーバーに置いたロボットデータを取り込むと、取り込み済みデータ（自動取り込み・有効）に保存され、ログに記録され、評価（収穫速度）が更新される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // 取り込み前: 評価の元データがないため、収穫速度は「不明」
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
      '不明',
    );
    // 1. 新しいロボットデータが、ファイルサーバー上に配置される
    placeFile('robot', 'robot-2026-10-09.json', robotJson(speedRecords('HARVESTING')));

    // 2〜3. 検知・読み込み・検証・保存（SC-11 の即時取得）
    await page.goto('/settings/ingestion');
    const result = await runNow(page, 'robot');
    await expect(result).toContainText('取得しました（成功）');
    await expect(result).toContainText('ファイル 1 件、取り込み 14 件、読み取れなかった記録 0 件');
    // 取り込みの成否は、ログに記録される（取り込み元・成功・ファイル数・取り込み件数・読み取れなかった記録の数。UC-16）
    const log = logRows(page).first();
    await expect(log).toHaveAttribute('data-result', 'SUCCESS');
    await expect(log).toContainText('ロボットデータ');
    await expect(log.locator('td').nth(3)).toHaveText('1');
    await expect(log.locator('td').nth(4)).toHaveText('14');
    await expect(log.locator('td').nth(5)).toHaveText('0');
    await shot(page, testInfo, 'uc08-ingestion');

    // 3. ロボットに対応づけて保存されている（SC-09）
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(14);
    for (const row of await observationRows(page).all()) {
      await expect(row).toContainText('収穫ロボット1');
      await expect(row).toContainText('自動取り込み');
      await expect(row.locator('.quality')).toHaveText('有効');
    }
    await expect(observationRows(page).filter({ hasText: '収穫数' }).first()).toContainText('10個');
    await expect(
      observationRows(page).filter({ hasText: 'ステータスコード' }).first(),
    ).toContainText('収穫中');
    await shot(page, testInfo, 'uc08-observations');

    // 4. 評価が更新される（ハウスの収穫速度: 36秒/果実・走行停止率 2% → 正常）
    expect(await dashboardStatus(page, 'harvestSpeed')).toBe('正常');
    await expect(page.getByTestId('card-harvestSpeed')).toContainText('36.0秒/果実');
  });

  test('ロボットは、データ上の識別子（機体ID）で、登録されたロボットと、そのロボットが属するハウスに対応づけて保存される（複数のハウス・ロボット）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // 別のハウスと、そのハウスのロボットを登録する（UC-12。事前条件: 取り込み対象のロボットが、登録されている）
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'HOUSE-02',
      equipmentType: 'FACILITY',
      name: 'ハウス2',
    });
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'ROBOT-02',
      equipmentType: 'ROBOT',
      name: '収穫ロボット2',
      facilityId: 'HOUSE-02',
      externalId: 'ROBOT-SAMPLE-02',
    });
    placeFile(
      'robot',
      'robot-01.json',
      robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]),
    );
    placeFile(
      'robot',
      'robot-02.json',
      robotJson(
        [
          { hoursAgo: 1, fields: { harvestCount: 20 } },
          { hoursAgo: 0.5, fields: { harvestCount: 30 } },
        ],
        'ROBOT-SAMPLE-02',
      ),
    );
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    await expect(await runNow(page, 'robot')).toContainText(
      'ファイル 2 件、取り込み 3 件、読み取れなかった記録 0 件',
    );

    // ロボットごとに、そのロボットの記録だけが、保存されている
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(3);
    await expect(observationRows(page).filter({ hasText: '収穫ロボット1' })).toHaveCount(1);
    await expect(observationRows(page).filter({ hasText: '収穫ロボット2' })).toHaveCount(2);
    // ハウスで絞り込むと、そのハウスに属するロボットの記録だけが出る
    await page.getByLabel('設備', { exact: true }).selectOption(HOUSE_ID);
    await expect(observationRows(page)).toHaveCount(1);
    await expect(observationRows(page).first()).toContainText('収穫ロボット1');
    await expect(observationRows(page).first()).toContainText('10個');
    await page.getByLabel('設備', { exact: true }).selectOption('HOUSE-02');
    await expect(observationRows(page)).toHaveCount(2);
    await expect(observationRows(page).filter({ hasText: '収穫ロボット2' })).toHaveCount(2);
    await shot(page, testInfo, 'uc08-by-house');
    // API（設備IDでの絞り込み）でも、同じ結果になる
    for (const [equipmentId, count] of [
      [ROBOT_ID, 1],
      ['ROBOT-02', 2],
      ['SENSOR-01', 0],
    ] as const) {
      const body = await apiOk<{ items: { equipmentId: string }[] }>(
        request,
        'GET',
        `/observations?equipmentId=${equipmentId}&limit=100`,
      );
      expect(body.items).toHaveLength(count);
      expect(body.items.every((item) => item.equipmentId === equipmentId)).toBe(true);
    }
  });

  test('ステータスコードのカテゴリに応じて、評価が変わる（注意のコード: 注意、異常のコード: 異常）', async ({
    page,
    request,
  }) => {
    for (const item of [
      { code: 'STOPPED', status: '注意' },
      { code: 'HARVEST_ERROR', status: '異常' },
    ]) {
      await prepareApp(request);
      placeFile('robot', 'robot.json', robotJson(speedRecords(item.code)));
      await apiOk(request, 'POST', '/ingestion/robot/run');
      await alignBrowserClock(page);
      await openAs(page, '/');

      await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
        item.status,
      );
    }
  });

  test('定期の取り込み（JB-01）でも、同じように取り込まれる。取得間隔（15分）が過ぎるまでは、実行しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));

    await runJob(request, 'JB-01');
    placeFile('robot', 'b.json', robotJson([{ hoursAgo: 0.1, fields: { harvestCount: 3 } }]));
    await advanceMinutes(request, 5);
    await runJob(request, 'JB-01');
    await openIngestion(page);
    // 取得間隔の途中（5分後）は、b.json を取り込まない
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(1);
    await advanceMinutes(request, 11);
    await runJob(request, 'JB-01');

    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(2);
    await openObservations(page);
    await expect(observationRows(page).filter({ hasText: '収穫数' })).toHaveCount(3);
  });

  test('スケジューラ（時計を進めて tick）でも取り込まれる（取り込み・評価・連携・通知の配信を、間隔ごとに実行する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));

    const first = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick', {});
    await advanceMinutes(request, 1);
    const second = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick', {});

    // 取り込みのジョブ（JB-01）は、1分ごとに起動するが、取り込み元ごとの取得間隔（15分）が来たときだけ、実行する
    expect(first.executed).toEqual(expect.arrayContaining(['JB-01', 'JB-02', 'JB-03', 'JB-04']));
    expect(second.executed).toContain('JB-01');
    await openIngestion(page);
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(1);
    // 取り込まれたデータが、取り込み済みデータに現れる
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(14);
  });
});

test.describe('代替フロー: 同じファイルを重複して取り込まない', () => {
  test('同じファイルを、もう一度取得しても、取り込まない。名前を変えた同じ内容のファイルも、取り込まない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    const content = robotJson(speedRecords('RUNNING'));
    placeFile('robot', 'a.json', content);
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');
    await expect(await runNow(page, 'robot')).toContainText('ファイル 1 件、取り込み 14 件');

    // 同じファイル → 取り込まない
    await expect(await runNow(page, 'robot')).toContainText('ファイル 0 件、取り込み 0 件');
    // 名前を変えた同じ内容 → 取り込まない
    placeFile('robot', 'copy-of-a.json', content);
    await expect(await runNow(page, 'robot')).toContainText('ファイル 0 件、取り込み 0 件');

    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(14);
  });

  test('同じ名前で、内容が変わったファイルは、新しい版として取り込む（同じ一意キーは、二重に数えず、上書きする）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]));
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');
    await runNow(page, 'robot');
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(1);
    await expect(observationRows(page).first()).toContainText('10個');

    // 同じ時刻の値が、訂正されたファイル（同じ名前）
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 12 } }]));
    await page.goto('/settings/ingestion');
    await expect(await runNow(page, 'robot')).toContainText('ファイル 1 件、取り込み 1 件');

    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(1);
    await expect(observationRows(page).first()).toContainText('12個');
  });

  test('新しいファイルだけを取り込む（取り込み済みのファイルはそのまま。追加されたファイルのみ）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 1, fields: { harvestCount: 1 } }]));
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');
    await runNow(page, 'robot');
    placeFile('robot', 'b.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 2 } }]));

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('ファイル 1 件、取り込み 1 件');
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(2);
  });
});

test.describe('代替フロー: 形式・項目が仕様と異なる場合は、エラーとして記録し、取り込みを継続する', () => {
  test('形式違いのファイルと正常なファイルが混在しても、正常なファイルは取り込む（一部成功）。形式違いのファイルは、記録して、再び取り込まない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-003-broken.json');
    placeFile('robot', 'good.json', robotJson(speedRecords('RUNNING')));
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const first = await runNow(page, 'robot');
    await expect(first).toContainText('取得しました（一部成功）');
    await expect(first).toContainText('ファイル 2 件、取り込み 14 件');
    await expect(logRows(page).first()).toContainText('1件のファイルを取り込めませんでした');
    const second = await runNow(page, 'robot');

    await expect(second).toContainText('ファイル 0 件');
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(14);
  });

  test('一部の記録が不正（範囲外・未定義のステータスコード・欠損・時刻なし）なファイルは、不正な値を「不正」「欠損」として保持する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-002-partial.json');
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('取得しました（一部成功）');
    await expect(result).toContainText('取り込み 7 件、読み取れなかった記録 4 件');
    await openObservations(page);
    const invalid = observationRows(page).filter({ has: page.locator('.quality-invalid') });
    const missing = observationRows(page).filter({ has: page.locator('.quality-missing') });
    await expect(invalid).toHaveCount(2);
    await expect(invalid.filter({ hasText: '収穫数' })).toContainText('-3');
    await expect(invalid.filter({ hasText: 'ステータスコード' })).toContainText('UNDEFINED_CODE');
    await expect(missing).toHaveCount(1);
    await expect(missing.first()).toContainText('収穫数');
    await expect(missing.first()).toContainText('—');
    await shot(page, testInfo, 'uc08-invalid-values');
  });

  test('計測日時が、受信日時（現在）より未来の記録は「不正」にする（時計のずれの許容 5 分以内は、有効）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile(
      'robot',
      'future.json',
      robotJson([
        { hoursAgo: -1, fields: { harvestCount: 7 } },
        { hoursAgo: -0.05, fields: { harvestCount: 8 } },
      ]),
    );
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('取得しました（一部成功）');
    await expect(result).toContainText('取り込み 1 件、読み取れなかった記録 1 件');
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(2);
    const invalid = observationRows(page).filter({ has: page.locator('.quality-invalid') });
    await expect(invalid).toHaveCount(1);
    await expect(invalid.first()).toContainText('7個');
    const valid = observationRows(page).filter({ has: page.locator('.quality-valid') });
    await expect(valid).toHaveCount(1);
    await expect(valid.first()).toContainText('8個');
  });

  test('登録のない機体ID（robotId）のファイルは、読み取れなかった記録として数え、保存しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile(
      'robot',
      'unknown.json',
      robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 5 } }], 'ROBOT-UNKNOWN-99'),
    );
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('ファイル 1 件、取り込み 0 件、読み取れなかった記録 1 件');
    await openObservations(page);
    await expect(page.getByTestId('observations-empty')).toBeVisible();
  });

  const formats: readonly { name: string; content: string; summary: string }[] = [
    { name: '空のファイル', content: '', summary: '取得しました（失敗）' },
    {
      name: 'JSON でないテキスト',
      content: 'robotId=ROBOT-SAMPLE-01',
      summary: '取得しました（失敗）',
    },
    {
      name: 'records がない JSON',
      content: JSON.stringify({ robotId: ROBOT_EXTERNAL_ID }),
      summary: '取得しました（失敗）',
    },
    {
      name: '記録が0件の JSON（形式は正しい）',
      content: JSON.stringify({ robotId: ROBOT_EXTERNAL_ID, records: [] }),
      summary: '取得しました（成功）',
    },
  ];

  for (const item of formats) {
    test(`ファイルの形式: ${item.name}は「${item.summary.replace('取得しました', '')}」として記録し、他のファイルの取り込みを妨げない`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      placeFile('robot', 'x.json', item.content);
      await alignBrowserClock(page);
      await openAs(page, '/settings/ingestion');

      const result = await runNow(page, 'robot');

      await expect(result).toContainText(item.summary);
      // 続けて、正常なファイルを取り込める
      placeFile('robot', 'good.json', robotJson(speedRecords('RUNNING')));
      await expect(await runNow(page, 'robot')).toContainText('取り込み 14 件');
    });
  }
});

test.describe('代替フロー: 接続できない場合は、再試行し、失敗を記録する。取り込みの失敗が他のユースケースを妨げない', () => {
  test('ファイルサーバーが停止していると、再試行しても失敗し、ログにエラーを記録する。ダッシュボード・手動入力・通知の画面は、通常どおり使える', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('取得しました（失敗）');
    await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');
    // 再試行しても失敗した（試行回数は、3回）
    const logs = await apiOk<{ items: { attempts: number }[] }>(request, 'GET', '/ingestion/logs');
    expect(logs.items[0]?.attempts).toBe(3);
    // 他の機能への影響がない
    await page.goto('/');
    await expect(page.getByTestId('card-harvestSpeed')).toBeVisible();
    await page.goto('/data-entry');
    await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    // 復旧後は、取り込める
    await setMock(request, 'file-server', 'UP');
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));
    await page.goto('/settings/ingestion');
    await expect(await runNow(page, 'robot')).toContainText('取り込み 14 件');
  });

  test('再試行しても失敗した場合は、取り込み失敗の通知を作り（UC-24）、ログに失敗を記録する。置いてあったファイルは、復旧後の取り込みで取り込まれる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));

    // 再試行（最大3回）しても失敗 → 結果として FAILURE を返す
    const response = await api(request, 'POST', '/ingestion/robot/run');
    expect(await response.json()).toMatchObject({
      result: 'FAILURE',
      filesProcessed: 0,
      recordCount: 0,
      attempts: 3,
    });
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(unreadBadge(page)).toHaveText('1');
    await page.goto('/notifications');
    const notification = page.getByTestId('notification-row').filter({ hasText: 'データ取得失敗' });
    await expect(notification).toHaveCount(1);
    await expect(notification).toContainText('ロボットデータ');
    await expect(notification).toContainText('ファイルサーバーに接続できませんでした');

    // 復旧後の取り込みで、置いてあったファイルが取り込まれる（失敗した間も、ファイルは取り込み済みにならない）
    await setMock(request, 'file-server', 'UP');
    await page.goto('/settings/ingestion');
    await expect(await runNow(page, 'robot')).toContainText('取り込み 14 件');
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(2);
    await expect(logRows(page).first()).toHaveAttribute('data-result', 'SUCCESS');
    await expect(logRows(page).nth(1)).toHaveAttribute('data-result', 'FAILURE');
  });

  test('定期の取り込み（JB-01）で、ロボットのファイルが形式違いでも、環境センサーの取り込みは実行される（取り込み元ごとに独立）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-003-broken.json');
    placeFile(
      'environment-sensor',
      'sensor.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: 20, humidity: 60, illuminance: 30000, co2: 800 }]),
    );

    await runJob(request, 'JB-01');

    await openIngestion(page);
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' }).first()).toHaveAttribute(
      'data-result',
      'FAILURE',
    );
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' }).first()).toHaveAttribute(
      'data-result',
      'SUCCESS',
    );
  });

  test('ファイルサーバーの応答が遅くても（遅延）、時計を進めて待たずに、取り込める（遅延の再現）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/dev/mocks/file-server', { mode: 'SLOW', delayMs: 60_000 });
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    const result = await runNow(page, 'robot');

    await expect(result).toContainText('取り込み 14 件');
    const clock = await apiOk<{ now: string }>(request, 'GET', '/dev/clock');
    expect(new Date(clock.now).getTime()).toBeGreaterThan(Date.parse('2026-10-09T03:00:00.000Z'));
  });
});

test.describe('遅延したデータ（計測から受信まで60分を超える）の扱い', () => {
  test('受信が遅れたデータは「遅延」として保持し、評価には使う', async ({ page, request }) => {
    await prepareApp(request);
    // 計測は3時間前、受信は現在（3時間遅れ）
    placeFile(
      'robot',
      'late.json',
      robotJson(speedRecords('RUNNING').map((record) => ({ ...record, hoursAgo: 3 }))),
    );
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await alignBrowserClock(page);
    await openAs(page, '/observations');

    await expect(observationRows(page).first().locator('.quality')).toHaveText('遅延');
    expect(await dashboardStatus(page, 'harvestSpeed')).toBe('正常');
  });
});

test.describe('API でも確認する（取り込みの結果）', () => {
  test('即時取得の応答は、実行を待って、結果の概要（成功・ファイル数・取り込み件数）を返し、取り込み済みデータの API に反映される', async ({
    request,
  }) => {
    await prepareApp(request);
    placeFile('robot', 'a.json', robotJson(speedRecords('RUNNING')));

    const response = await api(request, 'POST', '/ingestion/robot/run');

    expect(response.status()).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceId: 'robot',
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 14,
      rejectedCount: 0,
    });
    const observations = await apiOk<{ items: unknown[] }>(
      request,
      'GET',
      '/observations?source=AUTO_IMPORT&limit=100',
    );
    expect(observations.items).toHaveLength(14);
  });
});
