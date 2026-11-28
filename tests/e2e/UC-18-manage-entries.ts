/**
 * UC-18 入力済みデータを管理する（一覧・修正・削除・履歴）（SC-07、SC-08。FR-4.2.1〜FR-4.2.3、NFR-5.7）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、入力済みデータの一覧を開く
 *               2. 農作業者が、検索・絞り込み・並べ替えで対象を探す（検索はキーワード、絞り込みはカテゴリ・設備・計測日時の期間、
 *                  並べ替えは計測日時・カテゴリ・入力者）
 *               3. 農作業者が、データを修正または削除する
 *               4. システムが、入力内容を検証して保存する
 *               5. 農作業者が、変更の履歴を参照する（操作種別・変更者・期間で絞り込み）
 *   代替フロー  ・修正内容が不正な場合は、UC-06 と同様にエラーを表示する
 *               ・削除は論理削除とし、一覧・集計の対象から除外する
 *   事後条件    入力データが更新され、変更の履歴（操作種別、対象、変更者、変更前後の値、日時）が保持されている
 *   補足        修正・削除後の評価の更新と通知の扱い（暫定: 保存後と同じく、評価を更新し、状態が変われば通知する）
 *
 * 値の同値分割: キーワード（項目名・値と単位・備考・入力者・設備名・カテゴリ名・該当なし）、カテゴリ・設備・期間（境界を含む）、
 * 並べ替えのキー（計測日時・カテゴリ・入力者）と向き、件数（0・1ページ・複数ページ）、操作（修正・削除・確認の取り消し）、
 * 履歴の絞り込み（操作種別3種・変更者・対象の種類・期間）、利用者（入力者・修正者）、権限（変更・履歴の参照）。
 * 関連するユースケース: UC-06・UC-07（入力）、UC-20（一覧からの除外）、UC-10（再評価の通知）、UC-01（評価）、UC-19（判断基準の履歴）。
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  USER_B,
  VIEWER,
  accessToken,
  addEntry,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  confirmDialog,
  newUserSession,
  openAs,
  prepareApp,
  setEquipmentInterval,
} from './support/app.ts';
import {
  allSatisfactionStars,
  fieldError,
  expectRelatedStatus,
  fillEntryForm,
  satisfactionApiItems,
  saveEntry,
} from './support/entry.ts';
import { hoursAgo, seed, shot } from './support/viewpoint-scenarios.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { locatorOf, userLabelText } from './support/pages.ts';

const rows = locatorOf('entry-row');
const auditRows = (page: Page) => page.getByTestId('audit-row');
const notice = locatorOf('entries-notice');
/** 修正・削除の結果の見出し（「修正しました」「削除しました」。評価の更新の表示は、その下。D-27）。 */
const noticeTitle = (page: Page) => notice(page).getByRole('heading');
const editor = (page: Page) => page.getByTestId('entry-edit');

async function openList(
  page: Page,
  query = '',
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/data-entry/list${query}`, user);
  await expect(page.getByRole('heading', { name: '入力済みデータ', level: 1 })).toBeVisible();
}

async function openHistory(
  page: Page,
  query = '',
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/data-entry/history${query}`, user);
  await expect(page.getByRole('heading', { name: '変更履歴', level: 1 })).toBeVisible();
}

/** 日時の列（先頭の列）の表示を、行の順に返す。 */
async function column(rowsLocator: ReturnType<typeof rows>, index: number): Promise<string[]> {
  return rowsLocator.evaluateAll(
    (nodes, position) =>
      nodes.map((node) => node.querySelectorAll('td').item(position).textContent.trim()),
    index,
  );
}

/** 検索・絞り込み・並べ替えの確認用に、設備・カテゴリ・時刻・入力者が異なる入力を3件用意する。 */
async function prepareThree(request: Parameters<typeof prepareApp>[0]): Promise<void> {
  // 入力A: ロボット / 故障情報 / 3時間前 / 備考あり（E2E ユーザー）
  await addEntry(request, {
    category: 'FAILURE',
    observedAt: hoursAgo(3),
    items: { failureCount: 2, recoveryMinutes: 90 },
    note: 'ケーブルの接触不良を交換した',
  });
  // 入力B: センサー / 環境情報 / 2時間前
  await addEntry(request, {
    equipmentId: SENSOR_ID,
    category: 'ENVIRONMENT',
    observedAt: hoursAgo(2),
    items: { temperatureCelsius: 22.5, humidityPercent: 55 },
  });
  // 入力C: ハウス / 満足度情報 / 1時間前
  await addEntry(request, {
    equipmentId: HOUSE_ID,
    category: 'SATISFACTION',
    observedAt: hoursAgo(1),
    items: satisfactionApiItems(3, { safety: 4 }),
  });
}

test.describe('基本フロー: 入力済みデータの一覧を開く', () => {
  test('入力済みデータを、計測日時の新しい順に、計測日時・設備・カテゴリ・入力項目と値（単位つき）・入力者・備考で一覧表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await prepareThree(request);

    await openList(page);

    // メニューの現在地: 入力データ一覧（/data-entry/list）でも、「データ入力」を強調する（Issue #155 の SC-COM-4）
    await expect(
      page.getByRole('navigation', { name: 'メニュー' }).locator('[aria-current="page"]'),
    ).toHaveText(['データ入力']);
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '計測日時',
      '設備',
      'カテゴリ',
      '入力項目と値',
      '入力者',
      '備考',
      '操作',
    ]);
    // 新しい順: ハウス（1時間前）→ センサー（2時間前）→ ロボット（3時間前）
    await expect
      .poll(() => column(rows(page), 1))
      .toEqual(['ハウス1', '環境センサー1', '収穫ロボット1']);
    await expect(rows(page).nth(2)).toContainText('故障情報');
    await expect(rows(page).nth(2)).toContainText('故障回数: 2回');
    await expect(rows(page).nth(2)).toContainText('復旧に要した時間: 90分');
    // 入力者は、「ユーザー名（ID）」（SC-07-7）
    await expect(rows(page).nth(2)).toContainText(userLabelText(E2E_USER));
    expect((await column(rows(page), 4))[2]).toBe('E2Eテスト用ユーザー（e2e-user）');
    await expect(rows(page).nth(2)).toContainText('ケーブルの接触不良を交換した');
    await expect(rows(page).nth(1)).toContainText('温度: 22.5℃');
    await expect(rows(page).nth(0)).toContainText('満足度（安全性）: 4スター');
    // 備考なしは「—」
    expect((await column(rows(page), 5))[0]).toBe('—');
    await shot(page, testInfo, 'uc18-list');
  });

  test('入力済みのデータがなければ、その旨と、データ入力への導線を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openList(page);

    await expect(page.getByTestId('entries-empty')).toContainText('入力済みのデータはありません');
    await expect(
      page.getByTestId('entries-empty').getByRole('link', { name: 'データ入力へ' }),
    ).toHaveAttribute('href', '/data-entry');
  });
});

