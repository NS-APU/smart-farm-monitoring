/**
 * UC-10 異常・注意を検知して通知する（SC-06 の保存後、確認は SC-05・ヘッダー・SC-02。FR-7.1〜FR-7.3、FR-7.7、FR-4.1.5）。
 * UI を持たないユースケースのため、手動入力（SC-06。API で再現）の保存後の評価と、開発用 API（時計・ジョブ・モック）で検知を起こし、
 * 結果を SC-05（通知の一覧）・ヘッダーの未読の件数・SC-02 で確認する（dev_spec.md 5.1）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. システムが、取り込んだデータ・評価結果を、異常の判断基準に照らして判定する
 *               2. 観点のステータスが「注意」または「異常」と判定した場合、システムが農作業者へ通知する
 *               3. 通知には、ステータス・観点名・対象の設備・診断メッセージを含める
 *   代替フロー  ・データの欠損・異常値・遅延は、異常の判定と区別して扱う
 *               ・同じ異常を繰り返し通知しない（抑制。同じ観点・設備・ステータスは60分）
 *               ・「不明」は通知しない／通知に失敗した場合は、記録し、再送する（UC-23）
 *   事後条件    農作業者に通知が送られ、未読として記録されている
 *
 * 値の同値分割: ステータスの変化（正常のまま・注意・異常・注意 → 異常・異常 → 不明・不明 → 異常）、
 * データの品質（有効・遅延・欠損・不正）、抑制（期間内・期間後・境界）、対象（ハウス・センサー）、判定の経路（保存後・定期）、農業情報基盤の停止。
 * 入口: 手動入力（SC-06 の画面操作と API）、取り込み（UC-08・UC-09。ファイルを置いて即時取得）、定期の評価（JB-02・スケジューラの tick）。
 * 対象: 栽培環境（温度・湿度・照度・CO2濃度の4指標の境界値）とロボット（収穫精度・収穫速度）。通知の配信の失敗と再送（JB-04）も含む。
 * 関連するユースケース: UC-07（検知の元の入力）・UC-05・UC-22（通知の確認）・UC-23（Web Push）・UC-24（取り込み失敗の通知）・UC-19。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  ROBOT_ID,
  SENSOR_ID,
  addEntry,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  goToMenu,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  runJob,
  sensorCsv,
  setMock,
  unreadBadge,
} from './support/app.ts';
import { expectRelatedStatus, fillEntryForm, mainArea, saveEntry } from './support/entry.ts';
import { listNotifications } from './support/notifications.ts';
import { deliveredPushes } from './support/push.ts';
import {
  environmentData,
  harvestAccuracyData,
  merge,
  hoursAgo,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';

const environmentRows = (page: Page) =>
  page.getByTestId('notification-row').filter({ hasText: '環境適応性' });

/** 温度の手動入力（ほかの指標は正常）。入力した入力の識別子を返す。 */
async function enterTemperature(
  request: Parameters<typeof prepareApp>[0],
  temperature: number,
  hours = 1,
): Promise<string> {
  const saved = await addEntry(request, {
    equipmentId: SENSOR_ID,
    category: 'ENVIRONMENT',
    observedAt: hoursAgo(hours),
    items: {
      temperatureCelsius: temperature,
      humidityPercent: 60,
      illuminanceLux: 30000,
      co2Ppm: 900,
    },
  });
  return saved.entry.entryId;
}

async function environmentNotifications(request: Parameters<typeof prepareApp>[0]) {
  return (await listNotifications(request)).filter(
    (item) => item.viewpointId === 'environmentalAdaptability',
  );
}

async function openNotifications(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/notifications');
  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
}

