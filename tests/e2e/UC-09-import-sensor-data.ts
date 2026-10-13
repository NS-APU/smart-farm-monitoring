/**
 * UC-09 環境センサーデータを自動で取り込む（SC-11 の即時取得、確認は SC-09・SC-02・SC-11。FR-1.2、FR-1.3、FR-1.6、FR-1.9〜FR-1.12）。
 * UI を持たないユースケースのため、UC-08 と同じ方法（dev_spec.md 5.1）で、SC-11 の即時取得と開発用 API から、取り込みを起動し、
 * 結果を SC-09・SC-02・SC-11 で確認する。
 *
 * ユースケースシナリオ: UC-08 と同様（対象がロボットデータではなく、環境センサーデータ（CSV））。
 *   基本フロー  ファイルサーバー上の新しいセンサーデータを検知し、検証して、センサーとハウスに対応づけて保存し、評価を更新する
 *   代替フロー  形式・項目が仕様と異なる場合はエラーとして記録し継続／接続できない場合は再試行し、失敗を通知（UC-24）／ログ（UC-16）／重複して取り込まない
 *
 * 値の同値分割: 温度（正常・注意・異常）、湿度の境界（0・100・100.1・-1）、欠損（空のセル）、不正（数値でない・列の不足・見出しの違い・
 * 登録のないセンサーID・ロボットの機体ID・未来の計測日時）、遅延、複数のハウス・センサー、起動の経路（即時取得・定期）、
 * 同じファイルの再取り込み、接続（成功・停止）。
 * 関連するユースケース: UC-08（同じ仕組みの取り込み）・UC-15・UC-16・UC-20・UC-01・UC-10（異常の通知）・UC-24。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_EXTERNAL_ID,
  SENSOR_EXTERNAL_ID,
  SENSOR_ID,
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

/** 15分前・30分前の2行（計測から受信まで60分以内）。 */
function rows(temperature: number | string, humidity: number | string = 60) {
  return [0.5, 0.25].map((hoursAgo) => ({
    hoursAgo,
    temperature,
    humidity,
    illuminance: 30_000,
    co2: 900,
  }));
}