test.describe('基本フロー 2: 検索（キーワード）・絞り込み（カテゴリ・設備・期間）・並べ替え', () => {
  const keywords: readonly { name: string; keyword: string; expected: string[] }[] = [
    { name: '項目名（復旧に要した時間）', keyword: '復旧に要', expected: ['収穫ロボット1'] },
    { name: '値と単位（22.5℃）', keyword: '22.5℃', expected: ['環境センサー1'] },
    { name: '値（90）', keyword: '90', expected: ['収穫ロボット1'] },
    { name: '備考（ケーブル）', keyword: 'ケーブル', expected: ['収穫ロボット1'] },
    {
      name: '入力者（e2e-user。大文字小文字を区別しない）',
      keyword: 'E2E-USER',
      expected: ['ハウス1', '環境センサー1', '収穫ロボット1'],
    },
    { name: '設備名（センサー）', keyword: 'センサー', expected: ['環境センサー1'] },
    { name: 'カテゴリ名（満足度）', keyword: '満足度', expected: ['ハウス1'] },
    { name: '該当なし', keyword: 'zzzz', expected: [] },
  ];

  for (const item of keywords) {
    test(`キーワード検索: ${item.name}`, async ({ page, request }) => {
      await prepareApp(request);
      await prepareThree(request);
      await openList(page);

      await page.getByLabel('キーワード').fill(item.keyword);

      await expect(rows(page)).toHaveCount(item.expected.length);
      await expect.poll(() => column(rows(page), 1)).toEqual(item.expected);
      if (item.expected.length === 0) {
        await expect(page.getByTestId('entries-empty')).toHaveText('該当するデータがありません');
      }
      await expect(page).toHaveURL(new RegExp(`q=`));
    });
  }

  test('カテゴリ・設備で絞り込める（組み合わせも可）', async ({ page, request }) => {
    await prepareApp(request);
    await prepareThree(request);
    await openList(page);

    await page.getByLabel('カテゴリ').selectOption('ENVIRONMENT');
    await expect.poll(() => column(rows(page), 1)).toEqual(['環境センサー1']);
    await page.getByLabel('カテゴリ').selectOption('');
    await page.getByLabel('設備', { exact: true }).selectOption(ROBOT_ID);
    await expect.poll(() => column(rows(page), 1)).toEqual(['収穫ロボット1']);
    await page.getByLabel('カテゴリ').selectOption('SATISFACTION');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('entries-empty')).toHaveText('該当するデータがありません');
  });

  test('計測日時の期間（日本時間の日付。開始日・終了日を含む）で絞り込める', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 日本時間: 10/08 23:59、10/09 00:00、10/09 12:00（現在）、10/09 23:59、10/10 00:00
    for (const [iso, value] of [
      ['2026-10-08T14:59:00.000Z', 1],
      ['2026-10-08T15:00:00.000Z', 2],
      ['2026-10-09T02:00:00.000Z', 3],
    ] as const) {
      await addEntry(request, {
        category: 'SAFETY',
        observedAt: iso,
        items: { emergencyStopCount: value },
      });
    }
    await openList(page);
    await expect(rows(page)).toHaveCount(3);

    await page.getByLabel('期間（開始日）').fill('2026-10-09');
    await expect(rows(page)).toHaveCount(2);
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(rows(page)).toHaveCount(0);
    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('緊急停止回数: 1回');
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(rows(page)).toHaveCount(3);
    await page.getByLabel('期間（開始日）').fill('');
    await page.getByLabel('期間（終了日）').fill('');
    await expect(rows(page)).toHaveCount(3);
  });

  const sorts: readonly { name: string; sort: string; direction: string; expected: string[] }[] = [
    {
      name: '計測日時の新しい順（既定）',
      sort: 'observedAt',
      direction: 'desc',
      expected: ['ハウス1', '環境センサー1', '収穫ロボット1'],
    },
    {
      name: '計測日時の古い順',
      sort: 'observedAt',
      direction: 'asc',
      expected: ['収穫ロボット1', '環境センサー1', 'ハウス1'],
    },
    {
      name: 'カテゴリの昇順',
      sort: 'category',
      direction: 'asc',
      expected: ['環境センサー1', '収穫ロボット1', 'ハウス1'],
    },
    {
      name: 'カテゴリの降順',
      sort: 'category',
      direction: 'desc',
      expected: ['ハウス1', '収穫ロボット1', '環境センサー1'],
    },
  ];

  for (const item of sorts) {
    test(`並べ替え: ${item.name}`, async ({ page, request }) => {
      await prepareApp(request);
      await prepareThree(request);
      await openList(page);
      if (item.name.includes('既定')) {
        // 何も選ばない状態が、計測日時の新しい順
        await expect(page.getByLabel('並べ替え', { exact: true })).toHaveValue('observedAt');
        await expect(page.getByLabel('並べ替えの向き')).toHaveValue('desc');
        await expect.poll(() => column(rows(page), 1)).toEqual(item.expected);
      }

      await page.getByLabel('並べ替え', { exact: true }).selectOption(item.sort);
      await page.getByLabel('並べ替えの向き').selectOption(item.direction);

      await expect.poll(() => column(rows(page), 1)).toEqual(item.expected);
    });
  }

  test('並べ替え: 入力者（昇順・降順）。同じ入力者は、計測日時の新しい順', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    // 入力者 e2e-user（2時間前）・e2e-user-b（1時間前・3時間前）
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(2),
      items: { emergencyStopCount: 1 },
    });
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: USER_B.userId, password: USER_B.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    for (const hours of [1, 3]) {
      await request.post('/api/v1/manual-entries', {
        headers: { authorization: `Bearer ${accessToken}` },
        data: {
          equipmentId: ROBOT_ID,
          category: 'SAFETY',
          observedAt: hoursAgo(hours),
          items: { emergencyStopCount: hours },
        },
      });
    }
    await openList(page);

    await page.getByLabel('並べ替え', { exact: true }).selectOption('enteredBy');
    await page.getByLabel('並べ替えの向き').selectOption('asc');
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual([
        'E2Eテスト用ユーザー（e2e-user）',
        'E2E利用者B（e2e-user-b）',
        'E2E利用者B（e2e-user-b）',
      ]);
    expect((await column(rows(page), 3)).slice(1)).toEqual([
      '緊急停止回数: 1回',
      '緊急停止回数: 3回',
    ]);
    await page.getByLabel('並べ替えの向き').selectOption('desc');
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual([
        'E2E利用者B（e2e-user-b）',
        'E2E利用者B（e2e-user-b）',
        'E2Eテスト用ユーザー（e2e-user）',
      ]);
  });

  test('設備の絞り込みは、ハウスの下にロボット・センサーを字下げし、種別を付ける。ハウスを選ぶと、配下のロボット・センサーの入力も含める（SC-07-8）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await prepareThree(request);
    await openList(page);

    await expect(page.getByLabel('設備', { exact: true }).locator('option')).toHaveText([
      'すべて',
      'ハウス1',
      '　収穫ロボット1（ロボット）',
      '　環境センサー1（センサー）',
    ]);
    await page.getByLabel('設備', { exact: true }).selectOption(ROBOT_ID);
    await expect.poll(() => column(rows(page), 1)).toEqual(['収穫ロボット1']);
    // ハウスを選ぶと、ハウス自身と、配下のロボット・センサーの入力を、まとめて表示する（計測データ〔SC-09〕と同じ）
    await page.getByLabel('設備', { exact: true }).selectOption(HOUSE_ID);
    await expect(rows(page)).toHaveCount(3);
    await expect
      .poll(() => column(rows(page), 1))
      .toEqual(['ハウス1', '環境センサー1', '収穫ロボット1']);
  });

  test('キーワードが一致する項目（設備名・カテゴリ・入力者・備考・入力項目の名称と値）を、説明文に示す（SC-07-8）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openList(page);

    await expect(page.getByTestId('entries-keyword-note')).toHaveText(
      'キーワードは、設備名・カテゴリ・入力者・備考・入力項目の名称と値から探します',
    );
  });

  test('適用中の条件の数を示し、条件のクリアで、絞り込み・並べ替えをすべて初期値に戻す（SC-07-3）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await prepareThree(request);
    await openList(page);
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '条件のクリア' })).toBeDisabled();

    await page.getByLabel('キーワード').fill('ケーブル');
    await page.getByLabel('カテゴリ').selectOption('FAILURE');
    await page.getByLabel('並べ替えの向き').selectOption('asc');

    await expect(page.getByTestId('filter-active-count')).toHaveText('適用中の条件 3 件');
    await expect(rows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/q=/);

    await page.getByRole('button', { name: '条件のクリア' }).click();

    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByLabel('キーワード')).toHaveValue('');
    await expect(page.getByLabel('カテゴリ')).toHaveValue('');
    await expect(page.getByLabel('並べ替えの向き')).toHaveValue('desc');
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '条件のクリア' })).toBeDisabled();
    await expect(page).not.toHaveURL(/q=|category=|direction=/);
    // 計測日時の新しい順（初期値）に戻っている
    await expect
      .poll(() => column(rows(page), 1))
      .toEqual(['ハウス1', '環境センサー1', '収穫ロボット1']);
  });

  test('絞り込み・並べ替えの条件は URL に反映され、再読み込みしても保持される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await prepareThree(request);
    await openList(page, '?category=FAILURE&sort=category&direction=asc');

    await expect(page.getByLabel('カテゴリ')).toHaveValue('FAILURE');
    await expect(page.getByLabel('並べ替え', { exact: true })).toHaveValue('category');
    await expect(page.getByLabel('並べ替えの向き')).toHaveValue('asc');
    await expect(rows(page)).toHaveCount(1);
    await page.reload();
    await expect(page.getByLabel('カテゴリ')).toHaveValue('FAILURE');
    await expect(rows(page)).toHaveCount(1);
    // 画面で条件を変えると、URL に反映される
    await page.getByLabel('並べ替えの向き').selectOption('desc');
    await expect(page).toHaveURL(/direction=desc/);
    await page.getByLabel('カテゴリ').selectOption('SAFETY');
    await expect(page).toHaveURL(/category=SAFETY/);
  });

  test('21件の入力は、1ページ目に20件、2ページ目に1件を表示する。条件を変えると、先頭のページへ戻る', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    for (let index = 0; index < 21; index += 1) {
      await addEntry(request, {
        category: 'SAFETY',
        observedAt: hoursAgo(22 - index),
        items: { emergencyStopCount: index },
      });
    }
    await openList(page);
    await expect(rows(page)).toHaveCount(20);
    await expect(page.getByRole('button', { name: '前へ' })).toBeDisabled();

    await expect(page.getByTestId('pager-range')).toHaveText('1〜20 件目');

    await page.getByRole('button', { name: '次へ' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByTestId('pager-range')).toHaveText('21〜21 件目');
    await expect(rows(page).first()).toContainText('緊急停止回数: 0回');
    await page.getByLabel('並べ替えの向き').selectOption('asc');

    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(rows(page)).toHaveCount(20);
  });
});