test.describe('基本フロー: 判断基準に照らして判定し、注意・異常なら通知する。通知には、ステータス・観点名・対象の設備・診断メッセージを含める', () => {
  test('異常になる値を保存すると、通知を作る。通知は、ステータス・観点名・対象の設備（ハウス・センサー）・診断メッセージを含み、未読として記録される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);

    await enterTemperature(request, 40);

    await openNotifications(page);
    const house = environmentRows(page).filter({ hasText: 'ハウス1' });
    await expect(house).toHaveCount(1);
    await expect(house).toContainText('異常検知');
    await expect(house.locator('.status-badge')).toContainText('異常');
    await expect(house).toContainText('環境適応性');
    await expect(house).toContainText('【異常】環境適応性（ハウス1）');
    await expect(house).toContainText('温度 40.0℃（異常）、湿度 60.0%（正常）');
    await expect(house).toHaveAttribute('data-read-state', 'UNREAD');
    const sensor = environmentRows(page).filter({ hasText: '環境センサー1' });
    await expect(sensor).toHaveCount(1);
    await expect(sensor).toContainText('【異常】環境適応性（環境センサー1）');
    await expect(unreadBadge(page)).not.toHaveText('0');
    await shot(page, testInfo, 'uc10-notifications');
  });

  const statuses: readonly { name: string; temperature: number; expected: string | null }[] = [
    { name: '正常（20℃）は、通知しない', temperature: 20, expected: null },
    { name: '正常の下限（10℃）は、通知しない', temperature: 10, expected: null },
    { name: '注意（27℃）は、「注意」で通知する', temperature: 27, expected: '注意' },
    { name: '注意の上限（34.9℃）は、「注意」で通知する', temperature: 34.9, expected: '注意' },
    { name: '異常の下限（35℃）は、「異常」で通知する', temperature: 35, expected: '異常' },
    { name: '異常（40℃）は、「異常」で通知する', temperature: 40, expected: '異常' },
    { name: '異常（-5℃）は、「異常」で通知する', temperature: -5, expected: '異常' },
    { name: '正常の上限（24.9℃）は、通知しない', temperature: 24.9, expected: null },
    { name: '注意の下限（25℃）は、「注意」で通知する', temperature: 25, expected: '注意' },
    {
      name: '注意（9.9℃。正常の下限の手前）は、「注意」で通知する',
      temperature: 9.9,
      expected: '注意',
    },
    { name: '注意の下限（0℃）は、「注意」で通知する', temperature: 0, expected: '注意' },
    { name: '異常の上限（-0.1℃）は、「異常」で通知する', temperature: -0.1, expected: '異常' },
  ];

  for (const item of statuses) {
    test(`ステータスの同値分割: ${item.name}`, async ({ page, request }) => {
      await prepareApp(request);

      await enterTemperature(request, item.temperature);

      const notifications = await environmentNotifications(request);
      if (item.expected === null) {
        expect(notifications).toHaveLength(0);
      } else {
        expect(notifications).toHaveLength(2);
        await openNotifications(page);
        await expect(environmentRows(page).first().locator('.status-badge')).toContainText(
          item.expected,
        );
      }
    });
  }

  test('不明は通知しない（データがない・評価できない場合。ダッシュボードには「不明」を表示する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});

    expect(await listNotifications(request)).toHaveLength(0);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByTestId('card-operability').locator('.status-badge')).toContainText(
      '不明',
    );
    await expect(unreadBadge(page)).toHaveText('0');
  });
});

test.describe('ステータスの変化と通知（変化したときだけ通知する）', () => {
  test('注意 → 異常と悪化すると、それぞれのステータスで通知する（同じ観点・設備でも、ステータスが違えば、別の通知）', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 27, 2);

    await enterTemperature(request, 40, 1);

    const sensor = (await environmentNotifications(request)).filter(
      (item) => item.equipmentId === SENSOR_ID,
    );
    expect(sensor.map((item) => item.status).sort()).toEqual(['CAUTION', 'ERROR']);
  });

  test('異常 → 不明（入力の削除でデータがなくなる）では、通知しない。再び異常になると、通知を作ろうとするが、抑制の期間（60分）の内は、増やさない', async ({
    request,
  }) => {
    await prepareApp(request);
    const entryId = await enterTemperature(request, 40);
    expect(await environmentNotifications(request)).toHaveLength(2);

    // データがなくなり「不明」になる → 通知しない
    expect((await api(request, 'DELETE', `/manual-entries/${entryId}`)).status()).toBe(204);
    expect(await environmentNotifications(request)).toHaveLength(2);
    // 再び異常 → 同じ観点・設備・ステータスは、60分の内は、通知しない
    await advanceMinutes(request, 30);
    await enterTemperature(request, 40);
    expect(await environmentNotifications(request)).toHaveLength(2);
  });

  test('抑制の期間（60分）が過ぎたあとに、再び異常になると、新しく通知する（境界: 59分は抑制、60分は通知）', async ({
    request,
  }) => {
    await prepareApp(request);
    const first = await enterTemperature(request, 40);
    await api(request, 'DELETE', `/manual-entries/${first}`);
    await advanceMinutes(request, 59);
    const second = await enterTemperature(request, 40);
    expect(await environmentNotifications(request)).toHaveLength(2);
    await api(request, 'DELETE', `/manual-entries/${second}`);
    await advanceMinutes(request, 1);

    await enterTemperature(request, 40);

    expect(await environmentNotifications(request)).toHaveLength(4);
  });

  test('判定が変わらない間は、保存を繰り返しても、通知を増やさない（異常のまま）', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 40, 3);

    await enterTemperature(request, 41, 2);
    await enterTemperature(request, 42, 1);

    expect(await environmentNotifications(request)).toHaveLength(2);
  });
});

