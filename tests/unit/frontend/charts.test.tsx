/** グラフの幾何（純粋関数）と、折れ線グラフ・レーダーチャートの描画の単体テスト。 */

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBucketLabel } from '../../../src/frontend/components/bucket-label.ts';
import {
  computeDomain,
  estimateTextWidth,
  formatTick,
  labelIndices,
  niceStep,
  niceTicks,
  radarDirections,
  radarLabelLayout,
  radarPoint,
  splitSegments,
  toLinePath,
  toPointsAttribute,
  unionRects,
} from '../../../src/frontend/components/chart-geometry.ts';
import { LineChart } from '../../../src/frontend/components/line-chart.tsx';
import { RadarChart } from '../../../src/frontend/components/radar-chart.tsx';
import { criterionBands } from '../../../src/shared/criteria-text.ts';
import { getDefaultCriteria } from '../../../src/backend/domain/evaluation/default-criteria.ts';

describe('computeDomain', () => {
  it('値の範囲の上下に、1割の余白を付ける', () => {
    expect(computeDomain([10, 20])).toEqual({ min: 9, max: 21 });
  });

  it.each([
    [[5], { min: 4, max: 6 }],
    [[100], { min: 90, max: 110 }],
    [[0], { min: -1, max: 1 }],
    [[-100, -100], { min: -110, max: -90 }],
  ])('値が1種類だけ（%j）でも、幅を持たせる', (values, expected) => {
    expect(computeDomain(values)).toEqual(expected);
  });
});

