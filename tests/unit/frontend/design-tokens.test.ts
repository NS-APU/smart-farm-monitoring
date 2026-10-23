/**
 * デザイントークン（src/frontend/styles/app.css の :root とダークの上書き）の検査。
 * 方針は docs/10_design/functions/ui-design-guidelines.md の 5・6 章。
 * ライト・ダークの両方で、文字のコントラスト（4.5:1）・面や線のコントラスト（3:1）・
 * 状態の色の見分けやすさ（色覚シミュレーションで、CIEDE2000 の ΔE が 15 以上）を満たす。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(import.meta.dirname, '../../../src/frontend/styles/app.css'),
  'utf8',
);
const DARK_MARKER = '@media (prefers-color-scheme: dark)';

/** `--名前: 値;` の定義を集める（`#rrggbb` 以外の値は、色ではないものとして、そのまま記録する）。 */
function parseTokens(source: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of source.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim().toLowerCase());
    }
  }
  return tokens;
}

/** 色（`#rrggbb`）として扱える値か（transparent・rgb() などは、色として比べない）。 */
function isHex(value: string | undefined): value is string {
  return value !== undefined && /^#[0-9a-f]{6}$/.test(value);
}

const darkStart = css.indexOf(DARK_MARKER);
const lightTokens = parseTokens(css.slice(0, darkStart));
// ダークは、上書きしていないトークンを、ライトの値のまま使う
const darkTokens = new Map([...lightTokens, ...parseTokens(css.slice(darkStart))]);
const THEMES = [
  ['ライト', lightTokens],
  ['ダーク', darkTokens],
] as const;

type Rgb = readonly [number, number, number];

function toRgb(hex: string): Rgb {
  return [1, 3, 5].map(
    (index) => parseInt(hex.slice(index, index + 2), 16) / 255,
  ) as unknown as Rgb;
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** WCAG の相対輝度。 */
function luminance(hex: string): number {
  const [red, green, blue] = toRgb(hex).map(toLinear) as unknown as Rgb;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

// 色覚シミュレーション（Machado 2009。重症度 1.0。線形 RGB に適用する）
type Matrix = readonly [Rgb, Rgb, Rgb];
const VISIONS: readonly (readonly [string, Matrix | null])[] = [
  ['通常', null],
  [
    'P 型',
    [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
  ],
  [
    'D 型',
    [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.01182, 0.04294, 0.968881],
    ],
  ],
  [
    'T 型',
    [
      [1.255528, -0.076749, -0.178779],
      [-0.078411, 0.930809, 0.147602],
      [0.004733, 0.691367, 0.3039],
    ],
  ],
];

function simulate(hex: string, matrix: Matrix | null): Rgb {
  const linear = toRgb(hex).map(toLinear) as unknown as Rgb;
  if (matrix === null) {
    return toRgb(hex);
  }
  const mixed = matrix.map(
    (row) => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2],
  ) as unknown as Rgb;
  return mixed.map(fromLinear) as unknown as Rgb;
}

function toLab([red, green, blue]: Rgb): Rgb {
  const [r, g, b] = [red, green, blue].map(toLinear) as unknown as Rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000（Sharma et al. 2005 の実装に従う）。 */
function deltaE2000(first: Rgb, second: Rgb): number {
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  const rad = (degree: number): number => (degree * Math.PI) / 180;
  const deg = (radian: number): number => (radian * 180) / Math.PI;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = (deg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) {
      dhp -= 360;
    } else if (dhp < -180) {
      dhp += 360;
    }
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp / 2));
  const lMean = (l1 + l2) / 2;
  const cpMean = (c1p + c2p) / 2;
  let hMean = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) {
      hMean = (h1p + h2p) / 2;
    } else {
      hMean = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    }
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hMean - 30)) +
    0.24 * Math.cos(rad(2 * hMean)) +
    0.32 * Math.cos(rad(3 * hMean + 6)) -
    0.2 * Math.cos(rad(4 * hMean - 63));
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpMean ** 7 / (cpMean ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cpMean;
  const sh = 1 + 0.015 * cpMean * t;
  const rt = -Math.sin(rad(2 * dTheta)) * rc;
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
}

function pick(tokens: ReadonlyMap<string, string>, name: string): string {
  const value = tokens.get(name);
  if (!isHex(value)) {
    throw new Error(`色（#rrggbb）のトークンが見つかりません: ${name}`);
  }
  return value;
}