test.describe('代替フロー: データの欠損・異常値・遅延は、異常の判定と区別して扱う', () => {
  test('不正な値（品質 INVALID）と欠損（MISSING）は、評価に使わず、異常として通知しない', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        // 温度 99℃ は範囲内だが「不正」として保持された値、湿度は欠損
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 99,
          observedAt: hoursAgo(1),
          quality: 'INVALID',
        },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'humidityPercent',
          value: null,
          observedAt: hoursAgo(1),
          quality: 'MISSING',
        },
      ],
    });

    expect(await environmentNotifications(request)).toHaveLength(0);
  });

  test('遅延した値（計測から受信まで60分超）は、評価に使い、異常なら通知する', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 40,
          observedAt: hoursAgo(3),
          receivedAt: hoursAgo(1),
          quality: 'LATE',
        },
      ],
    });

    expect(await environmentNotifications(request)).toHaveLength(2);
  });
});

test.describe('判定の経路: 保存後と、定期（データ途絶の確認。JB-02）', () => {
  test('定期の評価（JB-02）で、長期の窓（7日）から古いデータが外れて「不明」になっても、通知しない（異常の通知が増えない）', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 40);
    expect(await environmentNotifications(request)).toHaveLength(2);

    await advanceMinutes(request, 8 * 24 * 60);
    await runJob(request, 'JB-02');

    expect(await environmentNotifications(request)).toHaveLength(2);
  });
});

test.describe('通知の周辺: 農業情報基盤が停止していても通知できる。通知に失敗した場合は再送する（UC-23）', () => {
  test('農業情報基盤が停止していても（連携は保留）、異常の通知は作られ、画面に表示される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');

    await enterTemperature(request, 40);
    await runJob(request, 'JB-03');

    expect(await environmentNotifications(request)).toHaveLength(2);
    await openNotifications(page);
    await expect(environmentRows(page).first()).toBeVisible();
  });

  test('配信に失敗しても（JB-04。Web Push が停止）、画面内の通知は、そのまま残る', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 40);
    await setMock(request, 'web-push', 'DOWN');

    await runJob(request, 'JB-04');

    expect(
      (await environmentNotifications(request)).every((item) => item.readState === 'UNREAD'),
    ).toBe(true);
  });
});

/** 指定した観点の通知（異常検知）。 */
async function notificationsOfViewpoint(
  request: Parameters<typeof prepareApp>[0],
  viewpointId: string,
) {
  return (await listNotifications(request)).filter((item) => item.viewpointId === viewpointId);
}

test.describe('入口: 手動入力（SC-06）の画面で保存すると、評価を更新し、通知する（FR-4.1.5）', () => {
  test('SC-06 で異常になる値を保存すると、保存結果に観点のステータスを示し、ヘッダーの未読の件数が増え、通知の一覧（SC-05）に未読の通知が現れる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(unreadBadge(page)).toHaveText('0');
    await goToMenu(page, 'データ入力');
    await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: '2026-10-09T11:00',
      items: { 温度: '40', 湿度: '60', 照度: '30000', CO2濃度: '900' },
    });
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toContainText('保存しました');
    await expectRelatedStatus(page, 'environmentalAdaptability', '異常');
    await expect(unreadBadge(page)).not.toHaveText('0');
    await shot(page, testInfo, 'uc10-entry-saved');
    // ヘッダーの未読の件数から、通知の一覧へ移る。件数は、一覧の未読の行の数と一致する
    await page.getByRole('banner').getByRole('link', { name: /未読/ }).click();
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    const unreadRows = page.locator('[data-testid="notification-row"][data-read-state="UNREAD"]');
    await expect(environmentRows(page)).toHaveCount(2);
    await expect(unreadBadge(page)).toHaveText(String(await unreadRows.count()));
    await expect(mainArea(page)).toContainText('【異常】環境適応性（ハウス1）');
    await shot(page, testInfo, 'uc10-notifications-from-entry');
  });

  test('正常な値を保存しても、環境適応性の通知は作られない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: '2026-10-09T11:00',
      items: { 温度: '20', 湿度: '60', 照度: '30000', CO2濃度: '900' },
    });
    await saveEntry(page);

    await expectRelatedStatus(page, 'environmentalAdaptability', '正常');
    await goToMenu(page, '通知');
    // 環境適応性は正常のため、通知しない（ロボットのデータがなく、データ活用度合いが異常になる通知だけが残る）
    await expect(environmentRows(page)).toHaveCount(0);
    const rows = page.getByTestId('notification-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('データ活用度合い');
    await expect(unreadBadge(page)).toHaveText('1');
    await shot(page, testInfo, 'uc10-entry-normal');
  });
});

