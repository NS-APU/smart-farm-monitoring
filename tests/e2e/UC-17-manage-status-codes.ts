/**
 * UC-17 ステータスコードを管理する（SC-12。FR-3.1〜FR-3.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ステータスコードの一覧を参照する
 *               2. 農作業者が、ステータスコードを登録・編集・削除する（コード値、名称、説明、カテゴリ（正常／注意／異常））
 *               3. システムが、入力内容を検証して保存する
 *   代替フロー  ・同じコード値を重複して登録しようとした場合は、エラーとする
 *               ・削除する場合は、確認を求める
 *   事後条件    ステータスコードの定義が保存され、ロボットの状態の判定と、観点の評価（収穫速度・メンテナンス性・耐久性）に使われる
 *
 * 値の同値分割: カテゴリ（正常・注意・異常）、コード値（形式・長さの境界・重複・削除済み）、名称・説明の長さの境界、
 * 操作（登録・編集・削除・確認の取り消し）、評価への影響（カテゴリの変更・削除）、権限（変更できる・参照のみ）。
 * 関連するユースケース: UC-08（ステータスコードの取り込み）・UC-02/UC-01（観点の評価・名称の表示）・UC-10（評価の変化の通知）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  apiOk,
  confirmDialog,
  goToMenu,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
} from './support/app.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { durabilityData, hoursAgo, seed, shot } from './support/viewpoint-scenarios.ts';
import { locatorOf, rowBy } from './support/pages.ts';

const rows = locatorOf('status-code-row');
const rowOf = rowBy('status-code-row', 'data-code');
const addForm = (page: Page) => page.getByTestId('status-code-add');
const notice = locatorOf('status-codes-notice');

async function openStatusCodes(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, 'ステータスコード');
  await expect(page.getByRole('heading', { name: 'ステータスコード', level: 1 })).toBeVisible();
}

async function register(
  page: Page,
  values: { code: string; name: string; category?: string; description?: string },
): Promise<void> {
  const form = addForm(page);
  await form.getByLabel('コード値').fill(values.code);
  await form.getByLabel('名称').fill(values.name);
  if (values.category !== undefined) {
    await form.getByLabel('カテゴリ').selectOption(values.category);
  }
  await form.getByLabel('説明').fill(values.description ?? '');
  await form.getByRole('button', { name: '登録する' }).click();
}

test.describe('基本フロー: ステータスコードの一覧を参照し、登録・編集・削除して、保存する', () => {
  test('初期の定義（8件）を、コード値の順に、コード値・名称・カテゴリ・説明で一覧表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);

    await openStatusCodes(page);

    await expect(rows(page)).toHaveCount(8);
    await expect(
      rows(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-code'))),
    ).resolves.toEqual([
      'FALLEN',
      'HARVESTING',
      'HARVEST_ERROR',
      'LOW_BATTERY',
      'RUNNING',
      'RUNNING_ERROR',
      'STANDBY',
      'STOPPED',
    ]);
    await expect(rowOf(page, 'STANDBY')).toContainText('待機中');
    await expect(rowOf(page, 'STANDBY').locator('.status-badge')).toContainText('正常');
    await expect(rowOf(page, 'STOPPED').locator('.status-badge')).toContainText('注意');
    await expect(rowOf(page, 'FALLEN').locator('.status-badge')).toContainText('異常');
    await expect(rowOf(page, 'FALLEN')).toContainText('転倒（姿勢異常）');
    // 8件すべての名称・カテゴリと、説明の列（初期の定義は説明なし）
    const initial: readonly (readonly [code: string, name: string, category: string])[] = [
      ['STANDBY', '待機中', '正常'],
      ['RUNNING', '走行中', '正常'],
      ['HARVESTING', '収穫中', '正常'],
      ['STOPPED', '停止中', '注意'],
      ['LOW_BATTERY', 'バッテリー不足', '注意'],
      ['RUNNING_ERROR', '走行異常', '異常'],
      ['HARVEST_ERROR', '収穫異常', '異常'],
      ['FALLEN', '転倒（姿勢異常）', '異常'],
    ];
    for (const [code, name, category] of initial) {
      await expect(rowOf(page, code)).toContainText(name);
      await expect(rowOf(page, code).locator('.status-badge')).toContainText(category);
      await expect(rowOf(page, code).locator('td').nth(3)).toHaveText('—');
    }
    await shot(page, testInfo, 'uc17-list');
  });

  test('登録: コード値・名称・説明・カテゴリを入力して登録すると、一覧に追加される。再読み込みしても保持される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await register(page, {
      code: 'CHARGING',
      name: '充電中',
      category: 'NORMAL',
      description: '充電ステーションで充電している',
    });

    await expect(notice(page)).toHaveText('登録しました');
    await expect(rows(page)).toHaveCount(9);
    await expect(rowOf(page, 'CHARGING')).toContainText('充電中');
    await expect(rowOf(page, 'CHARGING')).toContainText('充電ステーションで充電している');
    // 登録の直後に、入力欄はクリアされる
    await expect(addForm(page).getByLabel('コード値')).toHaveValue('');
    await page.reload();
    await expect(rowOf(page, 'CHARGING')).toBeVisible();
    // 入力欄は、クリアされる
    await expect(addForm(page).getByLabel('コード値')).toHaveValue('');
  });

  test('編集: 名称・説明・カテゴリを変更できる。コード値は、変更できない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await rowOf(page, 'LOW_BATTERY').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await expect(edit.getByLabel('コード値')).toHaveCount(0);
    await shot(page, testInfo, 'uc17-edit');
    await edit.getByLabel('名称').fill('電池残量わずか');
    await edit.getByLabel('カテゴリ').selectOption('ERROR');
    await edit.getByLabel('説明').fill('電池残量が少ない');
    await edit.getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, 'LOW_BATTERY')).toContainText('電池残量わずか');
    await expect(rowOf(page, 'LOW_BATTERY').locator('.status-badge')).toContainText('異常');
    await expect(rowOf(page, 'LOW_BATTERY')).toContainText('電池残量が少ない');
    await expect(page.getByTestId('status-code-edit')).toHaveCount(0);
  });

  test('編集: キャンセルすると、変更せずに閉じる。説明を空にして保存すると、説明が消える（一覧では「—」）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await rowOf(page, 'STANDBY').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await edit.getByLabel('名称').fill('保存しない名称');
    await edit.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByTestId('status-code-edit')).toHaveCount(0);
    await expect(rowOf(page, 'STANDBY')).toContainText('待機中');
    await expect(rowOf(page, 'STANDBY')).not.toContainText('保存しない名称');

    await rowOf(page, 'FALLEN').getByRole('button', { name: '修正' }).click();
    await expect(page.getByTestId('status-code-edit').getByLabel('説明')).toHaveValue('');
    await page.getByTestId('status-code-edit').getByLabel('説明').fill('転倒して起き上がれない');
    await page.getByTestId('status-code-edit').getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, 'FALLEN')).toContainText('転倒して起き上がれない');

    await rowOf(page, 'FALLEN').getByRole('button', { name: '修正' }).click();
    await page.getByTestId('status-code-edit').getByLabel('説明').fill('');
    await page.getByTestId('status-code-edit').getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, 'FALLEN').locator('td').nth(3)).toHaveText('—');
    await expect(rowOf(page, 'FALLEN')).toContainText('転倒（姿勢異常）');
  });

  test('削除: 確認を求め、削除すると、一覧から外れる。確認でキャンセルすると、削除しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await rowOf(page, 'STOPPED').getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(
      'ステータスコードを削除しますか',
    );
    await shot(page, testInfo, 'uc17-confirm');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();
    await expect(rowOf(page, 'STOPPED')).toHaveCount(1);
    await rowOf(page, 'STOPPED').getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');

    await expect(notice(page)).toHaveText('削除しました');
    await expect(rowOf(page, 'STOPPED')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(7);
  });

  test('削除済みのコード値を、もう一度登録すると、削除が取り消され、定義が更新される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openStatusCodes(page);
    await rowOf(page, 'STOPPED').getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(rowOf(page, 'STOPPED')).toHaveCount(0);

    await register(page, { code: 'STOPPED', name: '停止（再登録）', category: 'ERROR' });

    await expect(notice(page)).toHaveText('登録しました');
    await expect(rowOf(page, 'STOPPED')).toContainText('停止（再登録）');
    await expect(rowOf(page, 'STOPPED').locator('.status-badge')).toContainText('異常');
  });
});

test.describe('カテゴリ（正常・注意・異常）の同値分割', () => {
  const categories: readonly { value: string; label: string }[] = [
    { value: 'NORMAL', label: '正常' },
    { value: 'CAUTION', label: '注意' },
    { value: 'ERROR', label: '異常' },
  ];

  for (const category of categories) {
    test(`カテゴリ「${category.label}」で登録できる（選択肢は、正常・注意・異常の3つのみ。「不明」は選べない）`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openStatusCodes(page);
      await expect(addForm(page).getByLabel('カテゴリ').locator('option')).toHaveText([
        '正常',
        '注意',
        '異常',
      ]);

      await register(page, {
        code: `CODE_${category.value}`,
        name: `名称${category.label}`,
        category: category.value,
      });

      await expect(rowOf(page, `CODE_${category.value}`).locator('.status-badge')).toContainText(
        category.label,
      );
    });
  }
});

test.describe('代替フロー: 入力が不正な場合は、保存しない（同じコード値の重複はエラー）', () => {
  test('登録済みのコード値は、重複としてエラーにする', async ({ page, request }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await register(page, { code: 'STANDBY', name: '重複' });

    await expect(addForm(page).locator('[data-field="code"] .field-error')).toHaveText(
      '同じコード値がすでに登録されています',
    );
    await expect(rows(page)).toHaveCount(8);
    await shot(page, testInfo, 'uc17-duplicate');
  });

  const invalidCodes: readonly { name: string; code: string; message: string }[] = [
    { name: '空', code: '', message: 'コード値は必須です' },
    {
      name: '小文字',
      code: 'charging',
      message: 'コード値は英大文字・数字・アンダースコアで指定してください',
    },
    {
      name: '数字から始まる',
      code: '1ABC',
      message: 'コード値は英大文字・数字・アンダースコアで指定してください',
    },
    {
      name: 'ハイフンを含む',
      code: 'A-B',
      message: 'コード値は英大文字・数字・アンダースコアで指定してください',
    },
    {
      name: '日本語',
      code: '充電',
      message: 'コード値は英大文字・数字・アンダースコアで指定してください',
    },
    {
      name: '101文字（境界の外）',
      code: `A${'B'.repeat(100)}`,
      message: 'コード値は100文字以内で指定してください',
    },
  ];

  for (const item of invalidCodes) {
    test(`コード値が${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request);
      await openStatusCodes(page);

      await register(page, { code: item.code, name: '名称' });

      await expect(addForm(page).locator('[data-field="code"] .field-error')).toHaveText(
        item.message,
      );
      await expect(rows(page)).toHaveCount(8);
    });
  }

  test('コード値が100文字（境界）・名称が100文字（境界）・説明が500文字（境界）なら、登録できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);

    await register(page, {
      code: `A${'B'.repeat(99)}`,
      name: 'あ'.repeat(100),
      description: 'い'.repeat(500),
    });

    await expect(notice(page)).toHaveText('登録しました');
    // 最大の長さでも、表が崩れない（列が極端に細くならない・横にはみ出さない・行が極端に高くならない）こと
    const row = rowOf(page, `A${'B'.repeat(99)}`);
    const widths = await row
      .locator('td')
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    for (const width of widths.slice(0, 4)) {
      expect(width).toBeGreaterThanOrEqual(100);
    }
    expect((await row.boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
    const scroll = page.locator('.table-scroll');
    await expect(scroll.evaluate((node) => node.scrollWidth <= node.clientWidth)).resolves.toBe(
      true,
    );
    await shot(page, testInfo, 'uc17-boundary');
  });

  const invalidTexts: readonly {
    name: string;
    name_: string;
    description: string;
    field: string;
    message: string;
  }[] = [
    { name: '名称が空', name_: '', description: '', field: 'name', message: '名称は必須です' },
    {
      name: '名称が空白のみ',
      name_: '   ',
      description: '',
      field: 'name',
      message: '名称は必須です',
    },
    {
      name: '名称が101文字',
      name_: 'あ'.repeat(101),
      description: '',
      field: 'name',
      message: '名称は100文字以内で指定してください',
    },
    {
      name: '説明が501文字',
      name_: '名称',
      description: 'い'.repeat(501),
      field: 'description',
      message: '説明は500文字以内で指定してください',
    },
  ];

  for (const item of invalidTexts) {
    test(`${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request);
      await openStatusCodes(page);

      await register(page, { code: 'NEW_CODE', name: item.name_, description: item.description });

      await expect(
        addForm(page).locator(`[data-field="${item.field}"] .field-error`),
      ).toBeVisible();
      await expect(addForm(page).locator(`[data-field="${item.field}"] .field-error`)).toHaveText(
        item.message,
      );
      await expect(rows(page)).toHaveCount(8);
    });
  }

  test('編集の入力が不正（名称が空）なら、エラーを表示し、保存しない。エラーを直して保存できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);
    await rowOf(page, 'RUNNING').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await edit.getByLabel('名称').fill('');
    await edit.getByRole('button', { name: '保存' }).click();
    await expect(edit.locator('[data-field="name"] .field-error')).toBeVisible();
    await shot(page, testInfo, 'uc17-validation');

    await edit.getByLabel('名称').fill('走行');
    await edit.getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, 'RUNNING')).toContainText('走行');
  });
});

test.describe('事後条件: ステータスコードの定義は、観点の評価に使われる（カテゴリの変更・削除・名称の表示）', () => {
  /** ロボットのデータ: 待機中（STANDBY）で、故障 1 回・復旧 60 分（MTTR 1時間。正常）。 */
  async function maintainabilityData(request: Parameters<typeof prepareApp>[0]): Promise<void> {
    await seed(request, {
      observations: [
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'statusCode',
          value: 'STANDBY',
          observedAt: hoursAgo(1),
        },
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'failureCount',
          value: 1,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'recoveryMinutes',
          value: 60,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
      ],
    });
  }

  const dashboardBadge = (page: Page) =>
    page.getByTestId('card-maintainability').locator('.status-badge');

  test('カテゴリを「正常」→「異常」に変更すると、そのコードを使う観点（メンテナンス性）の評価が、異常に変わる（評価に反映される）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await maintainabilityData(request);
    await openStatusCodes(page);
    await page.goto('/');
    await expect(dashboardBadge(page)).toContainText('正常');
    await goToMenu(page, 'ステータスコード');

    await rowOf(page, 'STANDBY').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await edit.getByLabel('カテゴリ').selectOption('ERROR');
    await edit.getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    await goToMenu(page, 'ダッシュボード');
    await expect(dashboardBadge(page)).toContainText('異常');
  });

  test('カテゴリを「正常」→「異常」に変更すると、耐久性（長期視点。期間内の最も悪いカテゴリ）の評価も、異常に変わる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 稼働時間 600 時間・故障 1 回（MTBF 600 時間。正常）、ステータスは待機中（STANDBY）
    await seed(request, durabilityData('NORMAL', 'STANDBY'));
    await openStatusCodes(page);
    await page.goto('/');
    const durability = page.getByTestId('card-durability').locator('.status-badge');
    await expect(durability).toContainText('正常');
    await goToMenu(page, 'ステータスコード');

    await rowOf(page, 'STANDBY').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await edit.getByLabel('カテゴリ').selectOption('ERROR');
    await edit.getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    await goToMenu(page, 'ダッシュボード');
    await expect(durability).toContainText('異常');
    await page.goto('/viewpoints/durability');
    await expect(page.getByTestId('diagnostic-message')).toContainText('ステータス 待機中（異常）');
  });

  test('登録・編集・削除は、変更履歴に残る（操作・コード値・操作した利用者・変更前後の定義）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openStatusCodes(page);
    await register(page, { code: 'CHARGING', name: '充電中', category: 'NORMAL' });
    await expect(notice(page)).toHaveText('登録しました');
    // 履歴は日時の順に並ぶため、操作の間は、時計を進める
    await advanceMinutes(request, 1);
    await rowOf(page, 'CHARGING').getByRole('button', { name: '修正' }).click();
    await page.getByTestId('status-code-edit').getByLabel('カテゴリ').selectOption('CAUTION');
    await page.getByTestId('status-code-edit').getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');
    await advanceMinutes(request, 1);
    await rowOf(page, 'CHARGING').getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(notice(page)).toHaveText('削除しました');

    await page.goto('/data-entry/history?targetType=status-code');

    const audit = page.getByTestId('audit-row');
    await expect(audit).toHaveCount(3);
    for (const [index, operation] of ['削除', '編集', '登録'].entries()) {
      const row = audit.nth(index);
      await expect(row).toContainText(operation);
      await expect(row).toContainText('ステータスコード');
      await expect(row).toContainText('（CHARGING）');
      await expect(row).toContainText(E2E_USER.userId);
    }
    // 変更前後の定義（列: 日時・操作・対象・操作者・変更前・変更後）。ない側は「—」
    await expect(audit.nth(0).locator('td').nth(4)).toContainText('"category": "CAUTION"');
    await expect(audit.nth(0).locator('td').nth(5)).toHaveText('—');
    await expect(audit.nth(1).locator('td').nth(4)).toContainText('"category": "NORMAL"');
    await expect(audit.nth(1).locator('td').nth(5)).toContainText('"category": "CAUTION"');
    await expect(audit.nth(2).locator('td').nth(4)).toHaveText('—');
    await expect(audit.nth(2).locator('td').nth(5)).toContainText('"category": "NORMAL"');
    // 内容を開いた状態を、画像で確認する
    for (const summary of await page.locator('[data-testid="audit-row"] summary').all()) {
      await summary.click();
    }
    await shot(page, testInfo, 'uc17-history');
  });

  test('名称を変更すると、観点の詳細（ステータスのメトリクス）の表示名が、変わる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await maintainabilityData(request);
    await openStatusCodes(page);
    await rowOf(page, 'STANDBY').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('status-code-edit');
    await edit.getByLabel('名称').fill('待機（充電待ち）');
    await edit.getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    await page.goto('/viewpoints/maintainability');

    await expect(page.getByTestId('metric-status').locator('td').first()).toHaveText(
      '待機（充電待ち）',
    );
  });

  test('コードを削除すると、そのコード値のデータは「不正な値」として扱われ、評価に使われない（メンテナンス性は、不明になる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await maintainabilityData(request);
    await openStatusCodes(page);
    await rowOf(page, 'STANDBY').getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('不正な値');
    await confirmDialog(page, '削除');
    await expect(notice(page)).toHaveText('削除しました');

    await goToMenu(page, 'ダッシュボード');

    await expect(dashboardBadge(page)).toContainText('不明');
  });

  test('登録したコードを使うデータを取り込むと、そのカテゴリで評価される（UC-08 への連携。注意のコード → 収穫速度が注意）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openStatusCodes(page);
    await register(page, { code: 'CHARGING_WAIT', name: '充電待ち', category: 'CAUTION' });
    await expect(notice(page)).toHaveText('登録しました');
    const fields = {
      harvestCount: 10,
      harvestSecondsPerFruit: 36,
      operatingHours: 0.25,
      harvestOperatingHours: 0.1,
      travelStoppedHours: 0.002,
      statusCode: 'CHARGING_WAIT',
    };
    placeFile(
      'robot',
      'a.json',
      robotJson([
        { hoursAgo: 0.5, fields },
        { hoursAgo: 0.25, fields },
      ]),
    );
    await apiOk(request, 'POST', '/ingestion/robot/run');

    await goToMenu(page, 'ダッシュボード');

    await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
      '注意',
    );
    await expect(page.getByTestId('card-harvestSpeed')).toContainText('充電待ち');
  });
});

test.describe('権限: 変更する権限のない利用者（閲覧者）は、参照のみ', () => {
  test('閲覧者には、登録・編集・削除の操作を表示せず、一覧を参照できる。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);

    await openStatusCodes(page, VIEWER);

    await expect(page.getByTestId('permission-notice')).toHaveText(
      'ステータスコードを変更する権限がありません。参照のみできます',
    );
    await expect(rows(page)).toHaveCount(8);
    await expect(page.getByRole('button', { name: '修正' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '削除' })).toHaveCount(0);
    await expect(addForm(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc17-readonly');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/status-codes/STANDBY', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(denied.status()).toBe(403);
  });
});
