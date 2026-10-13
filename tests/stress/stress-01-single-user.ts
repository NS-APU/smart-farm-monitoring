/**
 * 負荷テスト（単独利用）: 大量データ（1年分・約60万件の観測値ほか。scale.ts）の状態で、ユースケース（UC-01〜UC-24）の
 * すべての利用者の操作を、ブラウザ（Playwright）で順に行い、各操作の応答時間・次の操作が可能になるまでの時間を、
 * 記録する（recorder.ts → test-result/stresstest.result.log）。許容時間は limits.ts（NFR-3.x）。
 *
 * UI を持たないユースケース（UC-08〜UC-11・UC-24）は、dev_spec.md 5.1 の方式（即時取得・開発用 API のジョブの起動・モックの操作）で
 * 起動し、結果が画面に表れるまでの時間を測る。
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { CATEGORY_LABELS } from '@smart-farm/shared/constants/items';
import { VIEWPOINTS } from '@smart-farm/shared/constants/viewpoints';
import { stubPush } from '../e2e/support/push.ts';
import { clearSourceFiles, placeRobotFiles, placeSensorFiles } from './support/files.ts';
import type { LimitKey } from './support/limits.ts';
import { measure, measureRefresh, trackApi, type ActionSteps } from './support/recorder.ts';
import { STRESS_USER } from './support/scale.ts';
import {
  api,
  expectDashboardShown,
  expectDetailShown,
  fillLogin,
  jstInput,
  loadingView,
  mainArea,
  nextObservedAt,
  runJob,
  screenshot,
  setMock,
} from './support/ui.ts';

const USER = STRESS_USER.userId;
const HOUSE_1 = '負荷試験ハウス1';
const ROBOT_NAME = '負荷試験ロボット1-1';
/** 即時取得・定期取り込みで置くファイルの規模（1ファイル 144 記録）。 */
const FILES = { count: 5, recordsPerFile: 144 };

/** 一覧の各行（テスト ID）。 */
const rowsOf = (page: Page, testId: string): Locator => page.getByTestId(testId);

/** 一覧のすべての行が、指定の文言を含む（絞り込みの結果に、入れ替わった）。 */
async function expectEveryRowContains(rows: Locator, text: string): Promise<void> {
  await expect
    .poll(async () => {
      const texts = await rows.allTextContents();
      return texts.length > 0 && texts.every((item) => item.includes(text));
    })
    .toBe(true);
}

/** 一覧の表示が完了している（読み込み中の表示がなく、1行目が表示されている）。 */
async function expectListShown(page: Page, rowTestId: string): Promise<void> {
  await expect(loadingView(page)).toHaveCount(0);
  await expect(rowsOf(page, rowTestId).first()).toBeVisible();
}

function dateInput(daysAgo: number): string {
  return jstInput(new Date(Date.now() - daysAgo * 86_400_000)).slice(0, 10);
}