test.describe('基本フロー: 栽培環境の異常（4つの指標のどれが基準を超えても、最も悪い指標が観点のステータス）', () => {
  const normal = {
    temperatureCelsius: 20,
    humidityPercent: 60,
    illuminanceLux: 30000,
    co2Ppm: 900,
  };
  const indicators: readonly {
    name: string;
    values: typeof normal;
    status: '注意' | '異常';
    message: string;
  }[] = [
    {
      name: '湿度 85%（注意）',
      values: { ...normal, humidityPercent: 85 },
      status: '注意',
      message: '湿度 85.0%（注意）',
    },
    {
      name: '湿度 90%（異常の下限）',
      values: { ...normal, humidityPercent: 90 },
      status: '異常',
      message: '湿度 90.0%（異常）',
    },
    {
      name: '照度 45,000lx（注意）',
      values: { ...normal, illuminanceLux: 45000 },
      status: '注意',
      message: '（注意）',
    },
    {
      name: '照度 50,000lx（異常の下限）',
      values: { ...normal, illuminanceLux: 50000 },
      status: '異常',
      message: '（異常）',
    },
    {
      name: 'CO2濃度 1,500ppm（注意）',
      values: { ...normal, co2Ppm: 1500 },
      status: '注意',
      message: '（注意）',
    },
    {
      name: 'CO2濃度 3,000ppm（異常の下限）',
      values: { ...normal, co2Ppm: 3000 },
      status: '異常',
      message: '（異常）',
    },
  ];

  for (const item of indicators) {
    test(`${item.name}のとき、「${item.status}」を、診断メッセージつきで通知する`, async ({
      request,
    }) => {
      await prepareApp(request);
      await addEntry(request, {
        equipmentId: SENSOR_ID,
        category: 'ENVIRONMENT',
        observedAt: hoursAgo(1),
        items: item.values,
      });

      const notifications = await environmentNotifications(request);

      expect(notifications).toHaveLength(2);
      for (const notification of notifications) {
        expect(notification.status).toBe(item.status === '異常' ? 'ERROR' : 'CAUTION');
        expect(notification.message).toContain(`【${item.status}】環境適応性`);
        expect(notification.message).toContain(item.message);
      }
    });
  }
});

