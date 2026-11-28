/**
 * シナリオ: 観点の詳細を、ダッシュボードの上に、右からのドロワーで開く（Issue #357）。
 * - ダッシュボードのカード・観点別の状態の表から開く。URL は `/?viewpoint=観点`（再読み込み・共有でも開く。「戻る」で閉じる）
 * - ダッシュボードは、描画したまま保つ。閉じたあとも、スクロール位置・選んだ期間・対象のハウスが保たれる
 * - 閉じる: ✕・Esc・背面を押す・ブラウザの「戻る」。閉じたら、開いたカードのリンクにフォーカスが戻る
 * - 幅は min(880px, 100vw)。900px 以下は、全画面。開いている間は、フォーカスをドロワーの中に閉じ込め、本文のスクロールを固定する
 * - 前の観点・次の観点（SC-03-6）: ダッシュボードの観点の並びで切り替える。最初・最後は片方が無効。履歴は積まない
 * - 直接 URL（/viewpoints/…）は、従来どおり、全画面のページ。通知の「詳細を確認」は、ドロワーで開く（#159 の SC-05-6）
 *
 * 確認できないこと（E2E の限界）: 実機（スマートフォン）の、ブラウザのアドレスバーの出入りに、ドロワーの高さが追従すること（`100dvh`）、
 * 実際のスクリーンリーダーの読み上げ。
 */

import { expect, test, type Page } from '@playwright/test';
import { dashboardCard as card, openDashboard } from './support/pages.ts';
import {
  mixedScenario,
  prepare,
  seed,
  shot,
  VIEWPOINT_ORDER,
  waitForDrawerSettled,
} from './support/viewpoint-scenarios.ts';

function drawer(page: Page, name: string) {
  return page.getByRole('dialog', { name });
}

function cardLink(page: Page, viewpointId: string) {
  return card(page, viewpointId).locator('h3').getByRole('link');
}