test('単独利用: 大量データの状態で、全ユースケースの操作の応答時間を計測する', async ({
  page,
  request,
}) => {
  trackApi(page);
  // Web Push のブラウザの機能（購読・許可）は、スタブにする（UC-23）。ページの読み込みの前に呼ぶ
  await stubPush(page);
  const m = (
    uc: string,
    action: string,
    screen: string,
    limit: LimitKey,
    steps: ActionSteps,
  ): Promise<unknown> => measure(page, { uc, action, screen, limit, user: USER }, steps);
  const banner = page.getByRole('banner');
  const menu = (name: string) =>
    page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name, exact: true });
  const breadcrumbBack = () =>
    page
      .getByRole('navigation', { name: 'パンくず' })
      .getByRole('link', { name: 'ダッシュボード' });
  const backToDashboard = (): Promise<unknown> =>
    m('UC-01', 'ダッシュボードへ戻る（パンくず）', 'ダッシュボード（SC-02）', 'dashboardInitial', {
      act: () => breadcrumbBack().click(),
      respond: () => expectDashboardShown(page),
    });

  // ---------------------------------------------------------------------------------------------
  // UC-13 ログイン
  // ---------------------------------------------------------------------------------------------
  await m('UC-13', 'ログイン画面を開く', 'ログイン（SC-01）', 'screen', {
    act: () => page.goto('/login'),
    respond: () => expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible(),
  });
  await fillLogin(page, USER);
  await m(
    'UC-13',
    'ユーザーID・パスワードを入力して「ログイン」を押す',
    'ログイン（SC-01）→ ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => page.getByRole('button', { name: 'ログイン' }).click(),
      respond: () => expectDashboardShown(page),
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-01 ダッシュボード
  // ---------------------------------------------------------------------------------------------
  await m(
    'UC-01',
    'ダッシュボードを開く（画面の再読み込み）',
    'ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => page.reload(),
      respond: () => expectDashboardShown(page, HOUSE_1),
    },
  );
  await screenshot(page, '01-dashboard-house1');
  const switchEquipment = async (id: string, name: string, what: string): Promise<void> => {
    await m(
      'UC-01',
      `対象の設備を${what}に切り替える`,
      'ダッシュボード（SC-02）',
      'dashboardInitial',
      {
        act: () => banner.getByLabel('対象の設備').selectOption(id),
        respond: () => expectDashboardShown(page, name),
      },
    );
  };
  await switchEquipment('HOUSE-02', '負荷試験ハウス2', 'ハウス2（ロボット2台・センサー2台）');
  await screenshot(page, '02-dashboard-house2');
  await switchEquipment('HOUSE-03', '負荷試験ハウス3', 'ハウス3');
  await switchEquipment('ROBOT-01', ROBOT_NAME, 'ロボット（7観点）');
  await screenshot(page, '03-dashboard-robot');
  await switchEquipment('SENSOR-01', '負荷試験センサー1-1', 'センサー（1観点）');
  await switchEquipment('HOUSE-01', HOUSE_1, 'ハウス1');
  await m('UC-01', '視点を「短期」に切り替える', 'ダッシュボード（SC-02）', 'dashboardInitial', {
    act: () => page.getByRole('radio', { name: '短期' }).check(),
    respond: () => expectDashboardShown(page),
  });
  await m('UC-01', '視点を「長期」に戻す', 'ダッシュボード（SC-02）', 'dashboardInitial', {
    act: () => page.getByRole('radio', { name: '長期' }).check(),
    respond: () => expectDashboardShown(page),
  });
  for (const label of ['当日', '直近30日', '直近60日', '直近90日', '直近7日']) {
    await m(
      'UC-01',
      `長期の期間を「${label}」に切り替える`,
      'ダッシュボード（SC-02）',
      'dashboardInitial',
      {
        act: () => page.getByLabel('長期の期間').selectOption({ label }),
        respond: () => expectDashboardShown(page),
      },
    );
  }
  // NFR-3.3 約10秒ごとの自動更新
  await measureRefresh(
    page,
    {
      uc: 'UC-01',
      action: '画面の自動更新（約10秒ごと。ダッシュボードの再取得）',
      screen: 'ダッシュボード（SC-02）',
      limit: 'refresh',
      user: USER,
    },
    '/dashboard',
  );

  // ---------------------------------------------------------------------------------------------
  // UC-02・UC-04 観点の詳細（診断結果・根拠のメトリクス・推奨アクション）
  // ---------------------------------------------------------------------------------------------
  for (const viewpoint of VIEWPOINTS.filter((item) => item.id !== 'satisfaction')) {
    await m('UC-02', `観点「${viewpoint.name}」の詳細を開く`, '観点の詳細（SC-03）', 'screen', {
      act: () =>
        page.getByTestId(`card-${viewpoint.id}`).getByRole('heading').getByRole('link').click(),
      respond: () => expectDetailShown(page),
    });
    if (viewpoint.id === 'environmentalAdaptability') {
      await screenshot(page, '04-detail-environment');
    }
    await backToDashboard();
  }
  await m(
    'UC-04',
    '注意・異常の観点の推奨アクションを確認する（カードの「詳細を見る」）',
    '観点の詳細（SC-03）',
    'screen',
    {
      act: () =>
        page
          .locator('.viewpoint-card.status-border-error, .viewpoint-card.status-border-caution')
          .first()
          .locator('.card-link')
          .click(),
      respond: async () => {
        await expectDetailShown(page);
        await expect(page.getByTestId('recommended-action').first()).toBeVisible();
      },
    },
  );
  await backToDashboard();

  // ---------------------------------------------------------------------------------------------
  // UC-03 推移（環境適応性の詳細で、期間・視点を切り替える）
  // ---------------------------------------------------------------------------------------------
  await m(
    'UC-02',
    '観点「環境適応性」の詳細を開く（推移の確認）',
    '観点の詳細（SC-03）',
    'screen',
    {
      act: () =>
        page
          .getByTestId('card-environmentalAdaptability')
          .getByRole('heading')
          .getByRole('link')
          .click(),
      respond: () => expectDetailShown(page),
    },
  );
  for (const [label, bucket] of [
    ['直近30日', '日ごと'],
    ['直近60日', '日ごと'],
    ['直近90日', '日ごと'],
    ['当日', '1時間ごと'],
    ['直近7日', '日ごと'],
  ] as const) {
    await m('UC-03', `推移の期間を「${label}」に切り替える`, '観点の詳細・推移（SC-03）', 'trend', {
      act: () => page.getByLabel('長期の期間').selectOption({ label }),
      respond: async () => {
        await expectDetailShown(page);
        await expect(page.getByTestId('trend')).toContainText(`（${bucket}）`);
      },
    });
    if (label === '直近30日') {
      await screenshot(page, '05-trend-30days');
    }
  }
  await m(
    'UC-03',
    '視点を「短期」に切り替える（短期のフィードバック）',
    '観点の詳細・推移（SC-03）',
    'trend',
    {
      act: () => page.getByRole('radio', { name: '短期' }).check(),
      respond: async () => {
        await expectDetailShown(page);
        await expect(page.getByTestId('feedback-short')).toBeVisible();
      },
    },
  );
  await m('UC-03', '視点を「長期」に戻す', '観点の詳細・推移（SC-03）', 'trend', {
    act: () => page.getByRole('radio', { name: '長期' }).check(),
    respond: () => expectDetailShown(page),
  });
  // 元データの表のページ送り
  await m('UC-02', '元データの表で、次のページを開く', '観点の詳細・元データ（SC-03）', 'screen', {
    act: () => page.getByTestId('source-data').getByRole('button', { name: '次へ' }).click(),
    respond: async () => {
      await expect(page.getByTestId('source-data-page')).toHaveText('2');
      await expect(loadingView(page)).toHaveCount(0);
    },
  });
  await backToDashboard();

  // 他の設備の観点の詳細（ロボット・センサー）
  await switchEquipment('ROBOT-01', ROBOT_NAME, 'ロボット（7観点）');
  await m('UC-02', 'ロボットの観点「耐久性」の詳細を開く', '観点の詳細（SC-03）', 'screen', {
    act: () => page.getByTestId('card-durability').getByRole('heading').getByRole('link').click(),
    respond: () => expectDetailShown(page),
  });
  await backToDashboard();
  await switchEquipment('SENSOR-01', '負荷試験センサー1-1', 'センサー（1観点）');
  await m('UC-02', 'センサーの観点「環境適応性」の詳細を開く', '観点の詳細（SC-03）', 'screen', {
    act: () =>
      page
        .getByTestId('card-environmentalAdaptability')
        .getByRole('heading')
        .getByRole('link')
        .click(),
    respond: () => expectDetailShown(page),
  });
  await backToDashboard();
  await switchEquipment('HOUSE-01', HOUSE_1, 'ハウス1');

  // ---------------------------------------------------------------------------------------------
  // UC-21 満足度（レーダーチャート）
  // ---------------------------------------------------------------------------------------------
  const satisfactionShown = async (): Promise<void> => {
    await expect(loadingView(page)).toHaveCount(0);
    await expect(page.getByTestId('overall')).toBeVisible();
    await expect(page.getByTestId('radar')).toBeVisible();
  };
  await m(
    'UC-21',
    'ダッシュボードの「満足度」を選び、満足度の詳細を開く',
    '満足度（SC-04）',
    'screen',
    {
      act: () =>
        page.getByTestId('card-satisfaction').getByRole('heading').getByRole('link').click(),
      respond: satisfactionShown,
    },
  );
  await screenshot(page, '06-satisfaction');
  for (const label of ['直近30日', '直近90日']) {
    await m('UC-21', `長期の期間を「${label}」に切り替える`, '満足度（SC-04）', 'screen', {
      act: () => page.getByLabel('長期の期間').selectOption({ label }),
      respond: satisfactionShown,
    });
  }
  await m(
    'UC-01',
    'メニューから「ダッシュボード」を開く',
    'ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => menu('ダッシュボード').click(),
      respond: () => expectDashboardShown(page),
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-20 取り込み済みデータ（約60万件）の一覧
  // ---------------------------------------------------------------------------------------------
  const observationRows = rowsOf(page, 'observation-row');
  await m(
    'UC-20',
    'メニューから「取り込み済みデータ」を開く',
    '取り込み済みデータ（SC-09）',
    'screen',
    {
      act: () => menu('取り込み済みデータ').click(),
      respond: async () => {
        await expect(
          page.getByRole('heading', { name: '取り込み済みデータ', level: 1 }),
        ).toBeVisible();
        await expectListShown(page, 'observation-row');
      },
    },
  );
  await screenshot(page, '07-observations');
  await m('UC-20', 'カテゴリ「環境情報」で絞り込む', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('カテゴリ').selectOption('ENVIRONMENT'),
    respond: () => expectEveryRowContains(observationRows, CATEGORY_LABELS.ENVIRONMENT),
  });
  await m('UC-20', '取得元「手動入力」で絞り込む', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('取得元').selectOption('MANUAL'),
    respond: () => expectEveryRowContains(observationRows, '手動入力'),
  });
  await m(
    'UC-20',
    '取得元・カテゴリの絞り込みを解除する',
    '取り込み済みデータ（SC-09）',
    'screen',
    {
      act: async () => {
        await page.getByLabel('取得元').selectOption('');
        await page.getByLabel('カテゴリ').selectOption('');
      },
      respond: () => expectListShown(page, 'observation-row'),
    },
  );
  await m('UC-20', '設備「ハウス2」で絞り込む', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('設備', { exact: true }).selectOption('ROBOT-02-1'),
    respond: () => expectEveryRowContains(observationRows, '負荷試験ロボット2-1'),
  });
  await m('UC-20', '設備の絞り込みを解除する', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('設備', { exact: true }).selectOption(''),
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', '期間（直近30日）で絞り込む', '取り込み済みデータ（SC-09）', 'screen', {
    act: async () => {
      await page.getByLabel('期間（開始日）').fill(dateInput(30));
      await page.getByLabel('期間（終了日）').fill(dateInput(0));
    },
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', '期間の絞り込みを解除する', '取り込み済みデータ（SC-09）', 'screen', {
    act: async () => {
      await page.getByLabel('期間（開始日）').fill('');
      await page.getByLabel('期間（終了日）').fill('');
    },
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', 'キーワード「温度」で検索する', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('キーワード').fill('温度'),
    respond: () => expectEveryRowContains(observationRows, '温度'),
  });
  await m('UC-20', 'キーワードを消して、検索を解除する', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('キーワード').fill(''),
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', '値の昇順で並べ替える', '取り込み済みデータ（SC-09）', 'screen', {
    act: async () => {
      await page.getByLabel('並べ替え', { exact: true }).selectOption('value');
      await page.getByLabel('並べ替えの向き').selectOption('asc');
    },
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', 'カテゴリ順に並べ替える', '取り込み済みデータ（SC-09）', 'screen', {
    act: () => page.getByLabel('並べ替え', { exact: true }).selectOption('category'),
    respond: () => expectListShown(page, 'observation-row'),
  });
  await m('UC-20', '日時の新しい順に戻す', '取り込み済みデータ（SC-09）', 'screen', {
    act: async () => {
      await page.getByLabel('並べ替え', { exact: true }).selectOption('observedAt');
      await page.getByLabel('並べ替えの向き').selectOption('desc');
    },
    respond: () => expectListShown(page, 'observation-row'),
  });
  for (const [action, button, expected] of [
    ['次のページを開く（2ページ目）', '次へ', '2'],
    ['次のページを開く（3ページ目）', '次へ', '3'],
    ['前のページへ戻る', '前へ', '2'],
  ] as const) {
    await m('UC-20', action, '取り込み済みデータ（SC-09）', 'screen', {
      act: () => page.getByRole('button', { name: button }).click(),
      respond: async () => {
        await expect(page.getByTestId('pager-page')).toHaveText(expected);
        await expectListShown(page, 'observation-row');
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // UC-06・UC-07 復旧対応・取得できないデータの手動入力
  // ---------------------------------------------------------------------------------------------
  const form = mainArea(page);
  const entryResult = page.getByTestId('entry-result');
  await m('UC-06', 'メニューから「データ入力」を開く', 'データ入力（SC-06）', 'screen', {
    act: () => menu('データ入力').click(),
    respond: async () => {
      await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
      await expect(form.getByLabel('対象の設備')).toBeVisible();
    },
  });
  await form.getByLabel('対象の設備').selectOption('ROBOT-01');
  await form.getByLabel('カテゴリ').selectOption('FAILURE');
  await form.getByLabel('計測日時（日本時間）').fill(nextObservedAt());
  await form.getByTestId('entry-items').getByLabel('故障回数').fill('1');
  await form.getByTestId('entry-items').getByLabel('復旧に要した時間').fill('90');
  await form.getByLabel('備考（所感・補足情報）').fill('負荷試験: 走行モーターの異常を復旧した');
  await m(
    'UC-06',
    '復旧対応の結果（故障回数・復旧時間・備考）を入力して「保存する」を押す',
    'データ入力（SC-06）',
    'operation',
    {
      act: () => form.getByRole('button', { name: '保存する' }).click(),
      respond: async () => {
        await expect(entryResult).toContainText('保存しました');
        await expect(page.getByTestId('related-maintainability')).toBeVisible();
      },
    },
  );
  await screenshot(page, '08-data-entry-saved');
  await form.getByLabel('対象の設備').selectOption('SENSOR-01');
  await form.getByLabel('カテゴリ').selectOption('ENVIRONMENT');
  await form.getByLabel('計測日時（日本時間）').fill(nextObservedAt());
  await form.getByTestId('entry-items').getByLabel('温度').fill('23');
  await form.getByTestId('entry-items').getByLabel('湿度').fill('60');
  await m(
    'UC-07',
    '自動取得できない環境の値（温度・湿度）を入力して「保存する」を押す',
    'データ入力（SC-06）',
    'operation',
    {
      act: () => form.getByRole('button', { name: '保存する' }).click(),
      respond: async () => {
        await expect(entryResult).toContainText('保存しました');
        await expect(page.getByTestId('related-environmentalAdaptability')).toBeVisible();
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-10 異常・注意を検知して通知する（手動入力の保存 → 通知。定期のジョブ JB-02・配信 JB-04）
  // ---------------------------------------------------------------------------------------------
  await form.getByLabel('対象の設備').selectOption('SENSOR-01');
  await form.getByLabel('カテゴリ').selectOption('ENVIRONMENT');
  // 異常な値は、最も新しい計測日時（現在の分）で入力する（短期の評価は、最新の値を使う）
  await form.getByLabel('計測日時（日本時間）').fill(jstInput(new Date()));
  await form.getByTestId('entry-items').getByLabel('温度').fill('40');
  await form.getByTestId('entry-items').getByLabel('湿度').fill('60');
  await m(
    'UC-10',
    '異常な値（温度 40℃）を入力して保存し、評価の更新・通知を起こす',
    'データ入力（SC-06）',
    'operation',
    {
      act: () => form.getByRole('button', { name: '保存する' }).click(),
      respond: async () => {
        await expect(entryResult).toContainText('保存しました');
        await expect(page.getByTestId('related-environmentalAdaptability')).toContainText('異常');
      },
    },
  );
  await m(
    'UC-10',
    'ヘッダーの未読件数から通知の一覧を開き、新しい異常の通知を確認する',
    '通知（SC-05）',
    'screen',
    {
      act: () => page.getByRole('link', { name: /^未読の通知/ }).click(),
      respond: async () => {
        await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
        await expect(rowsOf(page, 'notification-row').first()).toContainText('環境適応性');
        await expect(rowsOf(page, 'notification-row').first()).toContainText('異常');
      },
    },
  );
  await screenshot(page, '09-notifications-after-abnormal');
  await m(
    'UC-10',
    '評価の定期実行（JB-02）を起動し、ダッシュボードで結果を確認する',
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
  await m(
    'UC-10',
    '通知の配信（JB-04）を起動し、通知の一覧で結果を確認する',
    '通知（SC-05）',
    'job',
    {
      act: async () => `JB-04 の実行 ${String(await runJob(request, USER, 'JB-04'))} ms`,
      respond: async () => {
        await menu('通知').click();
        await expectListShown(page, 'notification-row');
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-18 入力済みデータ（約5,000件）の一覧・修正・削除・変更履歴
  // ---------------------------------------------------------------------------------------------
  const entryRows = rowsOf(page, 'entry-row');
  const entryNotice = page.getByTestId('entries-notice');
  await m(
    'UC-18',
    'データ入力の画面から「入力済みデータの一覧へ」を開く',
    '入力済みデータ（SC-07）',
    'screen',
    {
      act: async () => {
        await menu('データ入力').click();
        await page.getByRole('link', { name: '入力済みデータの一覧へ' }).click();
      },
      respond: async () => {
        await expect(page.getByRole('heading', { name: '入力済みデータ', level: 1 })).toBeVisible();
        await expectListShown(page, 'entry-row');
      },
    },
  );
  await screenshot(page, '10-entry-list');
  await m('UC-18', 'キーワード「負荷試験」で検索する', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('キーワード').fill('負荷試験'),
    respond: () => expectEveryRowContains(entryRows, '負荷試験'),
  });
  await m('UC-18', 'キーワードを消す', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('キーワード').fill(''),
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', 'カテゴリ「故障情報」で絞り込む', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('カテゴリ').selectOption('FAILURE'),
    respond: () => expectEveryRowContains(entryRows, CATEGORY_LABELS.FAILURE),
  });
  await m('UC-18', 'カテゴリの絞り込みを解除する', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('カテゴリ').selectOption(''),
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', '設備「ロボット」で絞り込む', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('設備', { exact: true }).selectOption('ROBOT-01'),
    respond: () => expectEveryRowContains(entryRows, ROBOT_NAME),
  });
  await m('UC-18', '設備の絞り込みを解除する', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('設備', { exact: true }).selectOption(''),
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', '計測日時の期間（直近30日）で絞り込む', '入力済みデータ（SC-07）', 'screen', {
    act: async () => {
      await page.getByLabel('期間（開始日）').fill(dateInput(30));
      await page.getByLabel('期間（終了日）').fill(dateInput(0));
    },
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', '期間の絞り込みを解除する', '入力済みデータ（SC-07）', 'screen', {
    act: async () => {
      await page.getByLabel('期間（開始日）').fill('');
      await page.getByLabel('期間（終了日）').fill('');
    },
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', 'カテゴリの昇順に並べ替える', '入力済みデータ（SC-07）', 'screen', {
    act: async () => {
      await page.getByLabel('並べ替え', { exact: true }).selectOption('category');
      await page.getByLabel('並べ替えの向き').selectOption('asc');
    },
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', '入力者の順に並べ替える', '入力済みデータ（SC-07）', 'screen', {
    act: () => page.getByLabel('並べ替え', { exact: true }).selectOption('enteredBy'),
    respond: () => expectListShown(page, 'entry-row'),
  });
  await m('UC-18', '計測日時の新しい順に戻す', '入力済みデータ（SC-07）', 'screen', {
    act: async () => {
      await page.getByLabel('並べ替え', { exact: true }).selectOption('observedAt');
      await page.getByLabel('並べ替えの向き').selectOption('desc');
    },
    respond: () => expectListShown(page, 'entry-row'),
  });
  for (const [action, button, expected] of [
    ['次のページを開く', '次へ', '2'],
    ['前のページへ戻る', '前へ', '1'],
  ] as const) {
    await m('UC-18', action, '入力済みデータ（SC-07）', 'screen', {
      act: () => page.getByRole('button', { name: button }).click(),
      respond: async () => {
        await expect(page.getByTestId('pager-page')).toHaveText(expected);
        await expectListShown(page, 'entry-row');
      },
    });
  }
  const editor = page.getByTestId('entry-edit');
  await m(
    'UC-18',
    '先頭の入力（異常な温度の入力）の「修正」を押す',
    '入力済みデータ（SC-07）',
    'screen',
    {
      act: () => entryRows.first().getByRole('button', { name: '修正' }).click(),
      respond: () => expect(editor).toBeVisible(),
    },
  );
  await editor.getByTestId('entry-items').getByLabel('温度').fill('24');
  await m(
    'UC-18',
    '温度を修正して「保存」を押す（評価の更新を含む）',
    '入力済みデータ（SC-07）',
    'operation',
    {
      act: () => editor.getByRole('button', { name: '保存', exact: true }).click(),
      respond: async () => {
        await expect(entryNotice).toHaveText('修正しました');
        await expect(editor).toHaveCount(0);
      },
    },
  );
  await m(
    'UC-18',
    '2番目の入力の「削除」を押し、確認で削除する',
    '入力済みデータ（SC-07）',
    'operation',
    {
      act: async () => {
        await entryRows.nth(1).getByRole('button', { name: '削除' }).click();
        await page
          .getByTestId('confirm-dialog')
          .getByRole('button', { name: '削除', exact: true })
          .click();
      },
      respond: async () => {
        await expect(entryNotice).toHaveText('削除しました');
        await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
      },
    },
  );
  await m(
    'UC-18',
    '「変更履歴を見る」から変更履歴（約5,000件）を開く',
    '変更履歴（SC-08）',
    'screen',
    {
      act: () => page.getByRole('link', { name: '変更履歴を見る' }).click(),
      respond: async () => {
        await expect(page.getByRole('heading', { name: '変更履歴', level: 1 })).toBeVisible();
        await expectListShown(page, 'audit-row');
      },
    },
  );
  await screenshot(page, '11-audit-history');
  await m('UC-18', '操作種別「削除」で絞り込む', '変更履歴（SC-08）', 'screen', {
    act: () => page.getByLabel('操作種別').selectOption('DELETE'),
    respond: () => expectEveryRowContains(rowsOf(page, 'audit-row'), '削除'),
  });
  await m('UC-18', '変更者「stress-user-03」で絞り込む', '変更履歴（SC-08）', 'screen', {
    act: async () => {
      await page.getByLabel('操作種別').selectOption('');
      await page.getByLabel('変更者').fill('stress-user-03');
    },
    respond: () => expectEveryRowContains(rowsOf(page, 'audit-row'), 'stress-user-03'),
  });
  await m('UC-18', '絞り込みを解除し、次のページを開く', '変更履歴（SC-08）', 'screen', {
    act: async () => {
      await page.getByLabel('変更者').fill('');
      await page.getByRole('button', { name: '次へ' }).click();
    },
    respond: async () => {
      await expect(page.getByTestId('pager-page')).toHaveText('2');
      await expectListShown(page, 'audit-row');
    },
  });

  // ---------------------------------------------------------------------------------------------
  // UC-19 判断基準の編集（環境適応性）
  // ---------------------------------------------------------------------------------------------
  await menu('ダッシュボード').click();
  await expectDashboardShown(page);
  await page
    .getByTestId('card-environmentalAdaptability')
    .getByRole('heading')
    .getByRole('link')
    .click();
  await expectDetailShown(page);
  await m('UC-19', '観点の詳細から「判断基準を編集」を開く', '判断基準の編集（SC-13）', 'screen', {
    act: () => page.getByRole('link', { name: '判断基準を編集' }).click(),
    respond: async () => {
      await expect(page.getByRole('heading', { name: /判断基準の編集/, level: 1 })).toBeVisible();
      await expect(page.getByTestId('criterion-edit-temperatureCelsius')).toBeVisible();
    },
  });
  await page
    .getByTestId('criterion-edit-temperatureCelsius')
    .getByLabel('正常上限（未満で正常）')
    .fill('26');
  await m(
    'UC-19',
    '温度の閾値を変更して「保存する」を押す（評価の更新を含む）',
    '判断基準の編集（SC-13）',
    'operation',
    {
      act: () => page.getByRole('button', { name: '保存する' }).click(),
      respond: () =>
        expect(page.getByTestId('criteria-notice')).toHaveText(
          '保存しました。現在の評価を更新しました',
        ),
    },
  );
  await m('UC-19', '「既定値へ戻す」を押し、確認で戻す', '判断基準の編集（SC-13）', 'operation', {
    act: async () => {
      await page.getByRole('button', { name: '既定値へ戻す' }).click();
      await page
        .getByTestId('confirm-dialog')
        .getByRole('button', { name: '既定値へ戻す', exact: true })
        .click();
    },
    respond: () => expect(page.getByTestId('criteria-notice')).toHaveText('既定値へ戻しました'),
  });
  await menu('ダッシュボード').click();
  await expectDashboardShown(page);

  // ---------------------------------------------------------------------------------------------
  // UC-15・UC-16・UC-08・UC-09・UC-11・UC-24 取り込み・連携（即時取得・定期取り込み・連携・失敗の通知）
  // ---------------------------------------------------------------------------------------------
  const sourceCard = (id: 'robot' | 'environment-sensor') => page.getByTestId(`source-${id}`);
  const result = (id: 'robot' | 'environment-sensor') => page.getByTestId(`result-${id}`);
  const logRows = rowsOf(page, 'ingestion-log-row');
  const ingestionShown = async (): Promise<void> => {
    await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
    await expect(sourceCard('robot')).toBeVisible();
    await expect(sourceCard('environment-sensor')).toBeVisible();
    await expectListShown(page, 'ingestion-log-row');
    await expect(rowsOf(page, 'federation-log-row').first()).toBeVisible();
  };
  clearSourceFiles('robot');
  clearSourceFiles('environment-sensor');
  await m(
    'UC-16',
    'メニューから「取り込み」を開く（取り込みのログ・連携の状況を表示）',
    '取り込み設定・状況（SC-11）',
    'screen',
    {
      act: () => menu('取り込み').click(),
      respond: ingestionShown,
    },
  );
  await screenshot(page, '12-ingestion');
  for (const [id, name] of [
    ['robot', 'ロボットデータ'],
    ['environment-sensor', '環境センサーデータ'],
  ] as const) {
    await sourceCard(id).getByLabel('取得間隔').selectOption({ label: '5分' });
    await m(
      'UC-15',
      `${name}の取得間隔を5分に変更して「設定を保存」を押す`,
      '取り込み設定・状況（SC-11）',
      'operation',
      {
        act: () => sourceCard(id).getByRole('button', { name: '設定を保存' }).click(),
        respond: () => expect(result(id)).toHaveText('設定を保存しました'),
      },
    );
  }
  await m(
    'UC-15',
    'ロボットデータの「接続テスト」を押す',
    '取り込み設定・状況（SC-11）',
    'operation',
    {
      act: () => sourceCard('robot').getByRole('button', { name: '接続テスト' }).click(),
      respond: () => expect(result('robot')).toBeVisible(),
    },
  );

  // UC-08・UC-09 即時取得（ファイルサーバーにファイルを置き、画面の「即時取得」を押す）
  placeRobotFiles({ startIndex: 0, ...FILES });
  await m(
    'UC-08',
    `ロボットのデータ（${String(FILES.count)} ファイル・各 ${String(FILES.recordsPerFile)} 記録）を「即時取得」する`,
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: () => sourceCard('robot').getByRole('button', { name: '即時取得' }).click(),
      respond: () => expect(result('robot')).toContainText(`ファイル ${String(FILES.count)} 件`),
    },
  );
  placeSensorFiles({ startIndex: 0, ...FILES });
  await m(
    'UC-09',
    `環境センサーのデータ（${String(FILES.count)} ファイル・各 ${String(FILES.recordsPerFile)} 行）を「即時取得」する`,
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: () => sourceCard('environment-sensor').getByRole('button', { name: '即時取得' }).click(),
      respond: () =>
        expect(result('environment-sensor')).toContainText(`ファイル ${String(FILES.count)} 件`),
    },
  );
  await m(
    'UC-08',
    '取り込んだデータを「取り込み済みデータ」で確認する',
    '取り込み済みデータ（SC-09）',
    'screen',
    {
      act: () => menu('取り込み済みデータ').click(),
      respond: () => expectListShown(page, 'observation-row'),
    },
  );
  await m(
    'UC-08',
    '取り込みの結果が、ダッシュボードの評価に反映されている',
    'ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => menu('ダッシュボード').click(),
      respond: () => expectDashboardShown(page),
    },
  );

  // UC-08・UC-09 定期取り込み（JB-01）: 取得間隔（5分）が過ぎたことにして、ジョブを起動する
  await menu('取り込み').click();
  await ingestionShown();
  placeRobotFiles({ startIndex: 100, ...FILES });
  placeSensorFiles({ startIndex: 100, ...FILES });
  const advanced = await api(request, USER, 'POST', '/dev/clock/advance', { minutes: 6 });
  expect(advanced.ok()).toBe(true);
  const firstLog = (await logRows.first().textContent()) ?? '';
  await m(
    'UC-08',
    '定期取り込み（JB-01）を起動し、取り込みのログで結果を確認する',
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: async () => `JB-01 の実行 ${String(await runJob(request, USER, 'JB-01'))} ms`,
      respond: async () => {
        await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
        await expect(logRows.first()).not.toHaveText(firstLog);
      },
    },
  );

  // UC-16 取り込みのログ・連携の状況の絞り込み・ページ送り
  const logs = page.getByTestId('ingestion-logs');
  await m(
    'UC-16',
    '取り込みのログを、取り込み元（ロボットデータ）で絞り込む',
    '取り込み設定・状況（SC-11）',
    'screen',
    {
      act: () => logs.getByLabel('取り込み元').selectOption('robot'),
      respond: async () => {
        await expect(loadingView(page)).toHaveCount(0);
        await expectEveryRowContains(logRows, 'ロボット');
      },
    },
  );
  await m('UC-16', '取り込みのログの、次のページを開く', '取り込み設定・状況（SC-11）', 'screen', {
    act: () => logs.getByRole('button', { name: '次へ' }).click(),
    respond: async () => {
      await expect(logs.getByTestId('pager-page')).toHaveText('2');
      await expect(loadingView(page)).toHaveCount(0);
    },
  });
  await m('UC-16', '取り込みのログの絞り込みを解除する', '取り込み設定・状況（SC-11）', 'screen', {
    act: () => logs.getByLabel('取り込み元').selectOption(''),
    respond: () => expectListShown(page, 'ingestion-log-row'),
  });
  const federation = page.getByTestId('federation-section');
  await m('UC-16', '連携の結果の、次のページを開く', '取り込み設定・状況（SC-11）', 'screen', {
    act: () => federation.getByRole('button', { name: '次へ' }).click(),
    respond: async () => {
      await expect(federation.getByTestId('pager-page')).toHaveText('2');
      await expect(loadingView(page)).toHaveCount(0);
    },
  });

  // UC-11 農業情報基盤への連携（ジョブ JB-03）。停止中は保留になり、復旧後に送る
  await m(
    'UC-11',
    '連携（JB-03）を起動し、連携の状況で結果を確認する',
    '取り込み設定・状況（SC-11）',
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
  await setMock(request, USER, 'federation', 'DOWN');
  await m(
    'UC-11',
    '農業情報基盤の停止中に連携（JB-03）を起動し、保留を確認する',
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: async () => `JB-03 の実行 ${String(await runJob(request, USER, 'JB-03'))} ms`,
      respond: async () => {
        await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
        await expect(page.getByTestId('queue-HELD')).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
      },
    },
  );
  await setMock(request, USER, 'federation', 'UP');
  await m(
    'UC-11',
    '農業情報基盤の復旧後に連携（JB-03）を起動し、保留分の送信を確認する',
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: async () => `JB-03 の実行 ${String(await runJob(request, USER, 'JB-03'))} ms`,
      respond: async () => {
        await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
        await expect(page.getByTestId('queue-SENT')).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
      },
    },
  );

  // UC-24 取り込み失敗の通知（ファイルサーバーの停止 → 即時取得 → 通知）
  await setMock(request, USER, 'file-server', 'DOWN');
  await m(
    'UC-24',
    'ファイルサーバーの停止中に「即時取得」を押す（再試行のあと失敗）',
    '取り込み設定・状況（SC-11）',
    'job',
    {
      act: () => sourceCard('robot').getByRole('button', { name: '即時取得' }).click(),
      respond: () => expect(result('robot')).toContainText('失敗'),
    },
  );
  await setMock(request, USER, 'file-server', 'UP');
  await m('UC-24', '取り込み失敗の通知を、通知の一覧で確認する', '通知（SC-05）', 'screen', {
    act: () => menu('通知').click(),
    respond: async () => {
      await expect(rowsOf(page, 'notification-row').first()).toContainText('データ取得失敗');
      await expectListShown(page, 'notification-row');
    },
  });

  // ---------------------------------------------------------------------------------------------
  // UC-05・UC-22 通知（約5,000件）の一覧・絞り込み・既読
  // ---------------------------------------------------------------------------------------------
  const notificationRows = rowsOf(page, 'notification-row');
  await screenshot(page, '13-notifications');
  await m('UC-22', '種別「異常検知」で絞り込む', '通知（SC-05）', 'screen', {
    act: () => page.getByLabel('種別').selectOption('STATUS_CHANGE'),
    respond: () => expectEveryRowContains(notificationRows, '異常検知'),
  });
  await m(
    'UC-05',
    '通知の「詳細を確認」を押し、異常の対象の観点の詳細を開く',
    '観点の詳細（SC-03）',
    'screen',
    {
      act: () => notificationRows.first().getByRole('link', { name: '詳細を確認' }).click(),
      respond: () => expectDetailShown(page),
    },
  );
  await m('UC-22', '通知の一覧に戻る（メニュー）', '通知（SC-05）', 'screen', {
    act: () => menu('通知').click(),
    respond: () => expectListShown(page, 'notification-row'),
  });
  await m('UC-22', '種別「データ取得失敗」で絞り込む', '通知（SC-05）', 'screen', {
    act: async () => {
      await page.getByLabel('種別').selectOption('');
      await page.getByLabel('種別').selectOption('INGESTION_FAILURE');
    },
    respond: () => expectEveryRowContains(notificationRows, 'データ取得失敗'),
  });
  await m(
    'UC-05',
    '通知の「取り込みの状況を確認」を押し、取り込みの状況を開く',
    '取り込み設定・状況（SC-11）',
    'screen',
    {
      act: () =>
        notificationRows.first().getByRole('link', { name: '取り込みの状況を確認' }).click(),
      respond: ingestionShown,
    },
  );
  await menu('通知').click();
  await expectListShown(page, 'notification-row');
  await m('UC-22', '既読状態「未読」で絞り込む', '通知（SC-05）', 'screen', {
    act: () => page.getByLabel('既読状態').selectOption('UNREAD'),
    respond: () => expectEveryRowContains(notificationRows, '未読'),
  });
  for (const [action, button, expected] of [
    ['次のページを開く', '次へ', '2'],
    ['前のページへ戻る', '前へ', '1'],
  ] as const) {
    await m('UC-22', action, '通知（SC-05）', 'screen', {
      act: () => page.getByRole('button', { name: button }).click(),
      respond: async () => {
        await expect(page.getByTestId('pager-page')).toHaveText(expected);
        await expectListShown(page, 'notification-row');
      },
    });
  }
  const unreadBefore = (await page.getByTestId('unread-count').textContent()) ?? '';
  await m('UC-22', '先頭の通知の「既読にする」を押す', '通知（SC-05）', 'operation', {
    act: () => notificationRows.first().getByRole('button', { name: '既読にする' }).click(),
    respond: () => expect(page.getByTestId('unread-count')).not.toHaveText(unreadBefore),
  });
  await m('UC-22', '絞り込みの範囲（未読）を、まとめて既読にする', '通知（SC-05）', 'operation', {
    act: () => page.getByRole('button', { name: '絞り込みの範囲を既読にする' }).click(),
    respond: () => expect(page.getByTestId('unread-count')).toHaveText('0'),
  });
  await m(
    'UC-22',
    '絞り込みを解除し、「すべての通知を既読にする」を押す',
    '通知（SC-05）',
    'operation',
    {
      act: async () => {
        await page.getByLabel('既読状態').selectOption('');
        await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
      },
      respond: async () => {
        await expect(page.getByTestId('unread-count')).toHaveText('0');
        await expectListShown(page, 'notification-row');
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-12 設備の登録・編集・削除（設備の変更は、評価の更新を伴う）
  // ---------------------------------------------------------------------------------------------
  const equipmentRows = rowsOf(page, 'equipment-row');
  const equipmentNotice = page.getByTestId('equipment-notice');
  const facilityForm = page.getByRole('form', { name: 'ハウスを登録' });
  const childForm = page.getByRole('form', { name: 'ロボット・環境センサーを登録' });
  await m('UC-12', 'メニューから「設備」を開く', '設備（SC-10）', 'screen', {
    act: () => menu('設備').click(),
    respond: async () => {
      await expect(page.getByRole('heading', { name: '設備', level: 1 })).toBeVisible();
      await expectListShown(page, 'equipment-row');
    },
  });
  await screenshot(page, '14-equipment');
  await facilityForm.getByLabel('設備ID').fill('HOUSE-ADDED');
  await facilityForm.getByLabel('名称').fill('負荷試験の追加ハウス');
  await m(
    'UC-12',
    'ハウスを登録する（設備ID・名称を入力して「登録する」）',
    '設備（SC-10）',
    'operation',
    {
      act: () => facilityForm.getByRole('button', { name: '登録する' }).click(),
      respond: () => expect(equipmentNotice).toHaveText('登録しました'),
    },
  );
  for (const [type, id, name, externalId] of [
    ['ROBOT', 'ROBOT-ADDED', '負荷試験の追加ロボット', 'ROBOT-ADDED-FILE'],
    ['SENSOR', 'SENSOR-ADDED', '負荷試験の追加センサー', 'SENSOR-ADDED-FILE'],
  ] as const) {
    await childForm.getByLabel('種別').selectOption(type);
    await childForm.getByLabel('親のハウス').selectOption('HOUSE-ADDED');
    await childForm.getByLabel('設備ID').fill(id);
    await childForm.getByLabel('名称').fill(name);
    await childForm.getByLabel('データ上の識別子').fill(externalId);
    await m(
      'UC-12',
      `${type === 'ROBOT' ? 'ロボット' : '環境センサー'}をハウスに紐づけて登録する`,
      '設備（SC-10）',
      'operation',
      {
        act: () => childForm.getByRole('button', { name: '登録する' }).click(),
        respond: async () => {
          await expect(equipmentRows.filter({ hasText: id })).toBeVisible();
        },
      },
    );
  }
  await m('UC-12', '追加したロボットの「修正」を押す', '設備（SC-10）', 'screen', {
    act: () =>
      equipmentRows
        .filter({ hasText: 'ROBOT-ADDED' })
        .getByRole('button', { name: '修正' })
        .click(),
    respond: () => expect(page.getByTestId('equipment-edit')).toBeVisible(),
  });
  await page.getByTestId('equipment-edit').getByLabel('名称').fill('負荷試験の追加ロボット（改）');
  await m('UC-12', 'ロボットの名称を変更して「保存」を押す', '設備（SC-10）', 'operation', {
    act: () => page.getByTestId('equipment-edit').getByRole('button', { name: '保存' }).click(),
    respond: () => expect(equipmentNotice).toHaveText('修正しました'),
  });
  await m(
    'UC-12',
    '追加したハウス（配下のロボット・センサーを含む）の「削除」を押し、確認で削除する',
    '設備（SC-10）',
    'operation',
    {
      act: async () => {
        await equipmentRows
          .filter({ hasText: 'HOUSE-ADDED' })
          .first()
          .getByRole('button', { name: '削除' })
          .click();
        await page
          .getByTestId('confirm-dialog')
          .getByRole('button', { name: '削除', exact: true })
          .click();
      },
      respond: async () => {
        await expect(equipmentNotice).toHaveText('削除しました');
        await expect(equipmentRows.filter({ hasText: 'ROBOT-ADDED' })).toHaveCount(0);
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-17 ステータスコード（約300件）の登録・編集・削除
  // ---------------------------------------------------------------------------------------------
  const codeRows = rowsOf(page, 'status-code-row');
  const codeNotice = page.getByTestId('status-codes-notice');
  const codeAdd = page.getByTestId('status-code-add');
  await m(
    'UC-17',
    'メニューから「ステータスコード」を開く',
    'ステータスコード（SC-12）',
    'screen',
    {
      act: () => menu('ステータスコード').click(),
      respond: async () => {
        await expect(
          page.getByRole('heading', { name: 'ステータスコード', level: 1 }),
        ).toBeVisible();
        await expectListShown(page, 'status-code-row');
      },
    },
  );
  await screenshot(page, '15-status-codes');
  await codeAdd.getByLabel('コード値').fill('STRESS_NEW_CODE');
  await codeAdd.getByLabel('名称').fill('負荷試験の追加コード');
  await codeAdd.getByLabel('カテゴリ').selectOption('CAUTION');
  await codeAdd.getByLabel('説明').fill('負荷試験で登録したコード');
  await m(
    'UC-17',
    'ステータスコードを登録する（「登録する」）',
    'ステータスコード（SC-12）',
    'operation',
    {
      act: () => codeAdd.getByRole('button', { name: '登録する' }).click(),
      respond: () => expect(codeNotice).toHaveText('登録しました'),
    },
  );
  await m('UC-17', '登録したコードの「修正」を押す', 'ステータスコード（SC-12）', 'screen', {
    act: () =>
      page
        .locator('[data-testid="status-code-row"][data-code="STRESS_NEW_CODE"]')
        .getByRole('button', { name: '修正' })
        .click(),
    respond: () => expect(page.getByTestId('status-code-edit')).toBeVisible(),
  });
  await page.getByTestId('status-code-edit').getByLabel('名称').fill('負荷試験の追加コード（改）');
  await page.getByTestId('status-code-edit').getByLabel('カテゴリ').selectOption('ERROR');
  await m(
    'UC-17',
    '名称・カテゴリを変更して「保存」を押す',
    'ステータスコード（SC-12）',
    'operation',
    {
      act: () => page.getByTestId('status-code-edit').getByRole('button', { name: '保存' }).click(),
      respond: () => expect(codeNotice).toHaveText('修正しました'),
    },
  );
  await m(
    'UC-17',
    '登録したコードの「削除」を押し、確認で削除する',
    'ステータスコード（SC-12）',
    'operation',
    {
      act: async () => {
        await page
          .locator('[data-testid="status-code-row"][data-code="STRESS_NEW_CODE"]')
          .getByRole('button', { name: '削除' })
          .click();
        await page
          .getByTestId('confirm-dialog')
          .getByRole('button', { name: '削除', exact: true })
          .click();
      },
      respond: async () => {
        await expect(codeNotice).toHaveText('削除しました');
        await expect(codeRows.filter({ hasText: 'STRESS_NEW_CODE' })).toHaveCount(0);
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-14 ユーザー管理
  // ---------------------------------------------------------------------------------------------
  const userRows = rowsOf(page, 'user-row');
  const userNotice = page.getByTestId('users-notice');
  const userAdd = page.getByTestId('user-add');
  await m(
    'UC-14',
    'メニューから「ユーザー」を開く（最終ログイン日時を確認）',
    'ユーザー（SC-14）',
    'screen',
    {
      act: () => menu('ユーザー').click(),
      respond: async () => {
        await expect(page.getByRole('heading', { name: 'ユーザー', level: 1 })).toBeVisible();
        await expectListShown(page, 'user-row');
      },
    },
  );
  await screenshot(page, '16-users');
  await userAdd.getByLabel('ユーザーID').fill('stress-added-user');
  await userAdd.getByLabel('ユーザー名').fill('負荷試験の追加ユーザー');
  await userAdd.getByLabel('パスワード').fill('Dummy-Passw0rd-added1');
  await m(
    'UC-14',
    'ユーザーを登録する（ユーザーID・ユーザー名・パスワードを入力して「登録する」）',
    'ユーザー（SC-14）',
    'operation',
    {
      act: () => userAdd.getByRole('button', { name: '登録する' }).click(),
      respond: () => expect(userNotice).toHaveText('登録しました'),
    },
  );
  const addedRow = page.locator('[data-testid="user-row"][data-user-id="stress-added-user"]');
  await m('UC-14', '登録したユーザーの「修正」を押す', 'ユーザー（SC-14）', 'screen', {
    act: () => addedRow.getByRole('button', { name: '修正' }).click(),
    respond: () => expect(page.getByTestId('user-edit')).toBeVisible(),
  });
  await page.getByTestId('user-edit').getByLabel('ユーザー名').fill('負荷試験の追加ユーザー（改）');
  await m('UC-14', 'ユーザー名を変更して「保存」を押す', 'ユーザー（SC-14）', 'operation', {
    act: () => page.getByTestId('user-edit').getByRole('button', { name: '保存' }).click(),
    respond: () => expect(userNotice).toHaveText('修正しました'),
  });
  await m(
    'UC-14',
    '登録したユーザーの「削除」を押し、確認で削除する',
    'ユーザー（SC-14）',
    'operation',
    {
      act: async () => {
        await addedRow.getByRole('button', { name: '削除' }).click();
        await page
          .getByTestId('confirm-dialog')
          .getByRole('button', { name: '削除', exact: true })
          .click();
      },
      respond: async () => {
        await expect(userNotice).toHaveText('削除しました');
        await expect(userRows.filter({ hasText: 'stress-added-user' })).toHaveCount(0);
      },
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-23 Web Push 通知の設定
  // ---------------------------------------------------------------------------------------------
  await m('UC-23', 'メニューから「通知の設定」を開く', '通知の設定（SC-15）', 'screen', {
    act: () => menu('通知の設定').click(),
    respond: async () => {
      await expect(page.getByRole('heading', { name: '通知の設定', level: 1 })).toBeVisible();
      await expect(page.getByTestId('push-state')).toBeVisible();
    },
  });
  await m(
    'UC-23',
    '「有効にする」を押し、Web Push 通知を有効にする',
    '通知の設定（SC-15）',
    'operation',
    {
      act: () => page.getByRole('button', { name: '有効にする' }).click(),
      respond: () => expect(page.getByTestId('push-done')).toBeVisible(),
    },
  );
  await m(
    'UC-23',
    '「解除する」を押し、Web Push 通知を解除する',
    '通知の設定（SC-15）',
    'operation',
    {
      act: () => page.getByRole('button', { name: '解除する' }).click(),
      respond: () => expect(page.getByTestId('push-done')).toContainText('解除'),
    },
  );

  // ---------------------------------------------------------------------------------------------
  // UC-13 ログアウト
  // ---------------------------------------------------------------------------------------------
  await m('UC-13', 'ヘッダーの「ログアウト」を押す', 'ログイン（SC-01）', 'screen', {
    act: () => banner.getByRole('button', { name: 'ログアウト' }).click(),
    respond: () => expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible(),
  });
});