test.describe('基本フロー 3〜4: データを修正または削除し、検証して保存する', () => {
  test('修正は、ダイアログで行う（SC-07-2）。最初の入力欄にフォーカスがあり、Esc・✕・キャンセルで閉じて、「修正」のボタンへフォーカスが戻る。表の上のパネルは出ない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 1 },
    });
    await openList(page);
    const opener = rows(page).first().getByRole('button', { name: '修正' });

    await opener.click();

    const dialog = page.getByRole('dialog', { name: '入力内容の修正' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-testid', 'entry-edit');
    await expect(dialog).toBeInViewport();
    await expect(dialog.getByLabel('対象の設備')).toBeFocused();
    await expect(page.locator('body')).toHaveClass(/modal-open/);
    // 表の上のインラインのパネルではない（ダイアログの外の、画面の中には、修正のフォームがない）
    await expect(page.locator('section.panel form.entry-form')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator('body')).not.toHaveClass(/modal-open/);

    await opener.click();
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(notice(page)).toHaveCount(0);
  });

  test('修正の後も、評価の更新（ローカル: 関連する観点のステータス）を示す（D-27）。修正前の MTTR 10 時間（異常）→ 修正後 1.5 時間（正常）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // メンテナンス性の評価に使う、取り込み済みのステータス（UC-06 と同じ）
    await seed(request, {
      observations: [
        { equipmentId: ROBOT_ID, itemKey: 'statusCode', value: 'STANDBY', observedAt: hoursAgo(2) },
      ],
    });
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(1),
      items: { failureCount: 1, recoveryMinutes: 600 },
    });
    await openList(page);
    await rows(page).first().getByRole('button', { name: '修正' }).click();
    await fillEntryForm(page, { items: { 復旧に要した時間: '90' } }, editor(page));

    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(noticeTitle(page)).toHaveText('修正しました');
    await expect(notice(page)).toContainText('入力内容を修正し、評価を更新しました');
    await expectRelatedStatus(page, 'maintainability', '正常');
    // 一覧の画面なので、一覧へのリンクは出さない。ダッシュボードで確認できる
    await expect(notice(page).getByRole('link', { name: '入力済みデータの一覧へ' })).toHaveCount(0);
    await expect(notice(page).getByRole('link', { name: 'ダッシュボードで確認' })).toBeVisible();
    await shot(page, testInfo, 'uc18-edited-result');
  });

  test('修正の後も、自動取り込みの値がある期間の合計の項目（収穫数）は、評価に使われない旨を、データ入力と同じ部品で示す（D-26。Issue #162 の SC-06-5）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1800, observedAt: hoursAgo(4) },
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 2400, observedAt: hoursAgo(2) },
      ],
    });
    await addEntry(request, {
      category: 'HARVEST',
      observedAt: hoursAgo(1),
      items: { harvestCount: 1700 },
    });
    await openList(page);
    await rows(page).first().getByRole('button', { name: '修正' }).click();
    await editor(page)
      .locator('[data-field="items.harvestCount"]')
      .getByRole('textbox')
      .fill('1750');

    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(noticeTitle(page)).toHaveText('修正しました');
    await expect(notice(page).getByTestId('usage-harvestCount')).toHaveText(
      '収穫数: この期間は自動取り込みの値を使うため、この入力は評価に使われません',
    );
  });

  test('修正: 入力済みの内容（設備・カテゴリ・計測日時・項目の値・備考）を編集欄に表示し、変更して保存すると、一覧と評価に反映される（入力者は変わらない）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { failureCount: 1, recoveryMinutes: 600 },
      note: '最初の記録',
    });
    await openList(page);

    await rows(page).first().getByRole('button', { name: '修正' }).click();
    await expect(editor(page)).toContainText('入力内容の修正');
    await expect(editor(page).getByLabel('対象の設備')).toHaveValue(ROBOT_ID);
    await expect(editor(page).getByLabel('カテゴリ')).toHaveValue('FAILURE');
    await expect(editor(page).getByLabel('計測日時（日本時間）')).toHaveValue('2026-10-09T11:00');
    await expect(
      editor(page).getByTestId('entry-items').getByRole('textbox', { name: '復旧に要した時間' }),
    ).toHaveValue('600');
    await expect(editor(page).getByLabel('備考（所感・補足情報）')).toHaveValue('最初の記録');
    await shot(page, testInfo, 'uc18-edit');
    await fillEntryForm(
      page,
      { items: { 復旧に要した時間: '90' }, note: '訂正: 復旧は 90 分だった' },
      editor(page),
    );
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(noticeTitle(page)).toHaveText('修正しました');
    await expect(editor(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc18-edited');
    await expect(rows(page).first()).toContainText('復旧に要した時間: 90分');
    await expect(rows(page).first()).toContainText('訂正: 復旧は 90 分だった');
    await expect(rows(page).first()).toContainText(userLabelText(E2E_USER));
    // 評価に反映される（MTTR 1.5 時間 = 正常。以前は 10 時間 = 異常）
    await page.goto('/viewpoints/maintainability?equipmentId=ROBOT-01');
    await expect(
      page.getByTestId('metric-period-mttrHours').locator('.metric-cell-value'),
    ).toHaveText('1.50時間');
  });

  test('修正: 設備・カテゴリ・計測日時を変更できる（項目の値は、変更後のカテゴリの項目を入力する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 1 },
    });
    await openList(page);
    await rows(page).first().getByRole('button', { name: '修正' }).click();

    await fillEntryForm(
      page,
      {
        equipment: HOUSE_ID,
        category: 'SATISFACTION',
        observedAt: '2026-10-09T10:30',
        stars: allSatisfactionStars(3, { '満足度（収穫精度）': 5 }),
      },
      editor(page),
    );
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(noticeTitle(page)).toHaveText('修正しました');
    await expect(rows(page).first()).toContainText('ハウス1');
    await expect(rows(page).first()).toContainText('満足度情報');
    await expect(rows(page).first()).toContainText('満足度（収穫精度）: 5スター');
    await expect(rows(page).first()).toContainText('2026/10/09 10:30:00');
  });

  test('修正の入力が不正な場合は、UC-06 と同様に、エラーを表示し、保存しない。キャンセルで、修正をやめられる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(1),
      items: { failureCount: 1, recoveryMinutes: 30 },
    });
    await openList(page);
    await rows(page).first().getByRole('button', { name: '修正' }).click();

    await fillEntryForm(
      page,
      { items: { 故障回数: '-1', 復旧に要した時間: 'abc' }, observedAt: '2026-10-09T12:30' },
      editor(page),
    );
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(fieldError(page, 'items.failureCount', editor(page))).toHaveText(
      '故障回数は0以上の整数で指定してください',
    );
    await expect(fieldError(page, 'items.recoveryMinutes', editor(page))).toHaveText(
      '復旧に要した時間は0以上の数値で指定してください',
    );
    await expect(fieldError(page, 'observedAt', editor(page))).toHaveText(
      '計測日時に未来の日時は指定できません',
    );
    await expect(notice(page)).toHaveCount(0);
    await editor(page).getByRole('button', { name: 'キャンセル' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(rows(page).first()).toContainText('故障回数: 1回');
  });

  test('修正で、ほかの入力と同じ設備・項目・計測日時になると、サーバーが拒否し、その旨を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: '2026-10-09T01:00:00.000Z',
      items: { emergencyStopCount: 1 },
    });
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { emergencyStopCount: 2 },
    });
    await openList(page);
    await rows(page).first().getByRole('button', { name: '修正' }).click();

    await fillEntryForm(page, { observedAt: '2026-10-09T10:00' }, editor(page));
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(editor(page).getByRole('alert').first()).toContainText(
      '同じ計測日時の入力がすでにあります',
    );
    await expect(notice(page)).toHaveCount(0);
  });

  test('削除: 確認を求め（取り消せる）、削除すると、論理削除として、一覧・計測データから除外される。変更履歴には、削除前の内容が残る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 1, nearMissCount: 0 },
    });
    await openList(page);

    await rows(page).first().getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('入力データを削除しますか');
    await expect(page.getByTestId('confirm-dialog')).toContainText('一覧と集計の対象から外れます');
    // 対象（計測日時・設備名・項目と値）を示し、元に戻す操作がないことを明記する（#153）
    await expect(page.getByTestId('confirm-dialog')).toContainText('収穫ロボット1');
    await expect(page.getByTestId('confirm-dialog')).toContainText('緊急停止回数: 1回');
    await expect(page.getByTestId('confirm-dialog')).toContainText(
      '元に戻す操作はありません（変更履歴には残ります）',
    );
    await shot(page, testInfo, 'uc18-confirm');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');

    await expect(noticeTitle(page)).toHaveText('削除しました');
    // 削除の後も、評価の更新（ローカル: 関連する観点のステータス）を示す（D-27）
    await expect(notice(page)).toContainText('入力内容を削除し、評価を更新しました');
    await expect(notice(page).getByTestId('related-safety')).toBeVisible();
    await shot(page, testInfo, 'uc18-deleted');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('entries-empty')).toBeVisible();
    await page.goto('/observations');
    await expect(page.getByTestId('observations-empty')).toBeVisible();
    // 論理削除: 変更履歴には、削除前の内容が残る
    await page.goto('/data-entry/history?operation=DELETE');
    await expect(auditRows(page)).toHaveCount(1);
    await expect(auditRows(page).first()).toContainText('緊急停止回数');
  });

  test('削除すると、評価を更新し、集計から外れる（削除したデータの項目は、観点の詳細のメトリクスで「—」になる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(1),
      items: { failureCount: 1, recoveryMinutes: 600 },
    });
    await openList(page);

    await rows(page).first().getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(noticeTitle(page)).toHaveText('削除しました');

    await page.goto('/viewpoints/maintainability?equipmentId=ROBOT-01');
    await expect(
      page.getByTestId('metric-period-failureCount').locator('.metric-cell-value'),
    ).toHaveText('—');
  });
});