const STATUSES = ['normal', 'caution', 'error', 'unknown'] as const;

describe.each(THEMES)('デザイントークン（%s）', (_name, tokens) => {
  const surface = pick(tokens, 'color-surface');
  const background = pick(tokens, 'color-bg');

  it('文字は、面・背景に対して 4.5:1 以上のコントラスト（WCAG 1.4.3）', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['color-text', 'color-surface'],
      ['color-text', 'color-bg'],
      ['color-muted', 'color-surface'],
      ['color-muted', 'color-bg'],
      ['color-muted', 'color-surface-muted'],
      ['color-link', 'color-surface'],
      ['color-link', 'color-bg'],
      ['color-primary-ink', 'color-surface'],
      ['color-primary-text', 'color-primary'],
      ['color-nav-text', 'color-nav-bg'],
      ['color-nav-text', 'color-nav-current-bg'],
    ];
    for (const [foreground, back] of pairs) {
      expect(
        contrast(pick(tokens, foreground), pick(tokens, back)),
        `${foreground} / ${back}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('状態の文字は、面（タイル・バッジの塗り）の上で 4.5:1 以上のコントラスト', () => {
    for (const status of STATUSES) {
      // 「不明」のダークは、塗りなし（transparent。面の上に文字が載る）
      const declaredFill = tokens.get(`status-${status}-fill`);
      const fill = isHex(declaredFill) ? declaredFill : surface;
      expect(
        contrast(pick(tokens, `status-${status}-text`), surface),
        `${status} の文字 / 面`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(pick(tokens, `status-${status}-on`), fill),
        `${status} の塗りの上の文字`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(pick(tokens, `status-${status}-tile-on`), pick(tokens, `status-${status}-tile`)),
        `${status} のタイルの文字`,
      ).toBeGreaterThanOrEqual(4.5);
      // 広い面（注意書き・表のセル）: 文字と、その中のリンクが読める
      const soft = pick(tokens, `status-${status}-soft`);
      expect(
        contrast(pick(tokens, `status-${status}-soft-on`), soft),
        `${status} の控えめな面の上の文字`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(pick(tokens, 'color-link'), soft),
        `${status} の控えめな面の上のリンク`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('状態の主色・操作部品の枠・フォーカス・グラフの軸は、面・背景に対して 3:1 以上のコントラスト（WCAG 1.4.11）', () => {
    const names = [
      ...STATUSES.map((status) => `status-${status}-main`),
      'color-border-control',
      'color-focus',
      'color-chart-axis',
    ];
    for (const name of names) {
      const color = pick(tokens, name);
      expect(contrast(color, surface), `${name} / 面`).toBeGreaterThanOrEqual(3);
      expect(contrast(color, background), `${name} / 背景`).toBeGreaterThanOrEqual(3);
    }
  });

  it('4 つの状態の主色は、色覚シミュレーション（P 型・D 型・T 型）でも、ΔE 15 以上の差がある', () => {
    const colors = STATUSES.map(
      (status) => [status, pick(tokens, `status-${status}-main`)] as const,
    );
    for (const [firstIndex, [firstName, firstColor]] of colors.entries()) {
      for (const [secondName, secondColor] of colors.slice(firstIndex + 1)) {
        for (const [vision, matrix] of VISIONS) {
          const difference = deltaE2000(
            simulate(firstColor, matrix),
            simulate(secondColor, matrix),
          );
          expect(difference, `${firstName} - ${secondName}（${vision}）`).toBeGreaterThanOrEqual(
            15,
          );
        }
      }
    }
  });
});

describe('ダークの背景', () => {
  it('暗い緑にしない（正常の緑・不明の灰と、背景が似て見えないように、緑が突出しない中立の色にする）', () => {
    for (const name of [
      'color-bg',
      'color-surface',
      'color-surface-muted',
      'color-surface-subtle',
    ]) {
      const [red, green, blue] = toRgb(pick(darkTokens, name)).map((value) =>
        Math.round(value * 255),
      );
      expect((green ?? 0) - Math.max(red ?? 0, blue ?? 0), name).toBeLessThanOrEqual(2);
    }
  });

  it('ライトの値と区別できる（ダークの上書きが、実際に定義されている）', () => {
    expect(pick(darkTokens, 'color-bg')).not.toBe(pick(lightTokens, 'color-bg'));
    expect(pick(darkTokens, 'status-error-main')).not.toBe(pick(lightTokens, 'status-error-main'));
  });
});
