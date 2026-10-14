/**
 * シナリオ: スマートフォン幅（375px）・タブレット幅（768px）で、主要な画面が、横にはみ出さず、重ならず、操作できる
 * （NFR-7.1・NFR-7.3。レビュー V-103・V-158）。デスクトップ幅（1280px）だけでは、モバイルの表示崩れを見つけられないため、
 * 現場で最もよく使う画面（ダッシュボード・観点の詳細・データ入力・通知・取り込み済みデータ・設備・取り込み設定）を、両方の幅で開く。
 * 各画面は、`shot`（横スクロール・重なり・はみ出しの検査つきのスクリーンショット）で確認する。
 * 観点の詳細の元データの表は、長い設備名（200文字）でも、列が1文字ずつ折り返すほど潰れないことを確認する（V-158）。
 */

import { expect, test, type Page } from '@playwright/test';
import { alignBrowserClock, apiOk, openAs, prepareApp, HOUSE_ID } from './support/app.ts';
import {
  environmentData,
  harvestAccuracyData,
  merge,
  seed,
} from './support/viewpoint-scenarios.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const LONG_NAME = '収穫ロボットの非常に長い名称'.repeat(15).slice(0, 200);

const SCREENS: readonly { name: string; path: string; heading: string }[] = [
  { name: 'dashboard', path: '/', heading: 'ダッシュボード' },
  { name: 'viewpoint', path: '/viewpoints/environmentalAdaptability', heading: '環境適応性' },
  { name: 'data-entry', path: '/data-entry', heading: 'データ入力' },
  { name: 'notifications', path: '/notifications', heading: '通知' },
  { name: 'observations', path: '/observations', heading: '取り込み済みデータ' },
  { name: 'equipment', path: '/settings/equipment', heading: '設備' },
  { name: 'ingestion', path: '/settings/ingestion', heading: '取り込み設定' },
  { name: 'entry-list', path: '/data-entry/list', heading: '入力済みデータ' },
  { name: 'entry-history', path: '/data-entry/history', heading: '変更履歴' },
  { name: 'status-codes', path: '/settings/status-codes', heading: 'ステータスコード' },
  { name: 'users', path: '/settings/users', heading: 'ユーザー' },
];

async function prepareData(request: Parameters<typeof prepareApp>[0]): Promise<void> {
  await prepareApp(request);
  await apiOk(request, 'POST', '/equipment', {
    equipmentId: 'ROBOT-LONG',
    equipmentType: 'ROBOT',
    name: LONG_NAME,
    facilityId: HOUSE_ID,
    externalId: 'ROBOT-LONG-EXT',
  });
  await seed(
    request,
    merge(environmentData(), harvestAccuracyData('NORMAL'), {
      observations: [
        {
          equipmentId: 'ROBOT-LONG',
          itemKey: 'harvestCount',
          observedAt: '2026-10-09T02:00:00.000Z',
          value: 123456789012,
        },
      ],
    }),
  );
}

async function visit(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(heading);
  await expect(page.getByRole('banner')).toBeVisible();
}

for (const viewport of [
  { label: '375', width: 375, height: 667 },
  { label: '768', width: 768, height: 1024 },
]) {
  test.describe(`${viewport.label}px 幅`, () => {
    test('主要な画面が、横にはみ出さず、重ならずに表示できる', async ({
      page,
      request,
    }, testInfo) => {
      await prepareData(request);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await alignBrowserClock(page);
      await openAs(page, '/');

      for (const screen of SCREENS) {
        await visit(page, screen.path, screen.heading);
        await shot(page, testInfo, `responsive-${viewport.label}-${screen.name}`);
      }
    });

    test('観点の詳細の元データの表は、長い設備名・桁の多い値でも、列が潰れず、表の枠の中で横にスクロールできる', async ({
      page,
      request,
    }, testInfo) => {
      await prepareData(request);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await alignBrowserClock(page);
      await openAs(page, '/viewpoints/harvestAccuracy');
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('収穫精度');

      const table = page.locator('table.source-table');
      await expect(table).toBeVisible();
      await expect(table.getByText(LONG_NAME.slice(0, 20), { exact: false }).first()).toBeVisible();
      // 列が、1文字ずつ折り返すほど押しつぶされない（見出しの高さが、1〜2行に収まる）
      const headerHeights = await table
        .getByRole('columnheader')
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
      expect(Math.max(...headerHeights)).toBeLessThan(64);
      await shot(page, testInfo, `responsive-${viewport.label}-source-table`);
    });
  });
}
