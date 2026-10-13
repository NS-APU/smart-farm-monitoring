/**
 * グラフの幾何（純粋関数）。折れ線グラフ・レーダーチャートの座標・目盛りを計算する。
 * 描画（SVG）は line-chart.tsx・radar-chart.tsx。グラフのライブラリは使わない（依存を増やさない）。
 */

import { formatThreshold } from '@smart-farm/shared/criteria-text';

export interface Margin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Domain {
  readonly min: number;
  readonly max: number;
}

/** 値の範囲（縦軸）。値が1種類だけの場合も、幅を持たせる。上下に1割の余白を付ける。 */
export function computeDomain(values: readonly number[]): Domain {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
}

/** 切りのよい刻み幅（1・2・5 × 10 のべき乗）。 */
export function niceStep(range: number, targetCount: number): number {
  const rough = range / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  // 目標の分割数に近い刻みになるよう、近い方の 1・2・5・10 に丸める
  const factor = normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10;
  return factor * magnitude;
}

/** 縦軸の目盛り（範囲の中の、切りのよい値）。 */
export function niceTicks(domain: Domain, targetCount: number): number[] {
  const step = niceStep(domain.max - domain.min, targetCount);
  const first = Math.ceil(domain.min / step);
  const last = Math.floor(domain.max / step);
  // 小数の誤差を避けるため、整数の倍数から値を作る
  return Array.from({ length: last - first + 1 }, (_, index) =>
    Number(((first + index) * step).toPrecision(12)),
  );
}

/** 目盛りの表示（刻み幅に応じた小数の桁数。3桁区切り）。 */
export function formatTick(value: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return formatThreshold(Number(value.toFixed(digits)));
}

/** 欠損（null）で途切れる連続した区間ごとの添字。 */
export function splitSegments(values: readonly (number | null)[]): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/** 横軸に、ラベルを付ける添字（多すぎないよう間引く。最後の区間はできるだけ付ける）。 */
export function labelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) {
    return [];
  }
  const step = Math.ceil(count / maxLabels);
  const indices: number[] = [];
  for (let index = 0; index < count; index += step) {
    indices.push(index);
  }
  const last = indices.at(-1) ?? 0;
  // 最後の区間が、直前のラベルから十分に離れていれば、付ける
  if (count - 1 - last >= Math.ceil(step / 2)) {
    indices.push(count - 1);
  }
  return indices;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** レーダーチャートの中心・半径・軸の数から、軸ごとの角度（真上から時計回り）の単位ベクトルを返す。 */
export function radarDirections(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
}

/** 値（0〜max）の位置。 */
export function radarPoint(
  direction: Point,
  value: number,
  max: number,
  center: Point,
  radius: number,
): Point {
  const ratio = Math.min(Math.max(value / max, 0), 1);
  return { x: center.x + direction.x * radius * ratio, y: center.y + direction.y * radius * ratio };
}

/** 座標の列を、SVG の points 属性の文字列にする。 */
export function toPointsAttribute(points: readonly Point[]): string {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** 座標の列を、SVG のパス（折れ線）にする。 */
export function toLinePath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
}

export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export type LabelAnchor = 'start' | 'middle' | 'end';

/** レーダーチャートの軸ラベル（原点＝チャートの中心）。 */
export interface RadarLabelLayout {
  readonly anchor: LabelAnchor;
  readonly x: number;
  /** 1行目の文字の基準線の位置。 */
  readonly y: number;
  /** 2行目（「未入力」の注記）の基準線の位置。 */
  readonly secondY: number;
  /** ラベルが占める範囲の見積もり。 */
  readonly rect: Rect;
}

export interface RadarLabelOptions {
  readonly radius: number;
  readonly offset: number;
  readonly fontSize: number;
  /** ラベルを、左右どちらの端に寄せるかの境目（軸の向きの横成分）。 */
  readonly sideThreshold: number;
}

/** 行の高さ（文字の大きさに対する倍率）。 */
const LINE_HEIGHT_RATIO = 1.3;
/** 行の上端から、文字の基準線までの距離（文字の大きさに対する倍率）。 */
const BASELINE_RATIO = 1.03;
/** 英数字・記号の幅（全角の文字の幅に対する倍率）。 */
const NARROW_CHAR_RATIO = 0.6;

/** 文字列の幅の見積もり。全角の文字は 1em、半角の文字は 0.6em とする。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce(
    (sum, char) => sum + (char.charCodeAt(0) < 0x100 ? NARROW_CHAR_RATIO : 1) * fontSize,
    0,
  );
}

/**
 * 軸ラベルの位置と範囲を求める。真上・真下に近い軸は、ラベルを軸の先の上・下に置き、
 * 左右に近い軸は、軸の先の横に置く（左側は右揃え、右側は左揃え）。
 * 範囲は、ラベルが SVG の枠から切れない大きさと、チャート全体の左右・上下の偏りを揃えるために使う。
 */
export function radarLabelLayout(
  direction: Point,
  lines: readonly string[],
  options: RadarLabelOptions,
): RadarLabelLayout {
  const { radius, offset, fontSize, sideThreshold } = options;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const height = lineHeight * lines.length;
  const x = direction.x * (radius + offset);
  const anchorY = direction.y * (radius + offset);
  const anchor: LabelAnchor =
    direction.x > sideThreshold ? 'start' : direction.x < -sideThreshold ? 'end' : 'middle';
  const top =
    direction.y > 0.5 ? anchorY : direction.y < -0.5 ? anchorY - height : anchorY - height / 2;
  const width = Math.max(...lines.map((line) => estimateTextWidth(line, fontSize)));
  const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  return {
    anchor,
    x,
    y: top + fontSize * BASELINE_RATIO,
    secondY: top + lineHeight + fontSize * BASELINE_RATIO,
    rect: { left, right: left + width, top, bottom: top + height },
  };
}

/** 範囲を、すべて含む1つの範囲にまとめる。 */
export function unionRects(rects: readonly Rect[]): Rect {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}
