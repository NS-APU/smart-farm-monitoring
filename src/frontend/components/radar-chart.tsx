/**
 * 満足度のレーダーチャート（SVG。UC-21、FR-6.9）。満足度以外の9観点の 1〜5 スターを、軸ごとに示す。
 * 未入力の軸は、点を打たず、ラベルに「未入力」と示す（0 で代用しない）。多角形は、入力済みの軸だけを結ぶ。
 *
 * 表示の範囲（viewBox）は、チャート本体と、軸のラベルの範囲に合わせて求める（原点＝チャートの中心）。
 * ラベルの範囲は、描画したあとに、ブラウザで実際の文字の大きさを測って求める（フォントによって幅が違うため）。
 * 測れない環境では、文字数からの見積もりを使う。ラベルが切れず、左右・上下の余白が揃い、余計な隙間ができない。
 * 画面の幅が狭い（スマートフォン）ときは、半径を小さくして、ラベルの文字が読める大きさのまま収める。
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/use-media-query.ts';
import { MESSAGES } from '../i18n/messages.ts';
import {
  radarDirections,
  radarLabelLayout,
  radarPoint,
  toPointsAttribute,
  unionRects,
  type Point,
  type Rect,
} from './chart-geometry.ts';

const CENTER: Point = { x: 0, y: 0 };
/** 軸ラベルの文字の大きさ（viewBox の単位）。 */
const LABEL_FONT_SIZE = 14;
const SCALE_FONT_SIZE = 12;
/** ラベルを、左右どちらの端に寄せるかの境目（軸の向きの横成分）。 */
const SIDE_THRESHOLD = 0.3;
/** 表示の範囲の外側の余白（viewBox の単位）。 */
const FRAME_PADDING = 8;
/** 画面の幅が狭いと見なす条件（この幅以下で、小さいチャートにする）。 */
const COMPACT_QUERY = '(max-width: 480px)';

const PROFILES = {
  normal: { radius: 150, offset: 18 },
  compact: { radius: 90, offset: 16 },
} as const;

export interface RadarAxis {
  readonly name: string;
  /** 1〜max。未入力は null。 */
  readonly score: number | null;
}

export interface RadarChartProps {
  readonly axes: readonly RadarAxis[];
  /** 目盛りの最大値（スターの最大）。 */
  readonly max: number;
}

/** チャート本体（最も外側の多角形）の範囲。 */
function outlineRect(count: number, radius: number): Rect {
  if (count === 0) {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  const points = radarDirections(count).map((direction) =>
    radarPoint(direction, 1, 1, CENTER, radius),
  );
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

export function RadarChart(props: RadarChartProps): ReactNode {
  const { axes, max } = props;
  const compact = useMediaQuery(COMPACT_QUERY);
  const { radius, offset } = compact ? PROFILES.compact : PROFILES.normal;
  const svgRef = useRef<SVGSVGElement>(null);
  /** ブラウザで測った、チャート本体とラベルの範囲。測れない環境では、null（見積もりを使う）。 */
  const [measured, setMeasured] = useState<Rect | null>(null);
  const directions = radarDirections(axes.length);
  const rings = Array.from({ length: max }, (_, index) => index + 1);
  const missingNote = `（${MESSAGES.satisfaction.notEntered}）`;

  const entered = axes.flatMap((axis, index) => {
    const direction = directions[index];
    return axis.score === null || direction === undefined
      ? []
      : [radarPoint(direction, axis.score, max, CENTER, radius)];
  });

  // 描画したあとに、ラベルの実際の範囲を測る（再計算は、軸・画面の幅が変わったときだけ）
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null || typeof svg.getBBox !== 'function') {
      return;
    }
    const boxes = [...svg.querySelectorAll<SVGTextElement>('text.radar-label')].map((text) => {
      const box = text.getBBox();
      return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
    });
    setMeasured(unionRects([...boxes, outlineRect(axes.length, radius)]));
  }, [axes, radius]);

  const labels = axes.flatMap((axis, index) => {
    const direction = directions[index];
    return direction === undefined
      ? []
      : [
          {
            axis,
            layout: radarLabelLayout(
              direction,
              axis.score === null ? [axis.name, missingNote] : [axis.name],
              { radius, offset, fontSize: LABEL_FONT_SIZE, sideThreshold: SIDE_THRESHOLD },
            ),
          },
        ];
  });
  const frame =
    measured ??
    unionRects([...labels.map(({ layout }) => layout.rect), outlineRect(axes.length, radius)]);
  const viewBox = [
    frame.left - FRAME_PADDING,
    frame.top - FRAME_PADDING,
    frame.right - frame.left + 2 * FRAME_PADDING,
    frame.bottom - frame.top + 2 * FRAME_PADDING,
  ]
    .map((value) => value.toFixed(1))
    .join(' ');

  return (
    <svg
      ref={svgRef}
      className="radar-chart"
      viewBox={viewBox}
      role="img"
      aria-label={`${MESSAGES.satisfaction.radar}（${String(entered.length)}観点が入力済み）`}
    >
      {rings.map((ring) => (
        <polygon
          key={ring}
          className="radar-ring"
          points={toPointsAttribute(
            directions.map((direction) => radarPoint(direction, ring, max, CENTER, radius)),
          )}
        />
      ))}
      {directions.map((direction, index) => (
        <line
          key={axes[index]?.name}
          className="radar-axis"
          x1={CENTER.x}
          y1={CENTER.y}
          x2={CENTER.x + direction.x * radius}
          y2={CENTER.y + direction.y * radius}
        />
      ))}
      {rings.map((ring) => (
        <text
          key={ring}
          className="radar-scale"
          fontSize={SCALE_FONT_SIZE}
          x={CENTER.x + 6}
          y={CENTER.y - (radius * ring) / max}
          dy="-0.2em"
        >
          {ring}
        </text>
      ))}

      {entered.length >= 3 ? (
        <polygon className="radar-area" points={toPointsAttribute(entered)} />
      ) : null}
      {entered.length === 2 ? (
        <polyline className="radar-area" points={toPointsAttribute(entered)} />
      ) : null}
      {axes.map((axis, index) => {
        const direction = directions[index];
        if (axis.score === null || direction === undefined) {
          return null;
        }
        const point = radarPoint(direction, axis.score, max, CENTER, radius);
        return (
          <circle key={axis.name} className="radar-dot" cx={point.x} cy={point.y} r={4}>
            <title>{`${axis.name}: ${String(axis.score)}`}</title>
          </circle>
        );
      })}

      {labels.map(({ axis, layout }) => (
        <text
          key={axis.name}
          className={axis.score === null ? 'radar-label radar-label-missing' : 'radar-label'}
          fontSize={LABEL_FONT_SIZE}
          x={layout.x}
          y={layout.y}
          textAnchor={layout.anchor}
        >
          {axis.name}
          {axis.score === null ? (
            <tspan x={layout.x} y={layout.secondY}>
              {missingNote}
            </tspan>
          ) : null}
        </text>
      ))}
    </svg>
  );
}
