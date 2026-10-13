/**
 * UC-21 満足度をレーダーチャートで確認する（SC-04。FR-5.1、FR-6.9）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、満足度の詳細画面を開く
 *               2. システムが、各観点の満足度をレーダーチャートで表示する
 *   代替フロー  満足度が入力されていない観点がある場合の表示（暫定: 総合満足度は「不明」とし、未入力の観点を示して、入力を促す）
 *   事後条件    農作業者が、観点別の満足度を把握している
 *   事前条件    満足度が入力されている（UC-06・UC-07。満足度以外の各観点に対する 1〜5 スター）
 *
 * 値の同値分割: 総合満足度（9観点の平均。小数第1位）の判定（4.0以上 正常／3.0以上4.0未満 注意／3.0未満 異常。境界: 4.0・3.0・3.9・2.9）、
 * 入力の状態（すべて入力・一部が未入力・まったく未入力）、スター（1〜5 の境界）、期間（当日・7・30・60・90日。期間外の入力は使わない）、
 * 入力の回数（1回・複数回の平均）、利用者（入力する人・見る人。別のブラウザ）。
 * 関連するユースケース: UC-07（満足度の入力）、UC-01（ダッシュボードのカードから）、UC-19（判断基準の変更）、UC-10（満足度の通知）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  USER_B,
  addEntry,
  apiOk,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import { fillEntryForm, saveEntry } from './support/entry.ts';
import { daysAgo, hoursAgo, shot } from './support/viewpoint-scenarios.ts';
import { expectNoHorizontalScroll } from './support/pages.ts';

const VIEWPOINTS = [
  ['harvestAccuracy', '収穫精度'],
  ['harvestSpeed', '収穫速度'],
  ['environmentalAdaptability', '環境適応性'],
  ['operability', '操作性'],
  ['maintainability', 'メンテナンス性'],
  ['costEfficiency', 'コスト効率'],
  ['safety', '安全性'],
  ['dataUtilization', 'データ活用度合い'],
  ['durability', '耐久性'],
] as const;

/** 満足度の入力（ハウス）。scores は、9観点の順（収穫精度 … 耐久性）。null は、その観点を入力しない。 */
async function enterSatisfaction(
  request: Parameters<typeof prepareApp>[0],
  scores: readonly (number | null)[],
  observedAt: string = hoursAgo(1),
): Promise<void> {
  const items: Record<string, number> = {};
  VIEWPOINTS.forEach(([viewpointId], index) => {
    const score = scores[index];
    if (score !== undefined && score !== null) {
      items[`satisfaction.${viewpointId}`] = score;
    }
  });
  if (Object.keys(items).length === 0) {
    return; // まったく入力しない（項目がない入力は、登録できない）
  }
  await addEntry(request, { equipmentId: HOUSE_ID, category: 'SATISFACTION', observedAt, items });
}