test.describe('基本フロー: 新しいセンサーデータを検知し、検証して、センサーとハウスに対応づけて保存し、評価を更新する', () => {
  test('ファイルサーバーに置いたセンサーデータ（CSV）を取り込むと、取り込み済みデータ（自動取り込み・有効）に保存され、ログに記録され、環境適応性が更新される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('不明');
    placeFile('environment-sensor', 'sensor.csv', sensorCsv(rows(22)));

    await page.goto('/settings/ingestion');
    const result = await runNow(page, 'environment-sensor');
    await expect(result).toContainText('取得しました（成功）');
    await expect(result).toContainText('ファイル 1 件、取り込み 8 件、読み取れなかった記録 0 件');
    // 取り込みの成否は、ログに記録される（取り込み元・成功・ファイル数・取り込み件数・読み取れなかった記録の数。UC-16）
    const log = logRows(page).first();
    await expect(log).toHaveAttribute('data-result', 'SUCCESS');
    await expect(log).toContainText('環境センサーデータ');
    await expect(log.locator('td').nth(3)).toHaveText('1');
    await expect(log.locator('td').nth(4)).toHaveText('8');
    await expect(log.locator('td').nth(5)).toHaveText('0');
    await shot(page, testInfo, 'uc09-ingestion');

    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(8);
    for (const row of await observationRows(page).all()) {
      await expect(row).toContainText('環境センサー1');
      await expect(row).toContainText('自動取り込み');
      await expect(row).toContainText('環境情報');
      await expect(row.locator('.quality')).toHaveText('有効');
    }
    await expect(observationRows(page).filter({ hasText: '温度' }).first()).toContainText('22℃');
    await shot(page, testInfo, 'uc09-observations');

    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('正常');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText('22.0℃');
  });

  const evaluations: readonly { name: string; temperature: number; status: string }[] = [
    { name: '温度 22℃（正常）', temperature: 22, status: '正常' },
    { name: '温度 27℃（注意）', temperature: 27, status: '注意' },
    { name: '温度 40℃（異常）', temperature: 40, status: '異常' },
  ];

  for (const item of evaluations) {
    test(`${item.name}のデータを取り込むと、環境適応性が${item.status}になる`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      placeFile('environment-sensor', 'sensor.csv', sensorCsv(rows(item.temperature)));
      await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
      await alignBrowserClock(page);
      await openAs(page, '/');

      await expect(
        page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
      ).toContainText(item.status);
    });
  }

  test('異常なデータを取り込むと、異常の通知（UC-10）が作られる', async ({ page, request }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'sensor.csv', sensorCsv(rows(40)));
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await alignBrowserClock(page);
    await openAs(page, '/notifications');

    const notification = page
      .getByTestId('notification-row')
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー1' });
    await expect(notification).toContainText('異常');
    await expect(notification).toContainText('温度 40.0℃（異常）');
  });

  test('定期の取り込み（JB-01）でも取り込まれる。取得間隔（15分）が過ぎるまでは、新しいファイルを取り込まない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(22)));
    await runJob(request, 'JB-01');
    placeFile(
      'environment-sensor',
      'b.csv',
      sensorCsv([{ hoursAgo: 0.1, temperature: 23, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await advanceMinutes(request, 5);
    await runJob(request, 'JB-01');
    await alignBrowserClock(page);
    await openAs(page, '/observations');
    await expect(observationRows(page).filter({ hasText: '温度' })).toHaveCount(2);

    await advanceMinutes(request, 11);
    await runJob(request, 'JB-01');
    await page.reload();

    await expect(observationRows(page).filter({ hasText: '温度' })).toHaveCount(3);
  });

  test('センサーは、データ上の識別子（sensor_id）で、登録されたセンサーと、そのセンサーが属するハウスに対応づけて保存される（複数のハウス・センサー）。評価はハウスごとに行う', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // 別のハウスと、そのハウスのセンサーを登録する（UC-12。事前条件: 取り込み対象のセンサーが、登録されている）
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'HOUSE-02',
      equipmentType: 'FACILITY',
      name: 'ハウス2',
    });
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'SENSOR-02',
      equipmentType: 'SENSOR',
      name: '環境センサー2',
      facilityId: 'HOUSE-02',
      externalId: 'SENSOR-SAMPLE-02',
    });
    placeFile('environment-sensor', 'sensor-01.csv', sensorCsv(rows(22)));
    placeFile(
      'environment-sensor',
      'sensor-02.csv',
      sensorCsv(
        [{ hoursAgo: 0.25, temperature: 40, humidity: 60, illuminance: 30_000, co2: 900 }],
        'SENSOR-SAMPLE-02',
      ),
    );
    await openIngestion(page);

    await expect(await runNow(page, 'environment-sensor')).toContainText(
      'ファイル 2 件、取り込み 12 件、読み取れなかった記録 0 件',
    );

    // センサーごとに、そのセンサーの記録だけが保存されている
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(12);
    await expect(observationRows(page).filter({ hasText: '環境センサー1' })).toHaveCount(8);
    await expect(observationRows(page).filter({ hasText: '環境センサー2' })).toHaveCount(4);
    // ハウスで絞り込むと、そのハウスに属するセンサーの記録だけが出る
    await page.getByLabel('設備', { exact: true }).selectOption(HOUSE_ID);
    await expect(observationRows(page)).toHaveCount(8);
    await expect(observationRows(page).filter({ hasText: '環境センサー1' })).toHaveCount(8);
    await page.getByLabel('設備', { exact: true }).selectOption('HOUSE-02');
    await expect(observationRows(page)).toHaveCount(4);
    await expect(observationRows(page).filter({ hasText: '環境センサー2' })).toHaveCount(4);
    await expect(observationRows(page).filter({ hasText: '温度' })).toContainText('40℃');
    await shot(page, testInfo, 'uc09-by-house');
    // API（設備IDでの絞り込み）でも、同じ結果になる
    for (const [equipmentId, count] of [
      [SENSOR_ID, 8],
      ['SENSOR-02', 4],
      ['ROBOT-01', 0],
    ] as const) {
      const body = await apiOk<{ items: { equipmentId: string }[] }>(
        request,
        'GET',
        `/observations?equipmentId=${equipmentId}&limit=100`,
      );
      expect(body.items).toHaveLength(count);
      expect(body.items.every((item) => item.equipmentId === equipmentId)).toBe(true);
    }

    // 評価は、ハウスごとに行われる（ハウス1: 22℃ → 正常、ハウス2: 40℃ → 異常）
    await page.goto('/');
    await page.getByLabel('対象の設備').selectOption({ label: 'ハウス1' });
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('正常');
    await page.getByLabel('対象の設備').selectOption({ label: 'ハウス2' });
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText('40.0℃');
  });

  test('追加のデータを取り込むたびに、評価が更新される（22℃ の正常から、新しい 40℃ の異常へ）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(22)));
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await openAs(page, '/');
    const badge = page.getByTestId('card-environmentalAdaptability').locator('.status-badge');
    await expect(badge).toContainText('正常');

    placeFile(
      'environment-sensor',
      'b.csv',
      sensorCsv([{ hoursAgo: 0.05, temperature: 40, humidity: 60, illuminance: 30_000, co2: 900 }]),
    );
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await page.reload();

    // カードのステータスは、短期（最新の 40℃）と長期（期間の平均）のうち、悪い方（evaluation.md 5章）
    await expect(badge).toContainText('異常');
  });
});