test.describe('基本フロー 5: 変更の履歴を参照する（操作種別・変更者・期間で絞り込み）', () => {
  /** 登録（A）→ 修正（A）→ 登録（B）→ 削除（B）の4件の履歴を作る。時刻は、1分ずつ進める。 */
  async function prepareHistory(request: Parameters<typeof prepareApp>[0]): Promise<void> {
    await addUser(request, USER_B);
    const first = await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(3),
      items: { emergencyStopCount: 1 },
    });
    await apiAdvance(request);
    await api(request, 'PUT', `/manual-entries/${first.entry.entryId}`, {
      equipmentId: ROBOT_ID,
      category: 'SAFETY',
      observedAt: hoursAgo(3),
      items: { emergencyStopCount: 2 },
    });
    await apiAdvance(request);
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: USER_B.userId, password: USER_B.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const created = await request.post('/api/v1/manual-entries', {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        equipmentId: ROBOT_ID,
        category: 'SAFETY',
        observedAt: hoursAgo(2),
        items: { nearMissCount: 1 },
      },
    });
    const { entry } = (await created.json()) as { entry: { entryId: string } };
    await apiAdvance(request);
    await request.delete(`/api/v1/manual-entries/${entry.entryId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async function apiAdvance(request: Parameters<typeof prepareApp>[0]): Promise<void> {
    await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
  }

  test('履歴を、新しい順に、日時・操作種別・対象・変更者・変更前・変更後で一覧表示する（修正は、前後の値を並べる）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await prepareHistory(request);

    await openHistory(page, '?targetType=manual-entry');

    // メニューの現在地: 変更履歴（/data-entry/history）でも、「データ入力」を強調する（Issue #155 の SC-COM-4）
    await expect(
      page.getByRole('navigation', { name: 'メニュー' }).locator('[aria-current="page"]'),
    ).toHaveText(['データ入力']);
    await expect(auditRows(page)).toHaveCount(4);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '日時',
      '操作種別',
      '対象データ',
      '変更者',
      '変更前',
      '変更後',
    ]);
    await expect(auditRows(page).nth(0)).toContainText('削除');
    // 変更者は、「ユーザー名（ID）」（SC-07-7）
    await expect(auditRows(page).nth(0)).toContainText(userLabelText(USER_B));
    expect((await column(auditRows(page), 3))[0]).toBe('E2E利用者B（e2e-user-b）');
    await expect(auditRows(page).nth(0)).toContainText('ヒヤリハット件数: 1件');
    await expect(auditRows(page).nth(1)).toContainText('登録');
    await expect(auditRows(page).nth(2)).toContainText('編集');
    await expect(auditRows(page).nth(2)).toContainText('緊急停止回数: 1回');
    await expect(auditRows(page).nth(2)).toContainText('緊急停止回数: 2回');
    // 変更前・変更後の列で、前後の値を区別する
    await expect(auditRows(page).nth(2).locator('td').nth(4)).toContainText('緊急停止回数: 1回');
    await expect(auditRows(page).nth(2).locator('td').nth(5)).toContainText('緊急停止回数: 2回');
    await expect(auditRows(page).nth(3)).toContainText('登録');
    await expect(auditRows(page).nth(3)).toContainText('手動入力');
    await shot(page, testInfo, 'uc18-history');
  });

  const filters: readonly { name: string; query: string; expected: string[] }[] = [
    { name: '操作種別: 登録', query: '?operation=CREATE', expected: ['登録', '登録'] },
    { name: '操作種別: 編集', query: '?operation=UPDATE', expected: ['編集'] },
    { name: '操作種別: 削除', query: '?operation=DELETE', expected: ['削除'] },
    { name: '変更者: e2e-user', query: '?actor=e2e-user', expected: ['編集', '登録'] },
    { name: '変更者: e2e-user-b', query: '?actor=e2e-user-b', expected: ['削除', '登録'] },
    { name: '変更者（該当なし）', query: '?actor=nobody', expected: [] },
    {
      name: '対象: 手動入力',
      query: '?targetType=manual-entry',
      expected: ['削除', '登録', '編集', '登録'],
    },
    { name: '対象: 判断基準（該当なし）', query: '?targetType=criteria', expected: [] },
    { name: '操作種別 × 変更者', query: '?operation=CREATE&actor=e2e-user-b', expected: ['登録'] },
  ];

  for (const item of filters) {
    test(`絞り込み: ${item.name}`, async ({ page, request }) => {
      await prepareApp(request);
      await prepareHistory(request);

      // ユーザーの登録なども、履歴に残るため、手動入力の履歴に限定して確認する
      await openHistory(
        page,
        item.query.includes('targetType') ? item.query : `${item.query}&targetType=manual-entry`,
      );

      await expect(auditRows(page)).toHaveCount(item.expected.length);
      const operations = await auditRows(page).evaluateAll((nodes) =>
        nodes.map((node) => node.querySelectorAll('td').item(1).textContent.trim()),
      );
      expect(operations).toEqual(item.expected);
      if (item.expected.length === 0) {
        await expect(page.getByTestId('audit-empty')).toHaveText('該当する履歴はありません');
      }
    });
  }

  test('期間（日本時間の日付）・並べ替え（新しい順・古い順）で絞り込める。条件は画面で変更でき、URL に反映される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await prepareHistory(request);
    await openHistory(page, '?targetType=manual-entry');

    await page.getByLabel('並べ替え', { exact: true }).selectOption('asc');
    expect(
      await auditRows(page).evaluateAll((nodes) =>
        nodes.map((node) => node.querySelectorAll('td').item(1).textContent.trim()),
      ),
    ).toEqual(['登録', '編集', '登録', '削除']);
    await page.getByLabel('期間（開始日）').fill('2026-10-10');
    await expect(auditRows(page)).toHaveCount(0);
    await page.getByLabel('期間（開始日）').fill('2026-10-09');
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(auditRows(page)).toHaveCount(0);
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(auditRows(page)).toHaveCount(4);
    await page.getByLabel('操作種別').selectOption('DELETE');
    await page.getByLabel('変更者').fill('e2e-user-b');
    await expect(auditRows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/operation=DELETE/);
    await expect(page).toHaveURL(/actor=e2e-user-b/);
    await page.reload();
    await expect(page.getByLabel('操作種別')).toHaveValue('DELETE');
    await expect(auditRows(page)).toHaveCount(1);
  });

  test('適用中の条件の数を示し、条件のクリアで、絞り込み・並べ替えをすべて初期値に戻す（SC-07-3）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await prepareHistory(request);
    await openHistory(page, '?targetType=manual-entry&operation=DELETE&direction=asc');

    await expect(page.getByTestId('filter-active-count')).toHaveText('適用中の条件 3 件');
    await expect(auditRows(page)).toHaveCount(1);

    await page.getByRole('button', { name: '条件のクリア' }).click();

    await expect(page.getByLabel('操作種別')).toHaveValue('');
    await expect(page.getByLabel('対象', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('並べ替え', { exact: true })).toHaveValue('desc');
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page).not.toHaveURL(/targetType=|operation=|direction=/);
    // 手動入力以外の履歴（ユーザーの登録など）も、一覧に戻る
    await expect(auditRows(page)).not.toHaveCount(1);
  });

  test('21件の履歴は、1ページ目に20件、2ページ目に1件を表示する', async ({ page, request }) => {
    await prepareApp(request);
    for (let index = 0; index < 21; index += 1) {
      await addEntry(request, {
        category: 'SAFETY',
        observedAt: hoursAgo(22 - index),
        items: { emergencyStopCount: index },
      });
    }
    await openHistory(page);
    await expect(auditRows(page)).toHaveCount(20);
    await expect(page.getByTestId('pager-range')).toHaveText('1〜20 件目');

    await page.getByRole('button', { name: '次へ' }).click();

    await expect(auditRows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByTestId('pager-range')).toHaveText('21〜21 件目');
  });

  test('手動入力以外の変更（設備・ステータスコード）の履歴は、内容を開いて確認できる（対象の種類で絞り込める）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await api(request, 'PUT', '/status-codes/STANDBY', {
      name: '待機（変更）',
      category: 'NORMAL',
    });
    await api(request, 'PUT', `/equipment/${ROBOT_ID}`, { name: '改名ロボット' });
    await openHistory(page, '?targetType=status-code');

    await expect(auditRows(page)).toHaveCount(1);
    await expect(auditRows(page).first()).toContainText('ステータスコード');
    await expect(auditRows(page).first()).toContainText('STANDBY');
    await auditRows(page).first().locator('summary').nth(1).click();
    // 変更後の列（変更後の内容。項目ごとの区切りに分かれる。Issue #190）
    await expect(
      auditRows(page)
        .first()
        .locator('td')
        .nth(5)
        .locator('pre')
        .filter({ hasText: '待機（変更）' }),
    ).toBeVisible();
    await page.getByLabel('対象', { exact: true }).selectOption('equipment');
    await expect(auditRows(page).first()).toContainText('設備');
  });
});

test.describe('シナリオ: 利用者Aが入力し、利用者Bが修正し、履歴で確認する（UC-06 → UC-18。複数ユーザー）', () => {
  test('入力者は修正しても変わらず、履歴に登録（A）・編集（B）が記録され、Aは、Bによる修正後の内容を、一覧で確認できる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    // 利用者A: 入力する（UI）
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, {
      equipment: ROBOT_ID,
      category: 'SAFETY',
      observedAt: '2026-10-09T11:00',
      items: { 緊急停止回数: '3' },
      note: 'Aが入力',
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();

    // 利用者B: 一覧で修正する（履歴は、日時の順に並ぶため、入力の1分後とする）
    await advanceMinutes(request, 1);
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/data-entry/list', USER_B);
    await expect(rows(b.page)).toHaveCount(1);
    await expect(rows(b.page).first()).toContainText(userLabelText(E2E_USER));
    await rows(b.page).first().getByRole('button', { name: '修正' }).click();
    await fillEntryForm(b.page, { items: { 緊急停止回数: '1' }, note: 'Bが訂正' }, editor(b.page));
    await editor(b.page).getByRole('button', { name: '保存', exact: true }).click();
    await expect(noticeTitle(b.page)).toHaveText('修正しました');
    await shot(b.page, testInfo, 'uc18-user-b-edited');

    // 利用者A: 修正後の内容を確認する（入力者は、Aのまま）
    await page.goto('/data-entry/list');
    await expect(rows(page).first()).toContainText('緊急停止回数: 1回');
    await expect(rows(page).first()).toContainText('Bが訂正');
    await expect(rows(page).first()).toContainText(userLabelText(E2E_USER));
    await expect(rows(page).first()).not.toContainText('e2e-user-b');
    await expect(rows(page).first()).not.toContainText(USER_B.userName);
    // 履歴: 登録（A）→ 編集（B）
    await page.goto('/data-entry/history?targetType=manual-entry');
    await expect(auditRows(page)).toHaveCount(2);
    await expect(auditRows(page).nth(0)).toContainText('編集');
    await expect(auditRows(page).nth(0)).toContainText(userLabelText(USER_B));
    await expect(auditRows(page).nth(0)).toContainText('緊急停止回数: 3回');
    await expect(auditRows(page).nth(0)).toContainText('緊急停止回数: 1回');
    await expect(auditRows(page).nth(1)).toContainText('登録');
    await expect(auditRows(page).nth(1)).toContainText(userLabelText(E2E_USER));
    await b.context.close();
  });
});

test.describe('変更履歴への導線（#155。SC-07-10・SC-08-4）', () => {
  test('一覧の各行の「履歴」から、その入力だけの変更履歴を開く。チップ「対象: …」で示し、解除すると、同じ種類の全体に戻る。対象を絞った表示は、「更新」で取り直す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const target = await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(3),
      items: { failureCount: 2, recoveryMinutes: 90 },
    });
    await addEntry(request, {
      equipmentId: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: hoursAgo(2),
      items: { temperatureCelsius: 22.5, humidityPercent: 55 },
    });
    const edit = async (failureCount: number): Promise<void> => {
      await advanceMinutes(request, 1);
      await apiOk(request, 'PUT', `/manual-entries/${target.entry.entryId}`, {
        equipmentId: ROBOT_ID,
        category: 'FAILURE',
        observedAt: hoursAgo(3),
        items: { failureCount, recoveryMinutes: 90 },
      });
    };
    await edit(3);

    await openList(page);
    await rows(page).filter({ hasText: '故障回数' }).getByRole('link', { name: '履歴' }).click();

    // その入力（登録・編集の 2 件）だけが出る。センサーの入力の履歴は出ない
    await expect
      .poll(() => page.url())
      .toContain(`/data-entry/history?targetType=manual-entry&targetId=${target.entry.entryId}`);
    await expect(auditRows(page)).toHaveCount(2);
    const chip = page.getByTestId('audit-target-chip');
    await expect(chip).toContainText('対象: 手動入力');
    await expect(chip).toContainText('収穫ロボット1');
    await expect(chip).toContainText('故障回数');
    await expect(page.getByLabel('対象の ID')).toHaveCount(0);
    await shot(page, testInfo, 'uc18-history-target-chip');

    // 対象を絞った表示は、自動では更新せず、「更新」で取り直す
    await edit(4);
    await expect(auditRows(page)).toHaveCount(2);
    await page.getByRole('button', { name: '更新' }).click();
    await expect(auditRows(page)).toHaveCount(3);

    // 解除すると、対象の種類（手動入力）の全体（この入力の 3 件と、センサーの入力の 1 件）に戻る
    await chip.getByRole('button', { name: /解除/ }).click();
    await expect(chip).toHaveCount(0);
    await expect(page).toHaveURL(/targetType=manual-entry/);
    await expect(page).not.toHaveURL(/targetId=/);
    await expect(auditRows(page)).toHaveCount(4);
    await expect(page.getByRole('button', { name: '更新' })).toHaveCount(0);
  });

  test('対象の ID が、別の入力の ID のとき（該当なし）は、履歴がない旨を示す。条件のクリアで、対象も外れる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(3),
      items: { failureCount: 2, recoveryMinutes: 90 },
    });

    await openHistory(page, '?targetType=manual-entry&targetId=no-such-entry');

    await expect(page.getByTestId('audit-empty')).toHaveText('該当する履歴はありません');
    await expect(page.getByTestId('audit-target-chip')).toContainText('対象: 手動入力');
    await page.getByRole('button', { name: '条件のクリア' }).click();
    await expect(page.getByTestId('audit-target-chip')).toHaveCount(0);
    await expect(auditRows(page).first()).toBeVisible();
  });
});

test.describe('権限: 変更する権限・履歴を参照する権限のない利用者（閲覧者）', () => {
  test('閲覧者は、一覧を参照でき、修正・削除の操作と、変更履歴へのリンクを表示しない。変更履歴を直接開いても、権限がない旨を表示する。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const created = await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 1 },
    });
    await addUser(request, VIEWER);

    await openList(page, '', VIEWER);

    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
    await expect(rows(page).first().getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '変更履歴を見る' })).toHaveCount(0);
    // 行の「履歴」も示さない（変更履歴の権限がない）
    await expect(page.getByRole('link', { name: '履歴', exact: true })).toHaveCount(0);
    await page.goto('/data-entry/history');
    await expect(page.getByTestId('permission-notice')).toHaveText(
      '変更履歴を参照する権限がありません',
    );
    await expect(auditRows(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc18-viewer-history');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/audit-logs', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(denied.status()).toBe(403);
    // 修正・削除も、サーバー側で拒否する
    const updateDenied = await request.fetch(`/api/v1/manual-entries/${created.entry.entryId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        equipmentId: ROBOT_ID,
        category: 'SAFETY',
        observedAt: hoursAgo(1),
        items: { emergencyStopCount: 2 },
      },
    });
    expect(updateDenied.status()).toBe(403);
    const deleteDenied = await request.fetch(`/api/v1/manual-entries/${created.entry.entryId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteDenied.status()).toBe(403);
  });
});

test.describe('入力者・変更者の表示名（Issue #154 の SC-07-7）', () => {
  test('入力者・変更者は、現在のユーザー名で「ユーザー名（ID）」と表示する。ユーザー名を変えると、過去の入力・履歴も新しい名前になる。削除した利用者は、ID だけ', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await addEntryAs(request, USER_B, {
      equipmentId: ROBOT_ID,
      category: 'SAFETY',
      observedAt: hoursAgo(2),
      items: { emergencyStopCount: 1 },
    });
    await addEntry(request, {
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 2 },
    });

    // 入力者・変更者は、「ユーザー名（ID）」（新しい順: A → B）
    await openList(page);
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual(['E2Eテスト用ユーザー（e2e-user）', 'E2E利用者B（e2e-user-b）']);
    await openHistory(page, '?targetType=manual-entry');
    await expect(auditRows(page).filter({ hasText: 'e2e-user-b' })).toContainText(
      'E2E利用者B（e2e-user-b）',
    );

    // Bが、ユーザー名を変える: 過去の入力・履歴も、現在のユーザー名で表示する（変更時点の名前は、保存しない）
    const rename = await request.put('/api/v1/auth/profile', {
      headers: { authorization: `Bearer ${await accessToken(request, USER_B)}` },
      data: { userName: 'E2E利用者B（改名後）' },
    });
    expect(rename.ok()).toBe(true);
    await openList(page);
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual(['E2Eテスト用ユーザー（e2e-user）', 'E2E利用者B（改名後）（e2e-user-b）']);
    await openHistory(page, '?targetType=manual-entry');
    await expect(auditRows(page).filter({ hasText: 'e2e-user-b' })).toContainText(
      'E2E利用者B（改名後）（e2e-user-b）',
    );

    // Bを削除する: 名前を引けないため、ID だけを表示する
    await apiOk(request, 'DELETE', `/users/${USER_B.userId}`);
    await openList(page);
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual(['E2Eテスト用ユーザー（e2e-user）', 'e2e-user-b']);
    await openHistory(page, '?targetType=manual-entry');
    expect(
      (await column(auditRows(page), 3)).filter((text) => text.includes('e2e-user-b')),
    ).toEqual(['e2e-user-b']);
  });
});

// 画面幅・長い値（最大長の備考2000文字・長い入力者）でも、表が潰れない（NFR-7.3）
const LONG_USER = {
  userId: `u${'a'.repeat(99)}`,
  userName: '長い名前の入力者',
  password: 'Dummy-Passw0rd-l1',
  role: 'admin',
} as const;
const LONG_NOTE_JAPANESE = '長い備考。'.repeat(400);
const LONG_NOTE_ASCII = 'x'.repeat(2000);

/** 利用者を指定して、入力を API で登録する。 */
async function addEntryAs(
  request: Parameters<typeof prepareApp>[0],
  user: { userId: string; password: string },
  data: Record<string, unknown>,
): Promise<void> {
  const login = await request.post('/api/v1/auth/login', {
    data: { userId: user.userId, password: user.password },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const created = await request.post('/api/v1/manual-entries', {
    headers: { authorization: `Bearer ${accessToken}` },
    data,
  });
  expect(created.status()).toBe(201);
}

/** 表が、列ごとに1文字幅へ潰れず（見出し・日時が1行）、ページが横にはみ出さないことを確認する。 */
async function expectTableNotCrushed(page: Page, table: string): Promise<void> {
  const headerHeights = await page
    .locator(`${table} thead th`)
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
  expect(Math.max(...headerHeights), `見出しの高さ ${String(headerHeights)}`).toBeLessThan(48);
  const timeHeights = await page
    .locator(`${table} tbody time`)
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(Math.max(...timeHeights), `日時の高さ ${String(timeHeights)}`).toBeLessThan(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** 表が、枠の中で横にスクロールせず、すべての列が見えることを確認する。 */
async function expectTableFits(page: Page): Promise<void> {
  const scroll = page.locator('.table-scroll');
  expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

/** 操作のボタン（修正・削除）が、表の枠の右端からはみ出さない。 */
async function expectButtonsInsideTable(page: Page): Promise<void> {
  const frame = await page.locator('.table-scroll').boundingBox();
  const right = (frame?.x ?? 0) + (frame?.width ?? 0);
  const buttons = await rows(page)
    .getByRole('button')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return rect.x + rect.width;
      }),
    );
  expect(buttons.length).toBeGreaterThan(0);
  expect(Math.max(...buttons)).toBeLessThanOrEqual(right + 1);
}

const VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720, fits: true },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024, fits: false },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667, fits: false },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}: 長い値でも、一覧・履歴の表が潰れない`, () => {
    for (const [noteName, note] of [
      ['日本語の備考2000文字（上限）', LONG_NOTE_JAPANESE],
      ['区切りのない英字の備考2000文字（上限）', LONG_NOTE_ASCII],
    ] as const) {
      test(`入力済みデータ（SC-07）: ${noteName}・ユーザーID100文字の入力者`, async ({
        page,
        request,
      }, testInfo) => {
        await prepareApp(request);
        await addUser(request, LONG_USER);
        await addEntryAs(request, LONG_USER, {
          equipmentId: ROBOT_ID,
          category: 'FAILURE',
          observedAt: hoursAgo(2),
          items: { failureCount: 123456, recoveryMinutes: 9999999.5 },
          note,
        });
        await addEntry(request, {
          category: 'SAFETY',
          observedAt: hoursAgo(1),
          items: { emergencyStopCount: 1 },
        });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        await openList(page);

        await expect(rows(page)).toHaveCount(2);
        // 入力者は、「ユーザー名（ID）」。長いユーザーID でも、全文が、表の中に折り返して出る（SC-07-7）
        await expect(rows(page).nth(1)).toContainText(userLabelText(LONG_USER));
        await expectTableNotCrushed(page, '.entry-table');
        if (viewport.fits) {
          await expectTableFits(page);
          // 操作のボタンが、表の枠の中で、切れずに見える（行が長くても、横の位置は枠の中）
          await expectButtonsInsideTable(page);
        }
        const kind = note === LONG_NOTE_ASCII ? 'ascii' : 'ja';
        await shot(page, testInfo, `uc18-long-list-${String(viewport.width)}-${kind}`);
      });
    }

    test(`変更履歴（SC-08）: ユーザーID100文字の変更者・長い備考の入力の登録`, async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await addUser(request, LONG_USER);
      await addEntryAs(request, LONG_USER, {
        equipmentId: ROBOT_ID,
        category: 'FAILURE',
        observedAt: hoursAgo(2),
        items: { failureCount: 123456, recoveryMinutes: 9999999.5 },
        note: LONG_NOTE_JAPANESE,
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await openHistory(page, '?targetType=manual-entry');

      await expect(auditRows(page)).toHaveCount(1);
      await expect(auditRows(page).first()).toContainText(userLabelText(LONG_USER));
      await expectTableNotCrushed(page, '.audit-table');
      if (viewport.fits) {
        await expectTableFits(page);
      }
      await shot(page, testInfo, `uc18-long-history-${String(viewport.width)}`);
    });
  });
}

