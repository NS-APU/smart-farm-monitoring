/**
 * 負荷テスト（モバイル・タブレット幅での、大量データの表示）: 大量の合成データの状態で、主要な画面を、375px・768px の幅で開き、
 * スクリーンショットを保存する（`test-result/stress/screenshots/`。目視で、レイアウト（隙間・被り・偏り・はみ出し）を確認する）。
 * 応答時間の計測は行わない（許容時間の判定の対象外）。横にはみ出していないこと（ページの横スクロールがないこと）は、機械的に確認する。
 */

import { expect, test, type Page } from '@playwright/test';
import { STRESS_USER } from './support/scale.ts';
import { fillLogin, loadingView, screenshot } from './support/ui.ts';

const SCREENS = [
  { name: 'dashboard', path: '/', heading: 'ダッシュボード' },
  { name: 'viewpoint', path: '/viewpoints/environmentalAdaptability', heading: '環境適応性' },
  { name: 'satisfaction', path: '/satisfaction', heading: '満足度の詳細' },
  { name: 'observations', path: '/observations', heading: '取り込み済みデータ' },
  { name: 'notifications', path: '/notifications', heading: '通知' },
  { name: 'entry-list', path: '/data-entry/list', heading: '入力済みデータ' },
  { name: 'equipment', path: '/settings/equipment', heading: '設備' },
  { name: 'status-codes', path: '/settings/status-codes', heading: 'ステータスコード' },
  { name: 'users', path: '/settings/users', heading: 'ユーザー' },
] as const;

const VIEWPORTS = [
  { label: '375', width: 375, height: 667 },
  { label: '768', width: 768, height: 1024 },
] as const;

/** ページの横スクロールがない（文書の幅が、表示の幅に収まる）。 */
async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, `${label}: ページが横にはみ出していない`).toBeLessThanOrEqual(
    widths.client + 1,
  );
}

test('モバイル・タブレット幅（375px・768px）での、大量データの表示: 主要な画面が、横にはみ出さず、表示できる', async ({
  page,
}) => {
  await page.goto('/login');
  await fillLogin(page, STRESS_USER.userId);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(screen.heading);
      await expect(loadingView(page)).toHaveCount(0);
      const label = `${screen.name}（${viewport.label}px）`;
      await expectNoHorizontalScroll(page, label);
      await screenshot(page, `40-mobile-${viewport.label}-${screen.name}`);
    }
  }
});