describe('目盛り', () => {
  it.each([
    [10, 4, 2],
    [100, 4, 20],
    [0.4, 4, 0.1],
    [3, 4, 1],
    [7000, 4, 2000],
    [40, 4, 10],
  ])('刻み幅: 範囲 %s を約 %s 分割 → %s', (range, count, expected) => {
    expect(niceStep(range, count)).toBeCloseTo(expected, 10);
  });

  it('範囲の中の、切りのよい値を返す（小数の誤差を含めない）', () => {
    expect(niceTicks({ min: 0.05, max: 0.35 }, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(niceTicks({ min: 9, max: 21 }, 4)).toEqual([10, 12, 14, 16, 18, 20]);
  });

  it.each([
    [10000, 5000, '10,000'],
    [0.2, 0.1, '0.2'],
    [1.5, 0.5, '1.5'],
    [20, 2, '20'],
    [0.003, 0.001, '0.003'],
  ])('目盛りの表示: %s（刻み %s）→ %s', (value, step, expected) => {
    expect(formatTick(value, step)).toBe(expected);
  });
});

describe('splitSegments', () => {
  it('欠損（null）で途切れる連続した区間ごとの添字を返す', () => {
    expect(splitSegments([1, 2, null, 3, null, null, 4, 5, 6])).toEqual([[0, 1], [3], [6, 7, 8]]);
    expect(splitSegments([null, null])).toEqual([]);
    expect(splitSegments([])).toEqual([]);
    expect(splitSegments([1, 2, 3])).toEqual([[0, 1, 2]]);
  });
});

describe('labelIndices', () => {
  it.each([
    [0, 8, []],
    [1, 8, [0]],
    [7, 8, [0, 1, 2, 3, 4, 5, 6]],
    [24, 8, [0, 3, 6, 9, 12, 15, 18, 21, 23]],
    [30, 8, [0, 4, 8, 12, 16, 20, 24, 28]],
    [90, 8, [0, 12, 24, 36, 48, 60, 72, 84]],
  ])('%s 区間（最大 %s ラベル）→ %j', (count, maxLabels, expected) => {
    expect(labelIndices(count, maxLabels)).toEqual(expected);
  });
});

describe('レーダーチャートの幾何', () => {
  it('軸は、真上から時計回りに等間隔', () => {
    const directions = radarDirections(4);

    expect(directions[0]?.x).toBeCloseTo(0, 10);
    expect(directions[0]?.y).toBeCloseTo(-1, 10);
    expect(directions[1]?.x).toBeCloseTo(1, 10);
    expect(directions[2]?.y).toBeCloseTo(1, 10);
    expect(directions[3]?.x).toBeCloseTo(-1, 10);
  });

  it('値の位置は、中心から半径の割合（範囲外は 0〜最大に収める）', () => {
    const center = { x: 100, y: 100 };
    const up = { x: 0, y: -1 };

    expect(radarPoint(up, 5, 5, center, 50)).toEqual({ x: 100, y: 50 });
    expect(radarPoint(up, 2.5, 5, center, 50)).toEqual({ x: 100, y: 75 });
    expect(radarPoint(up, 9, 5, center, 50)).toEqual({ x: 100, y: 50 });
    expect(radarPoint(up, -1, 5, center, 50)).toEqual({ x: 100, y: 100 });
  });

  it('座標を、SVG の属性の文字列にする', () => {
    const points = [
      { x: 1, y: 2 },
      { x: 3.14159, y: 4 },
    ];

    expect(toPointsAttribute(points)).toBe('1.0,2.0 3.1,4.0');
    expect(toLinePath(points)).toBe('M1.0,2.0 L3.1,4.0');
  });
});

describe('formatBucketLabel', () => {
  it('1時間ごとは日本時間の「時:分」、日ごとは「月/日」', () => {
    expect(formatBucketLabel('2026-10-09T03:00:00.000Z', 'HOUR')).toBe('12:00');
    expect(formatBucketLabel('2026-10-08T15:00:00.000Z', 'HOUR')).toBe('00:00');
    expect(formatBucketLabel('2026-10-08T15:00:00.000Z', 'DAY')).toBe('10/09');
  });
});

describe('LineChart', () => {
  const temperatureBands = criterionBands(
    getDefaultCriteria('environmentalAdaptability').criteria[0] ??
      (() => {
        throw new Error('テストの前提: 判断基準がある');
      })(),
  );
  const points = [
    { at: '2026-10-05T15:00:00.000Z', value: 20 },
    { at: '2026-10-06T15:00:00.000Z', value: 22 },
    { at: '2026-10-07T15:00:00.000Z', value: null },
    { at: '2026-10-08T15:00:00.000Z', value: 30 },
  ];

  function renderChart(overrides: Partial<Parameters<typeof LineChart>[0]> = {}) {
    return render(
      <LineChart
        title="温度"
        unit="℃"
        points={points}
        bucket="DAY"
        bands={temperatureBands}
        average={24}
        formatValue={(value) => `${String(value)}℃`}
        {...overrides}
      />,
    );
  }

  it('値のある区間を点で示し、連続する区間を線で結ぶ。欠損の区間では、線を途切れさせる', () => {
    const { container } = renderChart();

    expect(container.querySelectorAll('circle.chart-dot')).toHaveLength(3);
    // 連続する2点（20, 22）だけが線になる（30 は孤立した点）
    expect(container.querySelectorAll('path.chart-line')).toHaveLength(1);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      '温度の推移（3区間にデータあり）',
    );
    expect(container.querySelector('circle title')?.textContent).toBe('10/06: 20℃');
  });

  it('判断基準の帯（正常・注意・異常）と、平均の破線を描く。範囲外の帯は描かない', () => {
    const { container } = renderChart();

    const classes = [...container.querySelectorAll('rect.chart-band')].map((rect) =>
      rect.getAttribute('class'),
    );
    // 縦軸は約 19〜31 のため、正常（10〜25）・注意（25〜35）の帯のみ
    expect(classes).toEqual(['chart-band chart-band-normal', 'chart-band chart-band-caution']);
    expect(container.querySelector('[data-testid="chart-average-line"]')).not.toBeNull();
  });

  it('平均がなければ平均線を描かず、判断基準がなければ帯を描かない', () => {
    const { container } = renderChart({ average: null, bands: [] });

    expect(container.querySelector('[data-testid="chart-average-line"]')).toBeNull();
    expect(container.querySelectorAll('rect.chart-band')).toHaveLength(0);
  });

  it('1区間だけでも描ける（中央に1点）。線は引かない', () => {
    const { container } = renderChart({
      points: [{ at: '2026-10-08T15:00:00.000Z', value: 5 }],
      average: 5,
    });

    expect(container.querySelectorAll('circle.chart-dot')).toHaveLength(1);
    expect(container.querySelectorAll('path.chart-line')).toHaveLength(0);
  });

  it('左の余白は、縦軸の目盛りの文字の幅に合わせる（桁数の多い値でも、文字が切れず、少ない値でも、余計な隙間ができない）', () => {
    const plotLeft = (container: HTMLElement): number =>
      Number(container.querySelector('line.chart-axis')?.getAttribute('x1'));
    const small = renderChart({
      points: [
        { at: '2026-10-05T15:00:00.000Z', value: 20 },
        { at: '2026-10-06T15:00:00.000Z', value: 30 },
      ],
      bands: [],
    }).container;
    const large = renderChart({
      points: [
        { at: '2026-10-05T15:00:00.000Z', value: 20_000 },
        { at: '2026-10-06T15:00:00.000Z', value: 50_000 },
      ],
      bands: [],
    }).container;

    // 「20」（2文字）と「50,000」（6文字）: 余白の差は、4文字分
    expect(plotLeft(large) - plotLeft(small)).toBe(4 * 7);
    // 目盛りの文字の右端（軸の 8px 左）より左に、文字が収まる
    expect(plotLeft(small)).toBeGreaterThanOrEqual(2 * 7 + 8);
  });

  it('1時間ごとの横軸は、日本時間の時刻', () => {
    const hourly = Array.from({ length: 24 }, (_, index) => ({
      at: new Date(Date.parse('2026-10-08T04:00:00.000Z') + index * 3_600_000).toISOString(),
      value: index % 5 === 0 ? 10 + index : null,
    }));

    const { container } = renderChart({ points: hourly, bucket: 'HOUR', average: null });

    const labels = [...container.querySelectorAll('text.chart-axis-text')].map(
      (text) => text.textContent,
    );
    expect(labels).toContain('13:00');
  });
});

describe('RadarChart', () => {
  const axes = [
    { name: '収穫精度', score: 5 },
    { name: '収穫速度', score: 4 },
    { name: '環境適応性', score: null },
    { name: '操作性', score: 3 },
    { name: 'メンテナンス性', score: 2 },
    { name: 'コスト効率', score: 1 },
    { name: '安全性', score: 4 },
    { name: 'データ活用度合い', score: 5 },
    { name: '耐久性', score: null },
  ];

  it('入力済みの軸だけを結ぶ多角形と点を描き、未入力の軸は「未入力」と示す', () => {
    const { container } = render(<RadarChart axes={axes} max={5} />);

    expect(container.querySelectorAll('polygon.radar-ring')).toHaveLength(5);
    expect(container.querySelectorAll('line.radar-axis')).toHaveLength(9);
    expect(container.querySelectorAll('circle.radar-dot')).toHaveLength(7);
    expect(container.querySelectorAll('polygon.radar-area')).toHaveLength(1);
    expect(container.querySelectorAll('text.radar-label-missing')).toHaveLength(2);
    expect(container.querySelectorAll('tspan')).toHaveLength(2);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('7観点が入力済み');
  });

  it.each([
    [[5, null, null, null, null, null, null, null, null], 0, 0],
    [[5, 4, null, null, null, null, null, null, null], 1, 0],
    [[5, 4, 3, null, null, null, null, null, null], 0, 1],
  ])('入力済みが %j なら、折れ線 %s・多角形 %s', (scores, lines, polygons) => {
    const partial = axes.map((axis, index) => ({ ...axis, score: scores[index] ?? null }));

    const { container } = render(<RadarChart axes={partial} max={5} />);

    expect(container.querySelectorAll('polyline.radar-area')).toHaveLength(lines);
    expect(container.querySelectorAll('polygon.radar-area')).toHaveLength(polygons);
  });
});

describe('レーダーチャートのラベルの配置（幾何）', () => {
  const options = { radius: 150, offset: 18, fontSize: 14, sideThreshold: 0.3 };

  it('全角の文字は 1em、半角の文字は 0.6em で、幅を見積もる', () => {
    expect(estimateTextWidth('収穫精度', 14)).toBe(56);
    expect(estimateTextWidth('ab', 10)).toBeCloseTo(12);
  });

  it('真上の軸は、軸の先の上に中央揃え。左の軸は右揃え、右の軸は左揃えで、軸の先の横に置く', () => {
    const top = radarLabelLayout({ x: 0, y: -1 }, ['収穫精度'], options);
    expect(top.anchor).toBe('middle');
    expect(top.rect.bottom).toBeCloseTo(-168);
    expect(top.rect.left).toBeCloseTo(-28);
    expect(top.rect.right).toBeCloseTo(28);

    const left = radarLabelLayout({ x: -1, y: 0 }, ['データ活用度合い'], options);
    expect(left.anchor).toBe('end');
    expect(left.rect.right).toBeCloseTo(-168);
    expect(left.rect.left).toBeCloseTo(-168 - 112);
    expect(left.rect.top).toBeCloseTo(-left.rect.bottom);

    const right = radarLabelLayout({ x: 1, y: 0 }, ['操作性'], options);
    expect(right.anchor).toBe('start');
    expect(right.rect.left).toBeCloseTo(168);
  });

  it('真下の軸は、軸の先の下に置く。2行（未入力の注記）は、行の分だけ高くなる', () => {
    const one = radarLabelLayout({ x: 0, y: 1 }, ['安全性'], options);
    const two = radarLabelLayout({ x: 0, y: 1 }, ['安全性', '（未入力）'], options);
    expect(one.rect.top).toBeCloseTo(168);
    expect(two.rect.top).toBeCloseTo(168);
    expect(two.rect.bottom - two.rect.top).toBeCloseTo(2 * (one.rect.bottom - one.rect.top));
    expect(two.secondY).toBeGreaterThan(two.y);
  });

  it('範囲を、すべて含む1つの範囲にまとめる', () => {
    expect(
      unionRects([
        { left: -1, right: 2, top: 0, bottom: 5 },
        { left: 0, right: 3, top: -4, bottom: 1 },
      ]),
    ).toEqual({ left: -1, right: 3, top: -4, bottom: 5 });
  });
});

describe('RadarChart の表示の範囲（viewBox）と画面の幅', () => {
  const axes = [
    { name: '収穫精度', score: 5 },
    { name: 'データ活用度合い', score: null },
    { name: '耐久性', score: 3 },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
  });

  const viewBoxOf = (container: HTMLElement): number[] =>
    (container.querySelector('svg')?.getAttribute('viewBox') ?? '').split(' ').map(Number);

  it('文字の大きさを測れない環境（テスト環境）では、文字数からの見積もりで、表示の範囲を求める', () => {
    const { container } = render(<RadarChart axes={axes} max={5} />);

    const [x, y, width, height] = viewBoxOf(container);
    expect(width).toBeGreaterThan(300);
    expect(height).toBeGreaterThan(300);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
  });

  it('ブラウザで文字の範囲を測れるときは、測った範囲で、表示の範囲を求める', () => {
    (SVGElement.prototype as unknown as { getBBox: () => unknown }).getBBox = () => ({
      x: -400,
      y: -10,
      width: 800,
      height: 20,
    });

    const { container } = render(<RadarChart axes={axes} max={5} />);

    const [x, , width] = viewBoxOf(container);
    expect(x).toBe(-408);
    expect(width).toBe(816);
  });

  it('画面の幅が狭い（480px 以下）ときは、半径を小さくする', () => {
    const wide = viewBoxOf(render(<RadarChart axes={axes} max={5} />).container);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 480px'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const narrow = viewBoxOf(render(<RadarChart axes={axes} max={5} />).container);

    expect(narrow[2]).toBeLessThan(wide[2] ?? 0);
  });

  it('画面の幅が変わると、読み直す', () => {
    let listener: () => void = () => undefined;
    const list = {
      matches: false,
      addEventListener: (_type: string, callback: () => void) => {
        listener = callback;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', () => list);
    const { container } = render(<RadarChart axes={axes} max={5} />);
    const before = viewBoxOf(container);

    list.matches = true;
    act(() => {
      listener();
    });

    expect(viewBoxOf(container)[2]).toBeLessThan(before[2] ?? 0);
  });

  it('軸がなくても、表示の範囲は有限の値になる', () => {
    const { container } = render(<RadarChart axes={[]} max={5} />);

    expect(viewBoxOf(container).every((value) => Number.isFinite(value))).toBe(true);
  });
});