for (const viewport of VIEWPORTS.filter((item) => !item.fits)) {
  test(`${viewport.name}: 表の枠の中を横にスクロールすると、修正・削除の操作ができ、修正の欄・削除の確認も、画面に収まる`, async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(1),
      items: { failureCount: 1, recoveryMinutes: 30 },
      note: LONG_NOTE_JAPANESE,
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openList(page);

    // 操作のボタンは、表の枠の中を、横にスクロールして押せる
    const edit = rows(page).first().getByRole('button', { name: '修正' });
    await edit.scrollIntoViewIfNeeded();
    await expect(edit).toBeInViewport({ ratio: 1 });
    await edit.click();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toBeInViewport({ ratio: 1 });
    await expect(editor(page).getByLabel('備考（所感・補足情報）')).toHaveValue(LONG_NOTE_JAPANESE);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, testInfo, `uc18-edit-${String(viewport.width)}`);
    await editor(page).getByRole('button', { name: 'キャンセル' }).click();

    const remove = rows(page).first().getByRole('button', { name: '削除' });
    await remove.scrollIntoViewIfNeeded();
    await remove.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await shot(page, testInfo, `uc18-confirm-${String(viewport.width)}`);
    await confirmDialog(page, '削除');
    await expect(noticeTitle(page)).toHaveText('削除しました');
  });
}