async function openSatisfaction(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/satisfaction${query}`);
  await expect(page.getByRole('heading', { name: /満足度の詳細/, level: 1 })).toBeVisible();
}

const overallScore = (page: Page) => page.getByTestId('overall-score');
const overallBadge = (page: Page) =>
  page.getByRole('heading', { level: 1 }).locator('.status-badge');

test.describe('基本フロー: 満足度の詳細を開き、各観点の満足度を、レーダーチャートで確認する', () => {
  test('満足度を入力（UC-07）し、ダッシュボードの満足度のカードから詳細を開くと、総合満足度（小数第1位）・判断基準・レーダーチャート・観点別のスターを表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // UC-07: 9観点の満足度を、データ入力の画面で入力する
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    const stars = [5, 4, 4, 3, 5, 4, 4, 3, 4];
    await fillEntryForm(page, {
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: '2026-10-09T11:00',
      items: Object.fromEntries(
        VIEWPOINTS.map(([, name], index) => [`満足度（${name}）`, String(stars[index])]),
      ),
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();

    // 1. 満足度の詳細画面を開く（ダッシュボードのカードから）
    await page
      .getByTestId('entry-result')
      .getByRole('link', { name: 'ダッシュボードで確認' })
      .click();
    await page.getByTestId('card-satisfaction').locator('h3').getByRole('link').click();

    // 2. 各観点の満足度を、レーダーチャートで表示する
    await expect(page).toHaveURL(/\/satisfaction/);
    await expect(overallScore(page)).toHaveText('4.0');
    await expect(overallBadge(page)).toContainText('正常');
    await expect(page.getByLabel('判断基準')).toContainText('4.0以上');
    await expect(page.getByLabel('判断基準')).toContainText('3.0以上4.0未満');
    await expect(page.getByLabel('判断基準')).toContainText('3.0未満');
    const radar = page.getByTestId('radar').locator('svg.radar-chart');
    await expect(radar).toBeVisible();
    await expect(radar).toHaveAttribute('aria-label', /9観点が入力済み/);
    await expect(radar.locator('polygon.radar-ring')).toHaveCount(5);
    await expect(radar.locator('line.radar-axis')).toHaveCount(9);
    await expect(radar.locator('circle.radar-dot')).toHaveCount(9);
    await expect(radar.locator('polygon.radar-area')).toHaveCount(1);
    await expect(radar.locator('text.radar-label')).toHaveText(VIEWPOINTS.map(([, name]) => name));
    // 観点別のスター
    for (const [index, [viewpointId]] of VIEWPOINTS.entries()) {
      await expect(page.getByTestId(`score-${viewpointId}`).getByRole('img')).toHaveAttribute(
        'aria-label',
        `${String(stars[index])} / 5`,
      );
    }
    await shot(page, testInfo, 'uc21-radar');
  });

  test('総合満足度は、9観点の平均（小数第1位）。観点ごとのスター（1〜5）は、★と☆の数で示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [5, 5, 5, 5, 5, 5, 5, 5, 4]);

    await openSatisfaction(page);

    // (5×8 + 4) ÷ 9 = 4.888… → 4.9
    await expect(overallScore(page)).toHaveText('4.9');
    await expect(page.getByTestId('score-durability')).toContainText('★★★★☆');
    await expect(page.getByTestId('score-harvestAccuracy')).toContainText('★★★★★');
  });
});

test.describe('総合満足度の判定（4.0以上 正常／3.0以上4.0未満 注意／3.0未満 異常）の同値分割と境界値', () => {
  const partitions: readonly { name: string; scores: number[]; overall: string; status: string }[] =
    [
      {
        name: 'すべて 5（最高）',
        scores: [5, 5, 5, 5, 5, 5, 5, 5, 5],
        overall: '5.0',
        status: '正常',
      },
      {
        name: 'すべて 4（平均 4.0。正常の下限）',
        scores: [4, 4, 4, 4, 4, 4, 4, 4, 4],
        overall: '4.0',
        status: '正常',
      },
      {
        name: '平均 3.89（表示は 3.9。4.0 未満のため、注意）',
        scores: [4, 4, 4, 4, 4, 4, 4, 4, 3],
        overall: '3.9',
        status: '注意',
      },
      {
        name: 'すべて 3（平均 3.0。注意の下限）',
        scores: [3, 3, 3, 3, 3, 3, 3, 3, 3],
        overall: '3.0',
        status: '注意',
      },
      {
        name: '平均 2.89（表示は 2.9。3.0 未満のため、異常）',
        scores: [3, 3, 3, 3, 3, 3, 3, 3, 2],
        overall: '2.9',
        status: '異常',
      },
      {
        name: 'すべて 1（最低）',
        scores: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        overall: '1.0',
        status: '異常',
      },
    ];

  for (const item of partitions) {
    test(`${item.name}: 総合満足度 ${item.overall}・${item.status}`, async ({ page, request }) => {
      await prepareApp(request);
      await enterSatisfaction(request, item.scores);

      await openSatisfaction(page);

      await expect(overallScore(page)).toHaveText(item.overall);
      await expect(overallBadge(page)).toContainText(item.status);
      await expect(page.getByTestId('satisfaction-missing')).toHaveCount(0);
      await page.goto('/');
      await expect(page.getByTestId('card-satisfaction').locator('.status-badge')).toContainText(
        item.status,
      );
    });
  }
});

test.describe('代替フロー: 満足度が入力されていない観点がある場合は、不明とし、未入力の観点を示して、入力を促す', () => {
  test('一部の観点が未入力: 総合満足度は「不明」。未入力の観点を一覧し、レーダーチャートの該当の軸は、点を打たず「未入力」と示し、データ入力への導線を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // 収穫精度・収穫速度・環境適応性・操作性・メンテナンス性・コスト効率・安全性 は入力。データ活用度合い・耐久性 が未入力
    await enterSatisfaction(request, [5, 5, 5, 5, 5, 5, 5, null, null]);

    await openSatisfaction(page);

    await expect(overallScore(page)).toHaveText('—');
    await expect(overallBadge(page)).toContainText('不明');
    const missing = page.getByTestId('satisfaction-missing');
    await expect(missing).toContainText('未入力の観点があります');
    await expect(missing).toContainText('データ活用度合い、耐久性');
    await expect(missing.getByRole('link', { name: 'データ入力へ' })).toHaveAttribute(
      'href',
      '/data-entry',
    );
    const radar = page.getByTestId('radar').locator('svg.radar-chart');
    await expect(radar).toHaveAttribute('aria-label', /7観点が入力済み/);
    await expect(radar.locator('circle.radar-dot')).toHaveCount(7);
    await expect(radar.locator('text.radar-label-missing')).toHaveCount(2);
    await expect(page.getByTestId('score-durability')).toContainText('未入力');
    await expect(page.getByTestId('score-harvestAccuracy')).toContainText('★★★★★');
    await shot(page, testInfo, 'uc21-missing');
  });

  test('1つの観点だけが未入力でも、不明（入力済みの8観点だけの平均は使わない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [5, 5, 5, 5, 5, 5, 5, 5, null]);

    await openSatisfaction(page);

    await expect(overallScore(page)).toHaveText('—');
    await expect(overallBadge(page)).toContainText('不明');
    await expect(page.getByTestId('satisfaction-missing')).toContainText('耐久性');
  });

  test('まったく入力されていない: 評価は不明で、9観点すべてが未入力。入力済みの点を持たない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openSatisfaction(page);

    await expect(overallBadge(page)).toContainText('不明');
    await expect(page.getByTestId('satisfaction-missing')).toContainText('収穫精度、収穫速度');
    const radar = page.getByTestId('radar').locator('svg.radar-chart');
    await expect(radar.locator('circle.radar-dot')).toHaveCount(0);
    await expect(radar.locator('text.radar-label-missing')).toHaveCount(9);
  });

  test('未入力の観点を入力すると、不明が解消し、総合満足度を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [4, 4, 4, 4, 4, 4, 4, 4, null]);
    await openSatisfaction(page);
    await expect(overallBadge(page)).toContainText('不明');

    await enterSatisfaction(
      request,
      [null, null, null, null, null, null, null, null, 4],
      hoursAgo(0.5),
    );
    await page.reload();

    await expect(overallScore(page)).toHaveText('4.0');
    await expect(page.getByTestId('satisfaction-missing')).toHaveCount(0);
  });
});

test.describe('スター（1〜5）の境界と、入力の回数・期間', () => {
  test('スターの最小（1）と最大（5）が混在しても、レーダーチャートに表示できる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [1, 5, 1, 5, 1, 5, 1, 5, 1]);

    await openSatisfaction(page);

    await expect(overallScore(page)).toHaveText('2.8');
    await expect(page.getByTestId('radar').locator('circle.radar-dot')).toHaveCount(9);
    await expect(page.getByTestId('score-harvestAccuracy')).toContainText('★☆☆☆☆');
    await expect(page.getByTestId('score-harvestSpeed')).toContainText('★★★★★');
  });

  test('同じ観点を複数回入力すると、期間内の平均になる（5 と 3 → 4）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [5, 4, 4, 4, 4, 4, 4, 4, 4], hoursAgo(3));
    await enterSatisfaction(request, [3, 4, 4, 4, 4, 4, 4, 4, 4], hoursAgo(2));

    await openSatisfaction(page);

    await expect(page.getByTestId('score-harvestAccuracy').getByRole('img')).toHaveAttribute(
      'aria-label',
      '4 / 5',
    );
    await expect(overallScore(page)).toHaveText('4.0');
  });

  test('期間（当日・7日・30日…）を選ぶと、その期間の入力だけで集計する（期間外の入力は使わない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 20日前に、すべて 5。今日（1時間前）に、すべて 3
    await enterSatisfaction(request, [5, 5, 5, 5, 5, 5, 5, 5, 5], daysAgo(20));
    await enterSatisfaction(request, [3, 3, 3, 3, 3, 3, 3, 3, 3], hoursAgo(1));
    await openSatisfaction(page);
    await expect(page.getByTestId('overall-score')).toHaveText('3.0');

    await page.getByLabel('長期の期間').selectOption({ label: '直近30日' });

    await expect(page).toHaveURL(/periodDays=30/);
    await expect(overallScore(page)).toHaveText('4.0');
    await page.getByLabel('長期の期間').selectOption({ label: '当日' });
    await expect(overallScore(page)).toHaveText('3.0');
    await page.getByLabel('長期の期間').selectOption({ label: '直近7日' });
    await expect(overallScore(page)).toHaveText('3.0');
    // 60日・90日は、20日前の入力（5）も含めるため、平均（5 と 3）は 4.0
    await page.getByLabel('長期の期間').selectOption({ label: '直近60日' });
    await expect(overallScore(page)).toHaveText('4.0');
    await page.getByLabel('長期の期間').selectOption({ label: '直近90日' });
    await expect(overallScore(page)).toHaveText('4.0');
  });
});

test.describe('対象の設備', () => {
  test('満足度はハウスの評価。ロボット・センサーを選ぶと、評価しない旨を表示し、ハウスの選び直しを案内する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await enterSatisfaction(request, [4, 4, 4, 4, 4, 4, 4, 4, 4]);
    await openSatisfaction(page);

    await page.getByRole('banner').getByLabel('対象の設備').selectOption('ROBOT-01');

    await expect(page.getByTestId('not-applicable')).toContainText(
      'ハウスまたは対象の設備を選び直してください',
    );
    await expect(page.getByTestId('not-applicable')).toContainText(
      'この設備では評価しない観点です',
    );
    await page.getByRole('banner').getByLabel('対象の設備').selectOption(HOUSE_ID);
    await expect(overallScore(page)).toHaveText('4.0');
  });
});

test.describe('シナリオ: 利用者Aが満足度を入力し、利用者Bがレーダーチャートで確認し、Bの追加の入力が反映される（UC-07 → UC-21。複数ユーザー）', () => {
  test('Aの入力を、Bが確認する。Bが追加で入力すると、Aの画面の平均（2.5・総合 3.8）が変わる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    // 利用者A: 満足度を入力する（UI）
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, {
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: '2026-10-09T10:00',
      items: Object.fromEntries(VIEWPOINTS.map(([, name]) => [`満足度（${name}）`, '4'])),
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();

    // 利用者B: レーダーチャートで確認する
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/satisfaction', USER_B);
    await expect(overallScore(b.page)).toHaveText('4.0');
    await expect(b.page.getByTestId('radar').locator('circle.radar-dot')).toHaveCount(9);
    await shot(b.page, testInfo, 'uc21-user-b');
    // 利用者B: 収穫精度の評価を 1 つ追加で入力する（別の時刻）
    await advanceMinutes(request, 1);
    await b.page.goto('/data-entry');
    await fillEntryForm(b.page, {
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: '2026-10-09T11:00',
      items: { '満足度（収穫精度）': '1' },
    });
    await saveEntry(b.page);
    await expect(b.page.getByTestId('entry-result')).toBeVisible();

    // 利用者A: 再読み込みで、収穫精度の平均（4 と 1 → 2.5）が反映される
    await page.goto('/satisfaction');
    await expect(page.getByTestId('score-harvestAccuracy').getByRole('img')).toHaveAttribute(
      'aria-label',
      '2.5 / 5',
    );
    // 平均は小数。スターは四捨五入（3つ）し、平均の値（2.5）を添える
    await expect(page.getByTestId('score-harvestAccuracy')).toContainText('★★★☆☆（2.5）');
    // (2.5 + 4×8) ÷ 9 = 3.83… → 3.8
    await expect(overallScore(page)).toHaveText('3.8');
    await b.context.close();
  });
});

// ---------------------------------------------------------------------------
// 長い設備名（200 文字）・極端な値（全観点が最高・最低・未入力）・画面の幅（1280・768・375px）でも、
// レーダーチャートのラベルが切れず・重ならず・左右上下に偏らず、読める大きさで表示される（NFR-7.3）
// ---------------------------------------------------------------------------

const LONG_NAME_JAPANESE = '長い設備名'.repeat(40);
const LONG_NAME_ASCII = 'E'.repeat(200);

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface RadarMeasure {
  readonly svg: Box & { readonly width: number };
  readonly labels: readonly (Box & { readonly name: string; readonly fontSize: number })[];
  readonly content: Box;
  readonly panel: Box;
}

/** レーダーチャートの SVG と、ラベル・チャート本体の位置・大きさ（画面上の px）を測る。 */
async function measureRadar(page: Page): Promise<RadarMeasure> {
  return page.evaluate((): RadarMeasure => {
    const svg = document.querySelector<SVGSVGElement>('svg.radar-chart');
    const panel = document.querySelector('[data-testid="radar"]');
    if (svg === null || panel === null) {
      throw new Error('レーダーチャートがありません');
    }
    const toBox = (rect: DOMRect): Box => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
    const box = svg.getBoundingClientRect();
    const scale = box.width / svg.viewBox.baseVal.width;
    const labels = [...svg.querySelectorAll('text.radar-label')].map((text) => ({
      name: text.textContent,
      ...toBox(text.getBoundingClientRect()),
      fontSize: parseFloat(getComputedStyle(text).fontSize) * scale,
    }));
    const outer = [...svg.querySelectorAll('polygon.radar-ring')].at(-1)?.getBoundingClientRect();
    const rects: Box[] = [...labels, ...(outer === undefined ? [] : [toBox(outer)])];
    return {
      svg: { ...toBox(box), width: box.width },
      labels,
      content: {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
        top: Math.min(...rects.map((rect) => rect.top)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      },
      panel: toBox(panel.getBoundingClientRect()),
    };
  });
}

/**
 * レーダーチャートの描画の検査。
 * - すべてのラベルが SVG の枠の中にあり、切れない
 * - ラベルどうしが重ならない
 * - ラベルが、読める大きさ（画面上で 10px 以上）で表示される
 * - チャート本体（外枠の多角形とラベル）が、SVG の枠の中で、左右・上下に偏らない（余白の差が、幅・高さの 3% 以内）
 * - チャート本体が、SVG の枠の幅の 8 割以上を占め、余計な隙間がない
 */
async function expectRadarIntact(page: Page): Promise<void> {
  const m = await measureRadar(page);
  const height = m.svg.bottom - m.svg.top;
  for (const label of m.labels) {
    expect(label.left, `${label.name} の左端`).toBeGreaterThanOrEqual(m.svg.left - 0.5);
    expect(label.right, `${label.name} の右端`).toBeLessThanOrEqual(m.svg.right + 0.5);
    expect(label.top, `${label.name} の上端`).toBeGreaterThanOrEqual(m.svg.top - 0.5);
    expect(label.bottom, `${label.name} の下端`).toBeLessThanOrEqual(m.svg.bottom + 0.5);
    expect(label.fontSize, `${label.name} の文字の大きさ`).toBeGreaterThanOrEqual(10);
  }
  for (const [i, a] of m.labels.entries()) {
    for (const b of m.labels.slice(i + 1)) {
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(overlapX > 1 && overlapY > 1, `${a.name} と ${b.name} の重なり`).toBe(false);
    }
  }
  const leftGap = m.content.left - m.svg.left;
  const rightGap = m.svg.right - m.content.right;
  const topGap = m.content.top - m.svg.top;
  const bottomGap = m.svg.bottom - m.content.bottom;
  expect(
    Math.abs(leftGap - rightGap),
    `左右の余白 ${String(leftGap)} / ${String(rightGap)}`,
  ).toBeLessThanOrEqual(m.svg.width * 0.03);
  expect(
    Math.abs(topGap - bottomGap),
    `上下の余白 ${String(topGap)} / ${String(bottomGap)}`,
  ).toBeLessThanOrEqual(height * 0.03);
  expect(m.content.right - m.content.left, 'チャートの幅').toBeGreaterThanOrEqual(
    m.svg.width * 0.8,
  );
}

/** 長い設備名でも、ヘッダー・ページの幅の中に収まり、観点別の表が潰れない。 */
async function expectPageFits(page: Page): Promise<void> {
  const label = await page.locator('.header-field > span').boundingBox();
  expect(label?.height ?? 0, '「対象の設備」のラベルの高さ').toBeLessThan(30);
  const select = await page.locator('.header-field select').boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect((select?.x ?? 0) + (select?.width ?? 0)).toBeLessThanOrEqual(width);
  const meta = await page.locator('.page-meta').boundingBox();
  expect((meta?.x ?? 0) + (meta?.width ?? 0), '対象の設備名の右端').toBeLessThanOrEqual(width);
  // 観点別の表（観点名・スター）が、1 文字幅へ潰れず、パネルの枠の中に収まる
  const rowHeights = await page
    .locator('.score-table tbody tr')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(Math.max(...rowHeights), `観点別の表の行の高さ ${String(rowHeights)}`).toBeLessThan(70);
  const table = await page.locator('.score-table').boundingBox();
  const panel = await page.getByTestId('radar').boundingBox();
  expect((table?.x ?? 0) + (table?.width ?? 0)).toBeLessThanOrEqual(
    (panel?.x ?? 0) + (panel?.width ?? 0),
  );
  await expectNoHorizontalScroll(page);
}

const SATISFACTION_VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

const EXTREME_CASES: readonly {
  name: string;
  slug: string;
  equipmentName: string;
  scores: readonly (number | null)[];
  status: string;
}[] = [
  {
    name: '日本語の設備名200文字（上限）・全観点が最高（5。正常）',
    slug: 'ja-all5',
    equipmentName: LONG_NAME_JAPANESE,
    scores: [5, 5, 5, 5, 5, 5, 5, 5, 5],
    status: '正常',
  },
  {
    name: '区切りのない英字の設備名200文字（上限）・全観点が最低（1。異常）',
    slug: 'ascii-all1',
    equipmentName: LONG_NAME_ASCII,
    scores: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    status: '異常',
  },
  {
    name: '日本語の設備名200文字（上限）・全観点が未入力（不明）',
    slug: 'ja-none',
    equipmentName: LONG_NAME_JAPANESE,
    scores: [null, null, null, null, null, null, null, null, null],
    status: '不明',
  },
  {
    name: '1〜5 が混在・最後の観点だけ未入力（不明）',
    slug: 'mixed-missing',
    equipmentName: 'ハウス1',
    scores: [1, 5, 1, 5, 1, 5, 1, 5, null],
    status: '不明',
  },
];

for (const viewport of SATISFACTION_VIEWPORTS) {
  test.describe(`${viewport.name}: 長い設備名・極端な値でも、レーダーチャートのラベルが切れず・重ならず・偏らない`, () => {
    for (const item of EXTREME_CASES) {
      test(item.name, async ({ page, request }, testInfo) => {
        await prepareApp(request);
        await apiOk(request, 'PUT', `/equipment/${HOUSE_ID}`, { name: item.equipmentName });
        await enterSatisfaction(request, item.scores);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        await openSatisfaction(page);

        await expect(overallBadge(page)).toContainText(item.status);
        await expect(page.getByTestId('radar').locator('text.radar-label')).toHaveCount(9);
        await expectPageFits(page);
        await expectRadarIntact(page);
        await shot(page, testInfo, `uc21-extreme-${String(viewport.width)}-${item.slug}`);
      });
    }
  });
}