test.describe('基本フロー: ロボットの異常も、栽培環境の異常と同じ流れで通知する（FR-7.1。異常には、ロボットの異常と栽培環境の異常を含む）', () => {
  const levels: readonly {
    name: string;
    level: 'NORMAL' | 'CAUTION' | 'ERROR';
    expected: string | null;
  }[] = [
    { name: '正常（可販果率 98.7%）は、通知しない', level: 'NORMAL', expected: null },
    { name: '注意（可販果率 89.6%）は、「注意」で通知する', level: 'CAUTION', expected: '注意' },
    { name: '異常（可販果率 78.3%）は、「異常」で通知する', level: 'ERROR', expected: '異常' },
  ];

  for (const item of levels) {
    test(`収穫精度の同値分割: ${item.name}`, async ({ page, request }, testInfo) => {
      await prepareApp(request);

      await seed(request, harvestAccuracyData(item.level));

      const notifications = await notificationsOfViewpoint(request, 'harvestAccuracy');
      if (item.expected === null) {
        expect(notifications).toHaveLength(0);
        return;
      }
      const robot = notifications.filter((notification) => notification.equipmentId === ROBOT_ID);
      expect(robot).toHaveLength(1);
      expect(robot[0]?.status).toBe(item.level);
      expect(robot[0]?.message).toContain(`【${item.expected}】収穫精度（収穫ロボット1）`);
      expect(robot[0]?.readState).toBe('UNREAD');
      await alignBrowserClock(page);
      await openAs(page, '/notifications');
      const row = page
        .getByTestId('notification-row')
        .filter({ hasText: '収穫精度' })
        .filter({ hasText: '収穫ロボット1' });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.status-badge')).toContainText(item.expected);
      await shot(page, testInfo, `uc10-robot-${item.level.toLowerCase()}`);
    });
  }

  test('ロボットの異常と栽培環境の異常が同時にあると、それぞれの観点・設備の通知を作る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, merge(harvestAccuracyData('ERROR'), environmentData({ temperature: 40 })));

    expect(await notificationsOfViewpoint(request, 'harvestAccuracy')).not.toHaveLength(0);
    expect(await environmentNotifications(request)).toHaveLength(2);
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(
      page.getByTestId('notification-row').filter({ hasText: '収穫精度' }).first(),
    ).toBeVisible();
    await expect(environmentRows(page).first()).toBeVisible();
    await shot(page, testInfo, 'uc10-robot-and-environment');
  });
});

test.describe('入口: 取り込んだデータ（UC-08・UC-09）の判定', () => {
  test('環境センサーのデータ（UC-09）を取り込んで、異常な温度があると、通知する。同じ異常を含む次のファイルを取り込んでも、通知は増えない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFile(
      'environment-sensor',
      'sensor-1.csv',
      sensorCsv([{ hoursAgo: 1, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
    );

    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');

    expect(await environmentNotifications(request)).toHaveLength(2);
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(environmentRows(page).filter({ hasText: 'ハウス1' })).toContainText('【異常】');
    await expect(unreadBadge(page)).not.toHaveText('0');
    await shot(page, testInfo, 'uc10-ingested-sensor');
    // 異常が続く間は、増えない
    placeFile(
      'environment-sensor',
      'sensor-2.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: 41, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    expect(await environmentNotifications(request)).toHaveLength(2);
  });

  test('環境センサーのデータが正常なら、通知しない。続けて注意のデータを取り込むと、ハウスとセンサーの通知を作る', async ({
    request,
  }) => {
    await prepareApp(request);
    placeFile(
      'environment-sensor',
      'normal.csv',
      sensorCsv([{ hoursAgo: 2, temperature: 20, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    expect(await environmentNotifications(request)).toHaveLength(0);

    placeFile(
      'environment-sensor',
      'caution.csv',
      sensorCsv([{ hoursAgo: 1, temperature: 28, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');

    const notifications = await environmentNotifications(request);
    expect(notifications.every((item) => item.status === 'CAUTION')).toBe(true);
    // ファイルの中の識別子（SENSOR-SAMPLE-01）は、登録済みのセンサーとハウスに対応づけられる
    expect(notifications.map((item) => item.equipmentId).sort()).toEqual(['HOUSE-01', SENSOR_ID]);
  });

  test('ロボットのデータ（UC-08）を取り込んで、収穫速度が異常になると、ロボットとハウスの通知を作る。ダッシュボードの状態と一致する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const fields = {
      harvestCount: 10,
      harvestSecondsPerFruit: 144,
      operatingHours: 0.5,
      standbyHours: 0.01,
      harvestOperatingHours: 0.4,
      travelStoppedHours: 0.008,
      statusCode: 'HARVESTING',
    };
    placeFile(
      'robot',
      'robot-slow.json',
      robotJson([
        { hoursAgo: 0.5, fields },
        { hoursAgo: 0.25, fields },
      ]),
    );

    await apiOk(request, 'POST', '/ingestion/robot/run');

    const notifications = await notificationsOfViewpoint(request, 'harvestSpeed');
    expect(notifications.map((item) => item.equipmentId).sort()).toEqual(['HOUSE-01', ROBOT_ID]);
    expect(notifications.every((item) => item.status === 'ERROR')).toBe(true);
    expect(notifications[0]?.message).toContain('144');
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
      '異常',
    );
    await goToMenu(page, '通知');
    await expect(page.getByTestId('notification-row').filter({ hasText: '収穫速度' })).toHaveCount(
      2,
    );
    await shot(page, testInfo, 'uc10-ingested-robot');
  });
});

test.describe('事後条件: 異常・注意の発生が記録されている', () => {
  test('注意・異常になった時刻とステータスが、観点の詳細（SC-03）のステータスの推移に記録される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await enterTemperature(request, 27, 2);
    await advanceMinutes(request, 30);
    await enterTemperature(request, 40, 1);

    await alignBrowserClock(page, new Date('2026-10-09T03:30:00.000Z'));
    await openAs(page, '/viewpoints/environmentalAdaptability?horizon=LONG&periodDays=30');
    const history = page.getByTestId('status-history');
    await expect(history).toBeVisible();
    await expect(history.locator('.status-segment')).toHaveText(['注意', '異常']);
    const items = history.locator('ol li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('2026/10/09 12:00:00');
    await expect(items.nth(0)).toContainText('注意');
    await expect(items.nth(1)).toContainText('2026/10/09 12:30:00');
    await expect(items.nth(1)).toContainText('異常');
    await history.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'uc10-status-history');
  });
});

test.describe('判定の経路: 定期の評価（JB-02・スケジューラ）', () => {
  test('保存後の評価が行われなかったデータも、次の定期の評価（JB-02）で判定し、通知する。続けて評価しても、通知は増えない', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { ...environmentData({ temperature: 40 }), evaluate: false });
    expect(await environmentNotifications(request)).toHaveLength(0);

    await runJob(request, 'JB-02');

    expect(await environmentNotifications(request)).toHaveLength(2);
    await runJob(request, 'JB-02');
    expect(await environmentNotifications(request)).toHaveLength(2);
  });

  test('データが途絶えて、短期視点（直近24時間）から外れても、長期視点が異常のままなら、通知は増えない', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 40);

    await advanceMinutes(request, 25 * 60);
    await runJob(request, 'JB-02');

    expect(await environmentNotifications(request)).toHaveLength(2);
  });

  test('スケジューラの tick が、評価（JB-02）と通知の配信（JB-04）を実行し、購読している端末へ、通知を配信する', async ({
    request,
  }) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/push-subscription', {
      endpoint: 'https://push.example.invalid/e2e/uc10-tick',
    });
    await enterTemperature(request, 40);
    expect(await deliveredPushes(request)).toHaveLength(0);

    const result = await apiOk<{ executed: string[] }>(request, 'POST', '/dev/scheduler/tick');

    expect(result.executed).toEqual(expect.arrayContaining(['JB-02', 'JB-04']));
    const created = await listNotifications(request);
    expect((await deliveredPushes(request)).map((item) => item.notificationId).sort()).toEqual(
      created.map((item) => item.notificationId).sort(),
    );
    expect(await environmentNotifications(request)).toHaveLength(2);
  });
});