test.describe('事後条件: 変更履歴の変更前後の値に、項目の値だけでなく、計測日時・設備・カテゴリ・備考も残る', () => {
  test('備考と計測日時だけを修正しても、履歴で、変更前後の違いが分かる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const created = await addEntry(request, {
      category: 'SAFETY',
      observedAt: '2026-10-09T01:00:00.000Z',
      items: { emergencyStopCount: 1 },
      note: '修正前の備考',
    });
    await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
    await api(request, 'PUT', `/manual-entries/${created.entry.entryId}`, {
      equipmentId: ROBOT_ID,
      category: 'SAFETY',
      observedAt: '2026-10-09T02:30:00.000Z',
      items: { emergencyStopCount: 1 },
      note: '修正後の備考',
    });

    await openHistory(page, '?targetType=manual-entry&operation=UPDATE');

    await expect(auditRows(page)).toHaveCount(1);
    const cells = auditRows(page).first().locator('td');
    await expect(cells.nth(4)).toContainText('修正前の備考');
    await expect(cells.nth(4)).toContainText('2026/10/09 10:00:00');
    await expect(cells.nth(4)).toContainText(ROBOT_ID);
    await expect(cells.nth(4)).toContainText('安全情報');
    await expect(cells.nth(5)).toContainText('修正後の備考');
    await expect(cells.nth(5)).toContainText('2026/10/09 11:30:00');
    await expect(cells.nth(5)).not.toContainText('修正前の備考');
    await shot(page, testInfo, 'uc18-history-meta');
  });
});