test.describe('代替フロー: 同じファイルを重複して取り込まない', () => {
  test('同じファイル・名前を変えた同じ内容のファイルは、取り込まない。同じ名前で内容が変わったファイルは、新しい版として取り込む（二重に数えない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    const content = sensorCsv(rows(22));
    placeFile('environment-sensor', 'a.csv', content);
    await openIngestion(page);
    await expect(await runNow(page, 'environment-sensor')).toContainText(
      'ファイル 1 件、取り込み 8 件',
    );
    await expect(await runNow(page, 'environment-sensor')).toContainText('ファイル 0 件');
    placeFile('environment-sensor', 'copy.csv', content);
    await expect(await runNow(page, 'environment-sensor')).toContainText('ファイル 0 件');

    // 同じ名前で、温度が訂正されたファイル
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(23)));
    await expect(await runNow(page, 'environment-sensor')).toContainText(
      'ファイル 1 件、取り込み 8 件',
    );

    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(8);
    await expect(observationRows(page).filter({ hasText: '温度' }).first()).toContainText('23℃');
  });
});

test.describe('代替フロー: 形式・項目が仕様と異なる場合は、エラーとして記録し、取り込みを継続する', () => {
  test('見出しが違う CSV（形式違い）は、失敗として記録し、再び取り込まない。正常なファイルは取り込む', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-003-bad-header.csv');
    placeFile('environment-sensor', 'good.csv', sensorCsv(rows(22)));
    await openIngestion(page);

    const first = await runNow(page, 'environment-sensor');

    await expect(first).toContainText('取得しました（一部成功）');
    await expect(first).toContainText('ファイル 2 件、取り込み 8 件');
    await expect(logRows(page).first()).toContainText('1件のファイルを取り込めませんでした');
    await expect(await runNow(page, 'environment-sensor')).toContainText('ファイル 0 件');
  });

  test('欠損（空のセル）は、0 で代用せず「欠損」として保持し、評価に使わない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFile(
      'environment-sensor',
      'missing.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: '', humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    await expect(result).toContainText('取り込み 3 件、読み取れなかった記録 1 件');
    await openObservations(page);
    const missing = observationRows(page).filter({ has: page.locator('.quality-missing') });
    await expect(missing).toHaveCount(1);
    await expect(missing.first()).toContainText('温度');
    await expect(missing.first()).toContainText('—');
    await shot(page, testInfo, 'uc09-missing');
    // 温度が欠損でも、取得できた指標（湿度・照度・CO2濃度）だけで評価する（温度は「—」）
    await page.goto('/');
    const card = page.getByTestId('card-environmentalAdaptability');
    await expect(card.locator('.status-badge')).toContainText('正常');
    await expect(
      card.locator('dt', { hasText: '温度' }).locator('xpath=following-sibling::dd[1]'),
    ).toContainText('—');
  });

  test('サンプルの不正なデータ（数値でない・範囲外・列の不足・登録のないセンサーID）を、「不正」として保持する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-002-invalid.csv');
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    await expect(result).toContainText('取得しました（一部成功）');
    await expect(result).toContainText('取り込み 2 件、読み取れなかった記録 4 件');
    await openObservations(page);
    const invalid = observationRows(page).filter({ has: page.locator('.quality-invalid') });
    await expect(invalid).toHaveCount(2);
    await expect(invalid.filter({ hasText: '温度' })).toContainText('abc');
    await expect(invalid.filter({ hasText: '湿度' })).toContainText('120');
  });

  const humidity: readonly { value: string; quality: string }[] = [
    { value: '-1', quality: '不正' },
    { value: '0', quality: '有効' },
    { value: '100', quality: '有効' },
    { value: '100.1', quality: '不正' },
  ];

  for (const item of humidity) {
    test(`湿度の境界値: ${item.value}% は「${item.quality}」`, async ({ page, request }) => {
      await prepareApp(request);
      placeFile(
        'environment-sensor',
        'humidity.csv',
        sensorCsv([
          { hoursAgo: 0.5, temperature: 22, humidity: item.value, illuminance: 30000, co2: 900 },
        ]),
      );
      await openIngestion(page);
      await runNow(page, 'environment-sensor');

      await openObservations(page, '?q=%E6%B9%BF%E5%BA%A6');

      await expect(observationRows(page)).toHaveCount(1);
      await expect(observationRows(page).first().locator('.quality')).toHaveText(item.quality);
    });
  }

  test('未来の計測日時（受信より5分を超えて未来）は「不正」として保持する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile(
      'environment-sensor',
      'future.csv',
      sensorCsv([{ hoursAgo: -1, temperature: 22, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await openIngestion(page);
    await runNow(page, 'environment-sensor');

    await openObservations(page);

    await expect(observationRows(page)).toHaveCount(4);
    for (const row of await observationRows(page).all()) {
      await expect(row.locator('.quality')).toHaveText('不正');
    }
  });

  test('登録のないセンサーID の行は、読み取れなかった記録として数え、保存しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'unknown.csv', sensorCsv(rows(22), 'SENSOR-UNKNOWN-99'));
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    await expect(result).toContainText('取り込み 0 件、読み取れなかった記録 2 件');
    // 保存しない（取り込み済みデータに現れない）
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(0);
  });

  test('表計算ソフトで保存した形式（BOM つき・改行が CRLF）の CSV も、読み取れて、取り込まれる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile(
      'environment-sensor',
      'excel.csv',
      `${String.fromCharCode(0xfeff)}${sensorCsv(rows(22)).replaceAll('\n', '\r\n')}\r\n`,
    );
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    await expect(result).toContainText('取得しました（成功）');
    await expect(result).toContainText('ファイル 1 件、取り込み 8 件、読み取れなかった記録 0 件');
  });

  test('ロボットの機体ID（データ上の識別子）の行は、センサーの取り込みでは対応づけず、読み取れなかった記録として数える（設備の種別をまたがない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'robot-id.csv', sensorCsv(rows(22), ROBOT_EXTERNAL_ID));
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    await expect(result).toContainText('取り込み 0 件、読み取れなかった記録 2 件');
    await openObservations(page);
    await expect(observationRows(page)).toHaveCount(0);
  });

  test('受信が遅れたデータ（計測から受信まで60分を超える）は「遅延」として保持し、評価には使う', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 計測は3時間前、受信は現在（3時間遅れ）
    placeFile(
      'environment-sensor',
      'late.csv',
      sensorCsv([{ hoursAgo: 3, temperature: 22, humidity: 60, illuminance: 30_000, co2: 900 }]),
    );
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await alignBrowserClock(page);
    await openAs(page, '/observations');

    await expect(observationRows(page)).toHaveCount(4);
    for (const row of await observationRows(page).all()) {
      await expect(row.locator('.quality')).toHaveText('遅延');
    }
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('正常');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText('22.0℃');
  });

  test('ヘッダーのみ（データ行なし）の CSV は、成功（0 件）。空のファイルは、失敗', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'header-only.csv', sensorCsv([]));
    placeFile('environment-sensor', 'empty.csv', '');
    await openIngestion(page);

    const result = await runNow(page, 'environment-sensor');

    // ヘッダーのみのファイルは、形式として正しい（0 件）。空のファイルは、形式違い。全体では、取り込めた記録がないため、失敗
    await expect(result).toContainText('取得しました（失敗）');
    await expect(result).toContainText('ファイル 2 件');
    // 取り込めなかったのは、1件のファイル（空のファイル）だけ。ヘッダーのみのファイルは、成功
    await expect(logRows(page).first()).toContainText('1件のファイルを取り込めませんでした');
  });
});

