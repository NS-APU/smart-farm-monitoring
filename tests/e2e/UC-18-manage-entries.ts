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

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  USER_B,
  VIEWER,
  addEntry,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  confirmDialog,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import { fieldError, fillEntryForm, saveEntry } from './support/entry.ts';
import { hoursAgo, shot } from './support/viewpoint-scenarios.ts';
import { locatorOf, userIdText } from './support/pages.ts';

const rows = locatorOf('entry-row');
const auditRows = (page: Page) => page.getByTestId('audit-row');
const notice = locatorOf('entries-notice');
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
    items: { 'satisfaction.safety': 4 },
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
    expect(await column(rows(page), 1)).toEqual(['ハウス1', '環境センサー1', '収穫ロボット1']);
    await expect(rows(page).nth(2)).toContainText('故障情報');
    await expect(rows(page).nth(2)).toContainText('故障回数: 2回');
    await expect(rows(page).nth(2)).toContainText('復旧に要した時間: 90分');
    await expect(rows(page).nth(2)).toContainText(userIdText('e2e-user'));
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
      expect(await column(rows(page), 1)).toEqual(item.expected);
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
      .toEqual(['e2e-user', 'e2e-user-b', 'e2e-user-b']);
    expect((await column(rows(page), 3)).slice(1)).toEqual([
      '緊急停止回数: 1回',
      '緊急停止回数: 3回',
    ]);
    await page.getByLabel('並べ替えの向き').selectOption('desc');
    await expect
      .poll(() => column(rows(page), 4))
      .toEqual(['e2e-user-b', 'e2e-user-b', 'e2e-user']);
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

    await page.getByRole('button', { name: '次へ' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(rows(page).first()).toContainText('緊急停止回数: 0回');
    await page.getByLabel('並べ替えの向き').selectOption('asc');

    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(rows(page)).toHaveCount(20);
  });
});

test.describe('基本フロー 3〜4: データを修正または削除し、検証して保存する', () => {
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
      editor(page).getByTestId('entry-items').getByLabel('復旧に要した時間'),
    ).toHaveValue('600');
    await expect(editor(page).getByLabel('備考（所感・補足情報）')).toHaveValue('最初の記録');
    await shot(page, testInfo, 'uc18-edit');
    await fillEntryForm(
      page,
      { items: { 復旧に要した時間: '90' }, note: '訂正: 復旧は 90 分だった' },
      editor(page),
    );
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(editor(page)).toHaveCount(0);
    await expect(rows(page).first()).toContainText('復旧に要した時間: 90分');
    await expect(rows(page).first()).toContainText('訂正: 復旧は 90 分だった');
    await expect(rows(page).first()).toContainText(userIdText('e2e-user'));
    // 評価に反映される（MTTR 1.5 時間 = 正常。以前は 10 時間 = 異常）
    await page.goto('/viewpoints/maintainability?equipmentId=ROBOT-01');
    await expect(page.getByTestId('metric-mttrHours').locator('td').first()).toHaveText('1.50時間');
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
        items: { '満足度（収穫精度）': '5' },
      },
      editor(page),
    );
    await editor(page).getByRole('button', { name: '保存', exact: true }).click();

    await expect(notice(page)).toHaveText('修正しました');
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

  test('削除: 確認を求め（取り消せる）、削除すると、論理削除として、一覧・取り込み済みデータから除外される。変更履歴には、削除前の内容が残る', async ({
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
    await shot(page, testInfo, 'uc18-confirm');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');

    await expect(notice(page)).toHaveText('削除しました');
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
    await expect(notice(page)).toHaveText('削除しました');

    await page.goto('/viewpoints/maintainability?equipmentId=ROBOT-01');
    await expect(page.getByTestId('metric-failureCount').locator('td').first()).toHaveText('—');
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
    await expect(auditRows(page).nth(0)).toContainText('e2e-user-b');
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

    await page.getByRole('button', { name: '次へ' }).click();

    await expect(auditRows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
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
    await expect(auditRows(page).first().locator('pre').nth(1)).toContainText('待機（変更）');
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
    await expect(rows(b.page).first()).toContainText(userIdText('e2e-user'));
    await rows(b.page).first().getByRole('button', { name: '修正' }).click();
    await fillEntryForm(b.page, { items: { 緊急停止回数: '1' }, note: 'Bが訂正' }, editor(b.page));
    await editor(b.page).getByRole('button', { name: '保存', exact: true }).click();
    await expect(notice(b.page)).toHaveText('修正しました');
    await shot(b.page, testInfo, 'uc18-user-b-edited');

    // 利用者A: 修正後の内容を確認する（入力者は、Aのまま）
    await page.goto('/data-entry/list');
    await expect(rows(page).first()).toContainText('緊急停止回数: 1回');
    await expect(rows(page).first()).toContainText('Bが訂正');
    await expect(rows(page).first()).toContainText(userIdText('e2e-user'));
    await expect(rows(page).first()).not.toContainText('e2e-user-b');
    // 履歴: 登録（A）→ 編集（B）
    await page.goto('/data-entry/history?targetType=manual-entry');
    await expect(auditRows(page)).toHaveCount(2);
    await expect(auditRows(page).nth(0)).toContainText('編集');
    await expect(auditRows(page).nth(0)).toContainText('e2e-user-b');
    await expect(auditRows(page).nth(0)).toContainText('緊急停止回数: 3回');
    await expect(auditRows(page).nth(0)).toContainText('緊急停止回数: 1回');
    await expect(auditRows(page).nth(1)).toContainText('登録');
    await expect(auditRows(page).nth(1)).toContainText(userIdText('e2e-user'));
    await b.context.close();
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

// 画面幅・長い値（最大長の備考2000文字・長い入力者）でも、表が潰れない（NFR-7.3）
const LONG_USER = {
  userId: `u${'a'.repeat(99)}`,
  userName: '長い名前の入力者',
  password: 'Dummy-Passw0rd-l1',
  role: 'worker',
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
    await expect(notice(page)).toHaveText('削除しました');
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
