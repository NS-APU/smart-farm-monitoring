/**
 * 負荷テスト（取り込みの大量実行）: ファイルサーバーに、数百のファイル（ロボット・環境センサーの JSON。形式違いのファイルを含む。
 * 規模は scale.ts の BULK_INGESTION）を置き、即時取得（画面の操作）・定期取り込み（JB-01）・連携（JB-03）・評価の定期実行（JB-02）で、
 * 大量のファイルを処理する。処理の時間（結果が画面に表れるまで）と、処理のあとの画面の表示を、記録する。
 */

import { expect, test } from '@playwright/test';
import {
  createBulkEquipment,
  putBulkFiles,
  removeBulkEquipment,
  useHttpFiles,
} from './support/http-files.ts';
import type { LimitKey } from './support/limits.ts';
import { measure, trackApi, type ActionSteps } from './support/recorder.ts';
import { BULK_INGESTION, STRESS_USER } from './support/scale.ts';
import {
  api,
  expectDashboardShown,
  fillLogin,
  jstInput,
  loadingView,
  mainArea,
  runJob,
  screenshot,
} from './support/ui.ts';

const USER = STRESS_USER.userId;
const { robots, sensors, robotRecordsPerFile, sensorRecordsPerFile } = BULK_INGESTION;
/** 形式違い（読み取れない）のファイルの数（各取り込み元）。 */
const BROKEN = 2;
const ROBOT_LABEL = `ロボット ${String(robots)} 台・${String(robots)} ファイル・各 ${String(robotRecordsPerFile)} 記録`;
const SENSOR_LABEL = `センサー ${String(sensors)} 台・${String(sensors)} ファイル・各 ${String(sensorRecordsPerFile)} 記録`;

// 追加した設備（大量の取り込み用の専用のハウス）は、テストの終わりに（失敗したときも）、ハウスごと削除して戻す（ほかの負荷テストの計測に、影響させない）
test.afterEach(async ({ request }) => {
  await removeBulkEquipment(request, USER);
});