test.describe('代替フロー: 通知に失敗した場合は、記録し、再送する（FR-7.7）', () => {
  test('Web Push の配信に失敗しても、画面内の通知は残る。復旧後の配信（JB-04）で、購読している端末へ届き、二重には配信しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/push-subscription', {
      endpoint: 'https://push.example.invalid/e2e/uc10-retry',
    });
    await enterTemperature(request, 40);
    const created = await listNotifications(request);
    expect(created.length).toBeGreaterThanOrEqual(2);

    await setMock(request, 'web-push', 'DOWN');
    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(0);
    await openNotifications(page);
    await expect(environmentRows(page)).toHaveCount(2);
    await expect(environmentRows(page).first()).toHaveAttribute('data-read-state', 'UNREAD');
    await shot(page, testInfo, 'uc10-delivery-failed');
    await setMock(request, 'web-push', 'UP');
    await runJob(request, 'JB-04');
    const delivered = await deliveredPushes(request);
    expect(delivered.map((item) => item.notificationId).sort()).toEqual(
      created.map((item) => item.notificationId).sort(),
    );
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(delivered.length);
  });

  test('購読している端末がなければ、配信は完了とし（画面内の通知のみ）、あとで購読しても、過去の通知は配信されない', async ({
    request,
  }) => {
    await prepareApp(request);
    await enterTemperature(request, 40);
    await runJob(request, 'JB-04');

    await apiOk(request, 'PUT', '/push-subscription', {
      endpoint: 'https://push.example.invalid/e2e/uc10-late',
    });
    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(0);
    expect(await environmentNotifications(request)).toHaveLength(2);
  });
});