test.describe('開く', () => {
  test.beforeEach(async ({ request }) => {
    await prepare(request);
    await seed(request, mixedScenario());
  });

  test('カードを選ぶと、右からのドロワーに、観点の詳細が開く。幅は 880px で、画面の高さいっぱい。ダッシュボードは、背面に残る', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openDashboard(page);

    await cardLink(page, 'environmentalAdaptability').click();

    const dialog = drawer(page, '環境適応性の詳細');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/\?viewpoint=environmentalAdaptability$/);
    await expect(dialog.getByTestId('diagnosis')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /環境適応性/, level: 2 })).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 1 })).toHaveCount(0);
    await waitForDrawerSettled(page);
    const box = await dialog.boundingBox();
    expect(box?.width ?? 0).toBeCloseTo(880, 0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(1280, 0);
    expect(box?.y ?? -1).toBeCloseTo(0, 0);
    expect(box?.height ?? 0).toBeCloseTo(720, 0);
    // 背面のダッシュボードは、そのまま残る
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeAttached();
    await expect(card(page, 'safety')).toBeAttached();
    await shot(page, testInfo, 'drawer-desktop');
  });

  test('観点別の状態の表の行・満足度のカードからも開く（満足度は、満足度の詳細）', async ({
    page,
  }) => {
    await openDashboard(page);

    await page.getByTestId('status-row-safety').getByRole('link').click();
    await expect(drawer(page, '安全性の詳細')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer(page, '安全性の詳細')).toHaveCount(0);

    await cardLink(page, 'satisfaction').click();
    const dialog = drawer(page, '満足度の詳細');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/\?viewpoint=satisfaction$/);
    await expect(dialog.getByTestId('radar')).toBeVisible();
  });

  test('URL に観点があれば、再読み込みしても、ドロワーが開いたまま。直接 URL（/viewpoints/…）は、全画面のページ', async ({
    page,
  }) => {
    await openDashboard(page, '?viewpoint=safety&periodDays=30');
    await expect(drawer(page, '安全性の詳細')).toBeVisible();

    await page.reload();

    await expect(drawer(page, '安全性の詳細')).toBeVisible();
    await expect(page.getByLabel('期間').first()).toHaveValue('30');

    await page.goto('/viewpoints/safety');
    await expect(page.getByRole('heading', { name: /安全性/, level: 1 })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'パンくず' })).toBeVisible();
  });

  test('「ページで開く」で、全画面のページへ移る（視点・期間を引き継ぐ）', async ({ page }) => {
    await openDashboard(page, '?periodDays=30');
    await cardLink(page, 'environmentalAdaptability').click();

    await drawer(page, '環境適応性の詳細').getByRole('link', { name: 'ページで開く' }).click();

    await expect(page).toHaveURL(/\/viewpoints\/environmentalAdaptability\?periodDays=30$/);
    await expect(page.getByRole('heading', { name: /環境適応性/, level: 1 })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('閉じる（ダッシュボードの位置・状態が保たれる）', () => {
  test.beforeEach(async ({ request }) => {
    await prepare(request);
    await seed(request, mixedScenario());
  });

  test('閉じたあとも、ダッシュボードのスクロール位置・期間・対象のハウスが保たれ、開いたカードのリンクに、フォーカスが戻る', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await openDashboard(page, '?periodDays=30');
    const link = cardLink(page, 'environmentalAdaptability');
    await link.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.scrollBy(0, 200);
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(100);
    await link.focus();

    await link.click();
    await expect(drawer(page, '環境適応性の詳細')).toBeVisible();
    // 開いている間は、背面のスクロールを固定する
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    await drawer(page, '環境適応性の詳細')
      .getByRole('button', { name: '観点の詳細を閉じる' })
      .click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/\?periodDays=30$/);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThan(2);
    await expect(page.getByLabel('期間').first()).toHaveValue('30');
    await expect(page.getByLabel('対象のハウス')).toHaveValue('HOUSE-01');
    await expect(link).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  });

  for (const [name, close] of [
    [
      '✕',
      async (page: Page) => {
        await drawer(page, '安全性の詳細')
          .getByRole('button', { name: '観点の詳細を閉じる' })
          .click();
      },
    ],
    [
      'Esc',
      async (page: Page) => {
        await page.keyboard.press('Escape');
      },
    ],
    [
      '背面（ドロワーの外）を押す',
      async (page: Page) => {
        await page.mouse.click(30, 300);
      },
    ],
    [
      'ブラウザの「戻る」',
      async (page: Page) => {
        await page.goBack();
      },
    ],
  ] as const) {
    test(`${name} で閉じる。ダッシュボードの URL に戻り、開いたカードのリンクに、フォーカスが戻る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await openDashboard(page);
      const link = cardLink(page, 'safety');
      await link.focus();
      await link.click();
      await expect(drawer(page, '安全性の詳細')).toBeVisible();
      await waitForDrawerSettled(page);

      await close(page);

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
      await expect(link).toBeFocused();
    });
  }
});

test.describe('ドロワーの中の操作とフォーカス', () => {
  test.beforeEach(async ({ request }) => {
    await prepare(request);
    await seed(request, mixedScenario());
  });

  test('開くと、フォーカスは、ドロワーの中にある。Tab を繰り返しても、ドロワーの外へ出ない（Shift+Tab も）', async ({
    page,
  }) => {
    await openDashboard(page);
    await cardLink(page, 'safety').click();
    const dialog = drawer(page, '安全性の詳細');
    await expect(dialog.getByTestId('diagnosis')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '観点の詳細を閉じる' })).toBeFocused();

    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
        ),
        `Tab ${String(step + 1)} 回目`,
      ).toBe(true);
    }
    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await page.evaluate(
          () =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
        ),
      ).toBe(true);
    }
  });

  test('ドロワーの中で、期間を切り替えても、ドロワーは開いたまま。期間は、背面のダッシュボードにも反映される', async ({
    page,
  }) => {
    await openDashboard(page);
    await cardLink(page, 'environmentalAdaptability').click();
    const dialog = drawer(page, '環境適応性の詳細');
    await expect(dialog.getByTestId('diagnosis')).toBeVisible();

    await dialog.getByLabel('期間').selectOption({ label: '直近30日' });

    await expect(page).toHaveURL(/viewpoint=environmentalAdaptability/);
    await expect(page).toHaveURL(/periodDays=30/);
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('期間').first()).toHaveValue('30');

    // 診断は、「現在」と「期間の評価」を並べて示す（視点の切り替えは、ない）
    await expect(dialog.getByTestId('diagnosis-current')).toContainText('現在（直近24時間）');
    await expect(dialog.getByTestId('diagnosis-period')).toContainText('期間の評価（直近30日）');
    await expect(dialog.getByRole('radio', { name: '短期' })).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  test('ドロワーの中で、対象の設備にロボットを選べる（選択は、ハウスに戻されない）。閉じると、ダッシュボードは、そのハウス', async ({
    page,
  }) => {
    await openDashboard(page);
    await cardLink(page, 'harvestSpeed').click();
    const dialog = drawer(page, '収穫速度の詳細');
    await expect(dialog.getByTestId('diagnosis')).toBeVisible();

    await dialog.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1（ロボット）' });

    await expect(
      dialog.getByTestId('diagnosis-period').locator('.diagnosis-block-head .status-badge'),
    ).toContainText('注意');
    await page.waitForTimeout(500); // 背面のダッシュボードの動き（選択をそろえる）が、ドロワーを開いている間は、止まっていること
    await expect(dialog.getByLabel('対象の設備').locator('option:checked')).toContainText(
      '収穫ロボット1',
    );
    await dialog.getByRole('button', { name: '観点の詳細を閉じる' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('対象のハウス')).toHaveValue('HOUSE-01');
  });
});

for (const viewport of [
  { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
]) {
  test.describe(`${viewport.name}: 全画面`, () => {
    test('ドロワーは、全画面（幅・高さとも、画面いっぱい）。中身は、ドロワーの中でスクロールし、背面は、スクロールしない。閉じられる', async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, mixedScenario());
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openDashboard(page);

      await cardLink(page, 'environmentalAdaptability').click();

      const dialog = drawer(page, '環境適応性の詳細');
      await expect(dialog.getByTestId('diagnosis')).toBeVisible();
      await waitForDrawerSettled(page);
      const box = await dialog.boundingBox();
      expect(box?.x ?? -1).toBeCloseTo(0, 0);
      expect(box?.y ?? -1).toBeCloseTo(0, 0);
      expect(box?.width ?? 0).toBeCloseTo(viewport.width, 0);
      expect(box?.height ?? 0).toBeCloseTo(viewport.height, 0);
      // ドロワーの中が、スクロールする（詳細は、画面より長い）。ページ全体は、横にはみ出さない
      const body = await dialog.locator('.drawer-body').evaluate((element) => ({
        scrolls: element.scrollHeight > element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      expect(body).toEqual({ scrolls: true, overflowY: 'auto' });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await shot(page, testInfo, `drawer-${String(viewport.width)}`);

      await dialog.getByRole('button', { name: '観点の詳細を閉じる' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });
}

test('ダークでも、ドロワーが読める（背景・文字の色の確認はテーマのトークンで担保。画面のレイアウトを確認する）', async ({
  page,
  request,
}, testInfo) => {
  await prepare(request);
  await seed(request, mixedScenario());
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDashboard(page);

  await cardLink(page, 'safety').click();

  await expect(drawer(page, '安全性の詳細').getByTestId('diagnosis')).toBeVisible();
  await shot(page, testInfo, 'drawer-dark');
});

test.describe('前の観点・次の観点（SC-03-6）', () => {
  const FIRST = VIEWPOINT_ORDER[0];
  const SECOND = VIEWPOINT_ORDER[1];
  const LAST = ['satisfaction', '満足度'] as const;
  const BEFORE_LAST = ['durability', '耐久性'] as const;

  test.beforeEach(async ({ request }) => {
    await prepare(request);
    await seed(request, mixedScenario());
  });

  test('ダッシュボードの観点の並びで、前後の観点へ切り替わる。期間は保つ。最初では「前の観点」、最後では「次の観点」が無効', async ({
    page,
  }) => {
    await openDashboard(page, '?periodDays=30');
    await cardLink(page, FIRST[0]).click();
    const first = drawer(page, `${FIRST[1]}の詳細`);
    await expect(first.getByTestId('diagnosis')).toBeVisible();
    await expect(first.getByRole('button', { name: '前の観点' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await first.getByRole('button', { name: '次の観点' }).click();

    const second = drawer(page, `${SECOND[1]}の詳細`);
    await expect(second).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`viewpoint=${SECOND[0]}&periodDays=30$`));
    await expect(second.getByTestId('diagnosis')).toBeVisible();
    await expect(second.getByRole('button', { name: '前の観点' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await second.getByRole('button', { name: '前の観点' }).click();
    await expect(drawer(page, `${FIRST[1]}の詳細`)).toBeVisible();

    // 最後の観点（満足度）: 「次の観点」が無効。前は、その手前の観点
    await page.keyboard.press('Escape');
    await cardLink(page, LAST[0]).click();
    const last = drawer(page, `${LAST[1]}の詳細`);
    await expect(last.getByTestId('radar')).toBeVisible();
    await expect(last.getByRole('button', { name: '次の観点' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await last.getByRole('button', { name: '前の観点' }).click();
    await expect(drawer(page, `${BEFORE_LAST[1]}の詳細`)).toBeVisible();
    // 切り替えは、履歴を積まない。「戻る」で、ドロワーが閉じる
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('スマートフォン幅（375px）でも、前後の観点・「ページで開く」・閉じるが、横にはみ出さず、押せる', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openDashboard(page);
    await cardLink(page, FIRST[0]).click();
    const dialog = drawer(page, `${FIRST[1]}の詳細`);
    await expect(dialog.getByTestId('diagnosis')).toBeVisible();
    await waitForDrawerSettled(page);

    for (const name of ['前の観点', '次の観点', '観点の詳細を閉じる']) {
      const box = await dialog.getByRole('button', { name }).boundingBox();
      expect(box?.x ?? -1, name).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), name).toBeLessThanOrEqual(375);
    }
    const pageLink = await dialog.getByRole('link', { name: 'ページで開く' }).boundingBox();
    expect((pageLink?.x ?? 0) + (pageLink?.width ?? 0)).toBeLessThanOrEqual(375);
    expect(
      await dialog.locator('.drawer-head').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await dialog.getByRole('button', { name: '次の観点' }).click();
    await expect(drawer(page, `${SECOND[1]}の詳細`)).toBeVisible();
  });
});
