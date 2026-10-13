/**
 * UC-16 取り込み・連携の状況を確認する（SC-11。FR-1.8、FR-8.3、NFR-6.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、取り込みのログを開く
 *               2. システムが、取り込みの日時、成功／失敗、取得件数、エラー内容を一覧で表示する
 *               3. 農作業者が、連携の結果（成功・失敗・保留）を確認する
 *   代替フロー  失敗や保留が続く場合は、農作業者が、設定の見直し（UC-15）や関係者への確認を行う（システム外）
 *   事後条件    農作業者が、取り込み・連携の状況を把握している
 *
 * 値の同値分割: 取り込みの結果（成功・一部成功・失敗（形式違い）・失敗（接続できない））、取り込み元の絞り込み（すべて・ロボット・環境センサー）、
 * 件数（0件・1ページ・複数ページ）、連携の結果（成功・保留・失敗）、連携キューの件数（待機・送信済み・保留・失敗）。
 * 関連するユースケース: UC-08・UC-09（取り込みの記録）、UC-11（連携の記録）、UC-15（設定の見直し）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  goToMenu,
  openAs,
  placeFile,
  placeFixture,
  prepareApp,
  robotJson,
  runJob,
  setMock,
} from './support/app.ts';
import { federationRows, logRows, sourceCard } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

async function openStatus(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/settings/ingestion${query}`);
  await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
}

async function runIngestionApi(
  request: Parameters<typeof prepareApp>[0],
  sourceId: 'robot' | 'environment-sensor',
): Promise<void> {
  const response = await api(request, 'POST', `/ingestion/${sourceId}/run`);
  expect(response.status()).toBe(202);
}

const queueCount = (page: Page, status: string) =>
  page.getByTestId(`queue-${status}`).locator('strong');

test.describe('基本フロー: 取り込みのログを開き、日時・成功／失敗・取得件数・エラー内容を確認する', () => {
  test('取り込みのログを新しい順に一覧表示し、日時・取り込み元・結果・ファイル数・取得件数・読み取れなかった数・エラー内容を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');
    await runIngestionApi(request, 'robot');
    await advanceMinutes(request, 15);
    await runIngestionApi(request, 'environment-sensor');

    await openStatus(page);

    const logs = page.getByTestId('ingestion-logs');
    await expect(logs.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '日時',
      '取り込み元',
      '結果',
      'ファイル数',
      '取得件数',
      '読み取れなかった数',
      'エラー内容',
    ]);
    await expect(logRows(page)).toHaveCount(2);
    // 新しい順: 環境センサー（15分後）→ ロボット
    await expect(logRows(page).nth(0)).toContainText('2026/10/09 12:15:00');
    await expect(logRows(page).nth(0)).toContainText('環境センサーデータ');
    await expect(logRows(page).nth(0)).toContainText('一部成功');
    await expect(logRows(page).nth(0).locator('td').nth(4)).toHaveText('11');
    await expect(logRows(page).nth(0).locator('td').nth(5)).toHaveText('1');
    await expect(logRows(page).nth(1)).toContainText('ロボットデータ');
    await expect(logRows(page).nth(1)).toContainText('成功');
    await expect(logRows(page).nth(1).locator('td').nth(3)).toHaveText('1');
    await expect(logRows(page).nth(1).locator('td').nth(4)).toHaveText('14');
    await expect(logRows(page).nth(1).locator('td').nth(6)).toHaveText('—');
    // 取り込み元ごとの、最終の成功日時
    await expect(sourceCard(page, 'robot').getByTestId('last-success-robot')).toHaveText(
      '2026/10/09 12:00:00',
    );
    await expect(
      sourceCard(page, 'environment-sensor').getByTestId('last-success-environment-sensor'),
    ).toHaveText('まだ実行していません');
    await shot(page, testInfo, 'uc16-logs');
  });

  test('取り込みのログがなければ、その旨を表示する。連携の記録がなければ、連携キューの件数（待機）と、その旨を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openStatus(page);

    await expect(page.getByTestId('ingestion-logs-empty')).toHaveText('取り込みのログはありません');
    await expect(page.getByTestId('federation-logs-empty')).toHaveText('連携の記録はありません');
    await expect(queueCount(page, 'PENDING')).toHaveText('0');
  });

  test('画面の「最新の状況を読み込む」で、ログと連携の記録を読み直す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
    await openStatus(page);
    await expect(logRows(page)).toHaveCount(0);
    await expect(federationRows(page)).toHaveCount(0);

    await runIngestionApi(request, 'robot');
    await runJob(request, 'JB-03');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();

    await expect(logRows(page)).toHaveCount(1);
    await expect(federationRows(page)).toHaveCount(1);
  });

  test('画面を開いたままでも、一定の間隔で、取り込みのログを読み直す（再読み込みせずに、新しい取り込みが20秒以内に反映される）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openStatus(page);
    await expect(logRows(page)).toHaveCount(0);

    await runIngestionApi(request, 'robot');

    await expect(logRows(page)).toHaveCount(1, { timeout: 20_000 });
    await expect(logRows(page).first()).toContainText('ロボットデータ');
  });

  test('参照のみの利用者（閲覧者）も、取り込みのログと連携の記録を確認できる（設定の操作は表示しない）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);
    placeFixture('robot', 'robot/robot-sample-001.json');
    await runIngestionApi(request, 'robot');
    await runJob(request, 'JB-03');
    await alignBrowserClock(page);

    await openAs(page, '/settings/ingestion', VIEWER);

    await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
    await expect(logRows(page)).toHaveCount(1);
    await expect(logRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(federationRows(page)).toHaveCount(1);
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(page.getByTestId('permission-notice')).toBeVisible();
    await expect(page.getByRole('button', { name: '即時取得' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '接続テスト' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '設定を保存' })).toHaveCount(0);
    await shot(page, testInfo, 'uc16-viewer');
  });
});

test.describe('取り込みの結果の同値分割（成功・一部成功・失敗）', () => {
  const partitions: readonly {
    name: string;
    sourceId: 'robot' | 'environment-sensor';
    fixture: string;
    result: string;
    files: string;
    records: string;
    rejected: string;
    error: string;
  }[] = [
    {
      name: '成功（正常なロボットデータ）',
      sourceId: 'robot',
      fixture: 'robot/robot-sample-001.json',
      result: '成功',
      files: '1',
      records: '14',
      rejected: '0',
      error: '—',
    },
    {
      name: '一部成功（一部の記録が不正なロボットデータ）',
      sourceId: 'robot',
      fixture: 'robot/robot-sample-002-partial.json',
      result: '一部成功',
      files: '1',
      records: '7',
      rejected: '4',
      error: '—',
    },
    {
      name: '失敗（形式違い: 壊れた JSON）',
      sourceId: 'robot',
      fixture: 'robot/robot-sample-003-broken.json',
      result: '失敗',
      files: '1',
      records: '0',
      rejected: '1',
      error: '1件のファイルを取り込めませんでした',
    },
    {
      name: '失敗（形式違い: 見出しの違う CSV）',
      sourceId: 'environment-sensor',
      fixture: 'environment-sensor/sensor-sample-003-bad-header.csv',
      result: '失敗',
      files: '1',
      records: '0',
      rejected: '1',
      error: '1件のファイルを取り込めませんでした',
    },
    {
      name: '一部成功（不正な値・登録のない識別子を含む CSV）',
      sourceId: 'environment-sensor',
      fixture: 'environment-sensor/sensor-sample-002-invalid.csv',
      result: '一部成功',
      files: '1',
      records: '2',
      rejected: '4',
      error: '—',
    },
  ];

  for (const item of partitions) {
    test(`${item.name}: ログに、結果・件数・エラー内容を記録する`, async ({ page, request }) => {
      await prepareApp(request);
      placeFixture(item.sourceId, item.fixture);
      await runIngestionApi(request, item.sourceId);

      await openStatus(page);

      const row = logRows(page).first();
      await expect(row.locator('.log-result')).toHaveText(item.result);
      await expect(row.locator('td').nth(3)).toHaveText(item.files);
      await expect(row.locator('td').nth(4)).toHaveText(item.records);
      await expect(row.locator('td').nth(5)).toHaveText(item.rejected);
      await expect(row.locator('td').nth(6)).toHaveText(item.error);
    });
  }

  test('失敗（ファイルサーバーに接続できない）: エラー内容に、接続できなかった旨を示す（内部情報は含めない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await runIngestionApi(request, 'robot');

    await openStatus(page);

    const row = logRows(page).first();
    await expect(row.locator('.log-result')).toHaveText('失敗');
    await expect(row.locator('td').nth(6)).toHaveText('ファイルサーバーに接続できませんでした');
    await expect(row).not.toContainText('test-result');
    await expect(sourceCard(page, 'robot').getByTestId('last-success-robot')).toHaveText(
      'まだ実行していません',
    );
  });
});

test.describe('取り込み元の絞り込みと、ページ分割（10件ごと）', () => {
  test('取り込み元で絞り込める（すべて・ロボットデータ・環境センサーデータ）。条件は URL に反映され、再読み込みで保持される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await runIngestionApi(request, 'robot');
    await runIngestionApi(request, 'environment-sensor');
    await runIngestionApi(request, 'environment-sensor');
    await openStatus(page);
    await expect(logRows(page)).toHaveCount(3);
    const filter = page.getByTestId('ingestion-logs').getByLabel('取り込み元');

    await filter.selectOption('robot');
    await expect(logRows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/source=robot/);
    await filter.selectOption('environment-sensor');
    await expect(logRows(page)).toHaveCount(2);
    await page.reload();
    await expect(filter).toHaveValue('environment-sensor');
    await expect(logRows(page)).toHaveCount(2);
    await filter.selectOption('');
    await expect(logRows(page)).toHaveCount(3);
  });

  test('11件のログは、1ページ目に10件、2ページ目に1件を表示し、前後のページへ移動できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    for (let index = 0; index < 11; index += 1) {
      await runIngestionApi(request, 'robot');
    }
    await openStatus(page);
    const logs = page.getByTestId('ingestion-logs');
    await expect(logRows(page)).toHaveCount(10);
    await expect(logs.getByRole('button', { name: '前へ' })).toBeDisabled();
    await shot(page, testInfo, 'uc16-page-1');

    await logs.getByRole('button', { name: '次へ' }).click();

    await expect(logRows(page)).toHaveCount(1);
    await expect(logs.getByTestId('pager-page')).toHaveText('2');
    await expect(logs.getByRole('button', { name: '次へ' })).toBeDisabled();
    await logs.getByRole('button', { name: '前へ' }).click();
    await expect(logRows(page)).toHaveCount(10);
  });

  test('取り込み元の絞り込みを変えると、1ページ目に戻る（2ページ目で絞り込んでも、2ページ目の位置を引き継がない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    for (let index = 0; index < 11; index += 1) {
      await runIngestionApi(request, 'robot');
    }
    await runIngestionApi(request, 'environment-sensor');
    await openStatus(page);
    const logs = page.getByTestId('ingestion-logs');
    await logs.getByRole('button', { name: '次へ' }).click();
    await expect(logs.getByTestId('pager-page')).toHaveText('2');
    await expect(logRows(page)).toHaveCount(2);

    await logs.getByLabel('取り込み元').selectOption('environment-sensor');

    await expect(logRows(page)).toHaveCount(1);
    await expect(logs.getByTestId('pager-page')).toHaveText('1');
    await expect(logRows(page).first()).toContainText('環境センサーデータ');
  });
});

test.describe('基本フロー 3: 連携の結果（成功・失敗・保留）を確認する', () => {
  /** 新しいファイルを取り込んで、連携キューに積む。 */
  async function enqueueNewData(
    request: Parameters<typeof prepareApp>[0],
    name: string,
  ): Promise<void> {
    placeFile('robot', name, robotJson([{ hoursAgo: 1, fields: { harvestCount: 5 } }]));
    await runIngestionApi(request, 'robot');
  }

  test('連携が成功すると、「成功」を記録し、連携キューの送信済みの件数が増える', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await enqueueNewData(request, 'a.json');
    await runJob(request, 'JB-03');

    await openStatus(page);

    await expect(federationRows(page)).toHaveCount(1);
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(queueCount(page, 'SENT')).not.toHaveText('0');
    await expect(queueCount(page, 'PENDING')).toHaveText('0');
    await expect(queueCount(page, 'HELD')).toHaveText('0');
    await shot(page, testInfo, 'uc16-federation-sent');
  });

  test('農業情報基盤が停止していると、「保留」を記録し、連携キューの保留の件数を示す。取り込みのログは、通常どおり記録する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    await enqueueNewData(request, 'a.json');
    await runJob(request, 'JB-03');

    await openStatus(page);

    await expect(federationRows(page).first().locator('.log-result')).toHaveText('保留');
    await expect(federationRows(page).first()).toContainText(
      '農業情報基盤が利用できないため、連携を保留しました',
    );
    await expect(queueCount(page, 'HELD')).not.toHaveText('0');
    await expect(queueCount(page, 'SENT')).toHaveText('0');
    await expect(logRows(page).first().locator('.log-result')).toHaveText('成功');
    await shot(page, testInfo, 'uc16-federation-held');
  });

  test('農業情報基盤が受け付けないと、「失敗」を記録し、連携キューの失敗の件数を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'REJECT');
    await enqueueNewData(request, 'a.json');
    await runJob(request, 'JB-03');

    await openStatus(page);

    await expect(federationRows(page).first().locator('.log-result')).toHaveText('失敗');
    await expect(federationRows(page).first()).toContainText('農業情報基盤への連携に失敗しました');
    await expect(queueCount(page, 'FAILED')).not.toHaveText('0');
    await shot(page, testInfo, 'uc16-federation-failed');
  });

  test('保留が続いた後、復旧すると、保留していた項目をすべて送り、「成功」を記録する（保留の件数は 0 になる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    await enqueueNewData(request, 'a.json');
    await runJob(request, 'JB-03');
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-03');
    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 11);

    await runJob(request, 'JB-03');

    await openStatus(page);
    await expect(federationRows(page)).toHaveCount(3);
    await expect(federationRows(page).nth(0).locator('.log-result')).toHaveText('成功');
    await expect(federationRows(page).nth(1).locator('.log-result')).toHaveText('保留');
    await expect(federationRows(page).nth(2).locator('.log-result')).toHaveText('保留');
    await expect(queueCount(page, 'HELD')).toHaveText('0');
    await expect(queueCount(page, 'SENT')).not.toHaveText('0');
  });

  test('連携の記録が11件あると、1ページ目に10件、2ページ目に1件を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'federation', 'DOWN');
    for (let index = 0; index < 11; index += 1) {
      // 連携の記録は、送る項目があるときだけ作られる。項目を積み、再試行の間隔（最大12時間）を過ぎてから、送る
      await enqueueNewData(request, `f-${String(index)}.json`);
      await advanceMinutes(request, 721);
      await runJob(request, 'JB-03');
    }

    await openStatus(page);

    const section = page.getByTestId('federation-section');
    await expect(federationRows(page)).toHaveCount(10);
    await section.getByRole('button', { name: '次へ' }).click();
    await expect(federationRows(page)).toHaveCount(1);
    await expect(section.getByTestId('pager-page')).toHaveText('2');
  });
});

test.describe('代替フロー: 失敗や保留が続く場合は、設定の見直し（UC-15）へ進める', () => {
  test('取り込み・連携の状況の画面から、同じ画面で、取り込みの設定（接続先・取得間隔）を見直せる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await runIngestionApi(request, 'robot');
    await openStatus(page);
    await expect(logRows(page).first().locator('.log-result')).toHaveText('失敗');

    await sourceCard(page, 'robot').getByLabel('接続先（接続設定の参照名）').fill('FILE_SERVER_2');
    await sourceCard(page, 'robot').getByLabel('取得間隔').selectOption('60');
    await sourceCard(page, 'robot').getByRole('button', { name: '設定を保存' }).click();

    await expect(page.getByTestId('result-robot')).toHaveText('設定を保存しました');
    await page.reload();
    await expect(sourceCard(page, 'robot').getByLabel('取得間隔')).toHaveValue('60');
  });

  test('メニューの「取り込み」から、取り込み・連携の状況の画面を開ける', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/');

    await goToMenu(page, '取り込み');

    await expect(page).toHaveURL(/\/settings\/ingestion$/);
    await expect(page.getByTestId('ingestion-logs')).toBeVisible();
    await expect(page.getByTestId('federation-section')).toBeVisible();
  });
});