test.describe('代替フロー: 接続できない場合は、再試行し、失敗を記録する。取り込みの失敗が他のユースケースを妨げない', () => {
  test('ファイルサーバーが停止していると、失敗を記録し、復旧後に取り込める。ロボットデータの取り込みと独立している', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await openIngestion(page);
    await expect(await runNow(page, 'environment-sensor')).toContainText('取得しました（失敗）');
    await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');

    await setMock(request, 'file-server', 'UP');
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(22)));
    await expect(await runNow(page, 'environment-sensor')).toContainText('取り込み 8 件');

    // ロボットデータの取り込みは、別に、実行できる
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]));
    await expect(await runNow(page, 'robot')).toContainText('取得しました（成功）');
  });

  test('再試行しても失敗した場合は、取り込み失敗の通知を作り（UC-24）、ログに失敗を記録する。置いてあったファイルは、復旧後の取り込みで取り込まれる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(22)));

    // 再試行（最大3回）しても失敗 → 結果として FAILURE を返す
    const response = await api(request, 'POST', '/ingestion/environment-sensor/run');
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
    await expect(notification).toContainText('環境センサーデータ');
    await expect(notification).toContainText('ファイルサーバーに接続できませんでした');

    // 復旧後の取り込みで、置いてあったファイルが取り込まれる（失敗した間も、ファイルは取り込み済みにならない）
    await setMock(request, 'file-server', 'UP');
    await page.goto('/settings/ingestion');
    await expect(await runNow(page, 'environment-sensor')).toContainText('取り込み 8 件');
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' })).toHaveCount(2);
    await expect(logRows(page).first()).toHaveAttribute('data-result', 'SUCCESS');
    await expect(logRows(page).nth(1)).toHaveAttribute('data-result', 'FAILURE');
  });

  test('ファイルサーバーが停止していても、ダッシュボード・データ入力・通知の画面は、通常どおり使える', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await openIngestion(page);
    await expect(await runNow(page, 'environment-sensor')).toContainText('取得しました（失敗）');

    await page.goto('/');
    await expect(page.getByTestId('card-environmentalAdaptability')).toBeVisible();
    await page.goto('/data-entry');
    await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
  });

  test('定期の取り込み（JB-01）で、センサーのファイルが形式違いでも、ロボットの取り込みは実行される（取り込み元ごとに独立）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-003-bad-header.csv');
    placeFile('robot', 'robot.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]));

    await runJob(request, 'JB-01');

    await openIngestion(page);
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' }).first()).toHaveAttribute(
      'data-result',
      'FAILURE',
    );
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' }).first()).toHaveAttribute(
      'data-result',
      'SUCCESS',
    );
  });

  test('センサーの識別子（sensor_id）は、設備に登録した「データ上の識別子」と対応づけられる', async ({
    request,
  }) => {
    await prepareApp(request);
    placeFile('environment-sensor', 'a.csv', sensorCsv(rows(22), SENSOR_EXTERNAL_ID));

    const response = await apiOk<{ recordCount: number }>(
      request,
      'POST',
      '/ingestion/environment-sensor/run',
    );

    expect(response.recordCount).toBe(8);
  });
});