/** 変更履歴の、変更点の印（Issue #190。SC-08-5）の確認。広い幅・タブレット幅・スマートフォン幅（900px 以下は、1 件ごとのカード）。 */
for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}: 変更履歴の変更点の印（SC-08-5）`, () => {
    /** 印のタグが、文字・太字・枠線を持つ（色だけに頼っていない）。 */
    async function expectMarkNotColorOnly(mark: Locator): Promise<void> {
      await expect(mark).toBeVisible();
      expect((await mark.innerText()).trim()).not.toBe('');
      const style = await mark.evaluate((node) => {
        const computed = getComputedStyle(node);
        return { weight: Number(computed.fontWeight), border: computed.borderTopWidth };
      });
      expect(style.weight).toBeGreaterThanOrEqual(700);
      expect(style.border).toBe('1px');
    }

    /** 印のタグが、画面の幅の中に見える（カードで、枠から出ない）。 */
    async function expectInsideViewport(mark: Locator): Promise<void> {
      await mark.scrollIntoViewIfNeeded();
      const box = await mark.boundingBox();
      expect(box).not.toBeNull();
      if (box !== null && viewport.width <= 900) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    test('手動入力: 変わった項目に「変更」「追加」「なし」。変わらない項目・登録・削除には付けない', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      const created = await addEntry(request, {
        category: 'SAFETY',
        observedAt: hoursAgo(3),
        items: { emergencyStopCount: 1, nearMissCount: 2 },
        note: '修正前の備考',
      });
      const url = `/manual-entries/${created.entry.entryId}`;
      await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
      // 1 回目の修正: 緊急停止回数を変更・ヒヤリハット件数と備考をなくす
      await api(request, 'PUT', url, {
        equipmentId: ROBOT_ID,
        category: 'SAFETY',
        observedAt: hoursAgo(3),
        items: { emergencyStopCount: 2 },
      });
      await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
      // 2 回目の修正: ヒヤリハット件数を加える（緊急停止回数は、そのまま）
      await api(request, 'PUT', url, {
        equipmentId: ROBOT_ID,
        category: 'SAFETY',
        observedAt: hoursAgo(3),
        items: { emergencyStopCount: 2, nearMissCount: 4 },
      });
      await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
      await api(request, 'DELETE', url);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await openHistory(page, '?targetType=manual-entry');

      await expect(auditRows(page)).toHaveCount(4);
      const deleted = auditRows(page).nth(0);
      const second = auditRows(page).nth(1);
      const first = auditRows(page).nth(2);
      const registered = auditRows(page).nth(3);
      // 登録・削除: 印を付けない（操作種別だけで示す）
      await expect(deleted).toContainText('削除');
      await expect(registered).toContainText('登録');
      await expect(deleted.locator('.diff-mark')).toHaveCount(0);
      await expect(registered.locator('.diff-mark')).toHaveCount(0);
      // 1 回目: 緊急停止回数は「変更」（変更前・変更後）、ヒヤリハット件数・備考は、変更後に「なし」
      const firstBefore = first.locator('td[data-label="変更前"]');
      const firstAfter = first.locator('td[data-label="変更後"]');
      await expect(firstBefore.locator('.diff-mark')).toHaveText(['変更']);
      await expect(firstAfter.locator('.diff-mark')).toHaveText(['変更', 'なし', 'なし']);
      const stopAfter = firstAfter.locator('li').filter({ hasText: '緊急停止回数' });
      const missAfter = firstAfter.locator('li').filter({ hasText: 'ヒヤリハット件数' });
      const missBefore = firstBefore.locator('li').filter({ hasText: 'ヒヤリハット件数' });
      await expect(stopAfter).toContainText('2回変更');
      await expect(missAfter).toContainText('なし');
      await expect(missAfter).not.toContainText('2件');
      await expect(missBefore).toContainText('2件');
      await expect(missBefore.locator('.diff-mark')).toHaveCount(0);
      // 2 回目: ヒヤリハット件数が、変更後に「追加」。緊急停止回数（変わらない）には付けない
      const secondAfter = second.locator('td[data-label="変更後"]');
      await expect(second.locator('td[data-label="変更前"] .diff-mark')).toHaveCount(0);
      await expect(secondAfter.locator('.diff-mark')).toHaveText(['追加']);
      await expect(
        secondAfter.locator('li').filter({ hasText: '緊急停止回数' }).locator('.diff-mark'),
      ).toHaveCount(0);
      for (const mark of await firstAfter.locator('.diff-mark').all()) {
        await expectMarkNotColorOnly(mark);
        await expectInsideViewport(mark);
      }
      await expectInsideViewport(secondAfter.locator('.diff-mark'));
      await shot(page, testInfo, `uc18-history-diff-manual-${String(viewport.width)}`);
    });

    test('設備・ステータスコード・判断基準: 閉じた状態で、変わった項目名を 1 行で示す。内容を開くと、変わった項目に印が付く', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await setEquipmentInterval(request, ROBOT_ID, 5);
      await api(request, 'POST', '/dev/clock/advance', { minutes: 1 });
      await setEquipmentInterval(request, ROBOT_ID, 10);
      await api(request, 'PUT', '/status-codes/STANDBY', {
        name: '待機（変更）',
        category: 'NORMAL',
      });
      // 判断基準の更新は、読み込んだ時点の版（ETag）を If-Match に付ける（SC-13-1）
      const read = await api(request, 'GET', '/viewpoints/harvestAccuracy/criteria');
      const etag = read.headers().etag ?? '';
      const view = (await read.json()) as {
        criteria: { indicator: string; kind: string; thresholds: { cautionBelow: number } }[];
      };
      const target = view.criteria.find((criterion) => criterion.kind === 'LOWER');
      expect(target).toBeDefined();
      const saved = await api(
        request,
        'PUT',
        '/viewpoints/harvestAccuracy/criteria',
        {
          criteria: view.criteria.map((criterion) =>
            criterion === target
              ? {
                  ...criterion,
                  thresholds: {
                    ...criterion.thresholds,
                    cautionBelow: criterion.thresholds.cautionBelow + 1,
                  },
                }
              : criterion,
          ),
        },
        { 'if-match': etag },
      );
      expect(saved.status(), '判断基準の保存').toBe(200);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      // 設備: 1 回目は、取得間隔を「追加」、2 回目は「変更」
      await openHistory(page, `?targetType=equipment&targetId=${ROBOT_ID}`);
      const equipmentRows = auditRows(page).filter({ hasText: '編集' });
      await expect(equipmentRows).toHaveCount(2);
      const newer = equipmentRows.nth(0).locator('td[data-label="変更後"]');
      const older = equipmentRows.nth(1).locator('td[data-label="変更後"]');
      await expect(newer.locator('.audit-changes')).toHaveText('変更: 取得間隔');
      await expect(older.locator('.audit-changes')).toHaveText('追加: 取得間隔');
      // 閉じた状態でも、見える（内容を開かなくても、1 行で分かる）
      await expect(newer.locator('.audit-changes')).toBeVisible();
      await expect(newer.locator('details')).not.toHaveAttribute('open', '');
      await expect(newer.locator('.diff-mark')).toBeHidden();
      await newer.locator('summary').click();
      const mark = newer
        .locator('.audit-field', { hasText: '"intervalMinutes": 10' })
        .locator('.diff-mark');
      await expect(mark).toHaveText('変更');
      await expectMarkNotColorOnly(mark);
      await expectInsideViewport(mark);
      // 変わらない項目（設備 ID）には、印を付けない。全項目は残る
      const unchanged = newer.locator('.audit-field', { hasText: '"equipmentId"' });
      await expect(unchanged).toBeVisible();
      await expect(unchanged.locator('.diff-mark')).toHaveCount(0);
      await shot(page, testInfo, `uc18-history-diff-equipment-${String(viewport.width)}`);

      // ステータスコード
      await openHistory(page, '?targetType=status-code');
      await expect(
        auditRows(page).first().locator('td[data-label="変更後"] .audit-changes'),
      ).toContainText('変更: 名称');

      // 判断基準: 閾値が変わった指標だけ（版・更新日時・更新者は、印の対象にしない）
      await openHistory(page, '?targetType=criteria');
      await expect(auditRows(page)).toHaveCount(1);
      const criteriaAfter = auditRows(page).first().locator('td[data-label="変更後"]');
      await expect(criteriaAfter.locator('.audit-changes')).toHaveText('変更: 可販果率');
      await criteriaAfter.locator('summary').click();
      await expect(criteriaAfter.locator('.diff-mark')).toHaveText(['変更']);
      await shot(page, testInfo, `uc18-history-diff-criteria-${String(viewport.width)}`);
    });
  });
}