test('取り込みの大量実行: 数百ファイルの即時取得・定期取り込み・連携を行う', async ({
  page,
  request,
}) => {
  trackApi(page);
  const m = (
    uc: string,
    action: string,
    screen: string,
    limit: LimitKey,
    steps: ActionSteps,
  ): Promise<unknown> =>
    measure(page, { uc, action, screen, limit, user: USER, scenario: '大量取り込み' }, steps);
  const menu = (name: string) =>
    page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name, exact: true });
  const sourceCard = (id: 'robot' | 'environment-sensor') => page.getByTestId(`source-${id}`);
  const result = (id: 'robot' | 'environment-sensor') => page.getByTestId(`result-${id}`);
  const logRows = page.getByTestId('ingestion-log-row');

  // 取得間隔は、設備ごとの設定（Issue #197。既定: ロボット 1 分・センサー 5 分）。定期取り込みは、時計を 6 分進めて起動する
  // ファイルサーバー（HTTP）は、設備ごとに 1 ファイル（ADR-0023）。大量の取り込み用に、専用のハウスと、その配下のロボット・センサーを追加する
  await useHttpFiles();
  await createBulkEquipment(request, USER, { robots, sensors });

  await page.goto('/login');
  await fillLogin(page, USER);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expectDashboardShown(page);
  await menu('取り込み').click();
  await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
  await expect(logRows.first()).toBeVisible();

  // 1. 即時取得（画面の操作）: ロボット・センサー、それぞれ数百ファイル
  await putBulkFiles('robot', {
    count: robots,
    startIndex: 0,
    recordsPerFile: robotRecordsPerFile,
    brokenCount: BROKEN,
  });
  await m(
    'UC-08',
    `ロボットのデータ（${ROBOT_LABEL}。形式違い ${String(BROKEN)} ファイルを含む）を「即時取得」する`,
    '取り込み（SC-11）',
    'job',
    {
      act: () => sourceCard('robot').getByRole('button', { name: '即時取得' }).click(),
      respond: () => expect(result('robot')).toContainText(`ファイル ${String(robots)} 件`),
    },
  );
  await putBulkFiles('environment-sensor', {
    count: sensors,
    startIndex: 0,
    recordsPerFile: sensorRecordsPerFile,
    brokenCount: BROKEN,
  });
  await m(
    'UC-09',
    `環境センサーのデータ（${SENSOR_LABEL}。形式違い ${String(BROKEN)} ファイルを含む）を「即時取得」する`,
    '取り込み（SC-11）',
    'job',
    {
      act: () => sourceCard('environment-sensor').getByRole('button', { name: '即時取得' }).click(),
      respond: () =>
        expect(result('environment-sensor')).toContainText(`ファイル ${String(sensors)} 件`),
    },
  );
  await screenshot(page, '30-bulk-ingestion-result');

  // 2. 取り込み済みのファイルが数百ある状態での、再度の即時取得（新しいファイルなし。取り込み済みの判定のみ）
  await m(
    'UC-08',
    `取り込み済みの ${String(robots)} ファイルがある状態で、もう一度「即時取得」する（新しいファイルなし）`,
    '取り込み（SC-11）',
    'job',
    {
      act: () => sourceCard('robot').getByRole('button', { name: '即時取得' }).click(),
      respond: () => expect(result('robot')).toBeVisible(),
    },
  );

  // 3. 定期取り込み（JB-01）: 新しいファイルを数百置き、取得間隔が過ぎたことにして、ジョブを起動する
  // 同じパスのファイルを、新しい内容（計測日時・値）に置き直す（設備ごとに 1 ファイル）
  await putBulkFiles('robot', {
    count: robots,
    startIndex: 100,
    recordsPerFile: robotRecordsPerFile,
  });
  await putBulkFiles('environment-sensor', {
    count: sensors,
    startIndex: 100,
    recordsPerFile: sensorRecordsPerFile,
  });
  expect((await api(request, USER, 'POST', '/dev/clock/advance', { minutes: 6 })).ok()).toBe(true);
  const firstLog = (await logRows.first().textContent()) ?? '';
  await m(
    'UC-08',
    `定期取り込み（JB-01）で、ロボット・センサー合わせて ${String(robots + sensors)} ファイル（さらに ${String(robots + sensors)}）を処理し、取り込みのログで確認する`,
    '取り込み（SC-11）',
    'job',
    {
      act: async () => `JB-01 の実行 ${String(await runJob(request, USER, 'JB-01'))} ms`,
      respond: async () => {
        await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
        await expect(logRows.first()).not.toHaveText(firstLog);
      },
    },
  );

  // 4. 取り込みで積まれた連携キュー・評価の定期実行
  await m(
    'UC-11',
    '大量の取り込みのあとに、連携（JB-03）を起動し、連携の状況で結果を確認する',
    '取り込み（SC-11）',
    'job',
    {
      act: async () => `JB-03 の実行 ${String(await runJob(request, USER, 'JB-03'))} ms`,
      respond: async () => {
        await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
        await expect(page.getByTestId('federation-queue')).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
      },
    },
  );
  await m(
    'UC-10',
    '大量の取り込みのあとに、評価の定期実行（JB-02）を起動し、ダッシュボードで確認する',
    'ダッシュボード（SC-02）',
    'job',
    {
      act: async () => `JB-02 の実行 ${String(await runJob(request, USER, 'JB-02'))} ms`,
      respond: async () => {
        await menu('ダッシュボード').click();
        await expectDashboardShown(page);
      },
    },
  );
  await screenshot(page, '31-dashboard-after-bulk');
  // 設備ごとの接続と状況の表（Issue #367）: 大量の設備（ロボット・センサー合わせて数十台。シードを含む）の行を示す
  const equipmentRunRows = page.locator('[data-testid^="equipment-run-"]');
  await m(
    'UC-16',
    `大量の取り込みのあとに、取り込み（設備ごとの接続と状況の表。ロボット・センサー合わせて ${String(robots + sensors)} 台以上）を開く`,
    '取り込み（SC-11）',
    'screen',
    {
      act: () => menu('取り込み').click(),
      respond: async () => {
        await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
        await expect(equipmentRunRows.first()).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
        expect(await equipmentRunRows.count()).toBeGreaterThanOrEqual(robots + sensors);
      },
    },
  );
  await screenshot(page, '31-ingestion-equipment-table-after-bulk');

  // 5. 大量の取り込みのあとの、画面の表示・保存
  await m(
    'UC-20',
    '大量の取り込みのあとに、計測データの一覧を開く',
    '計測データ（SC-09）',
    'screen',
    {
      act: () => menu('計測データ').click(),
      respond: async () => {
        await expect(loadingView(page)).toHaveCount(0);
        await expect(page.getByTestId('measurement-row').first()).toBeVisible();
      },
    },
  );
  await m(
    'UC-06',
    '大量の取り込みのあとに、データ入力の画面を開く',
    'データ入力（SC-06）',
    'screen',
    {
      act: () => menu('データ入力').click(),
      respond: () => expect(mainArea(page).getByLabel('対象の設備')).toBeVisible(),
    },
  );
  const form = mainArea(page);
  await form.getByLabel('対象の設備').selectOption('ROBOT-01');
  await form.getByLabel('カテゴリ').selectOption('FAILURE');
  await form.getByLabel('計測日時（日本時間）').fill(jstInput(new Date(Date.now() - 200 * 60_000)));
  await form.getByTestId('entry-items').getByRole('textbox', { name: '故障回数' }).fill('1');
  await form
    .getByTestId('entry-items')
    .getByRole('textbox', { name: '復旧に要した時間' })
    .fill('45');
  await m(
    'UC-06',
    '大量の取り込みのあとに、復旧対応の結果を入力して保存する',
    'データ入力（SC-06）',
    'operation',
    {
      act: () => form.getByRole('button', { name: '保存する' }).click(),
      respond: async () => {
        await expect(page.getByTestId('entry-result')).toContainText('保存しました');
        await expect(page.getByTestId('related-maintainability')).toBeVisible();
      },
    },
  );
});
