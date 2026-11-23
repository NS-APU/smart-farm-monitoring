/**
 * メトリクスの推移の折れ線グラフ（SVG。UC-03、FR-6.5）。
 * 背景の帯は、判断基準の区分（正常・注意・異常。色だけに頼らないよう、凡例の文字でも示す）、
 * 破線は期間の平均値。区間にデータがない（欠損）ところは、線を途切れさせる（0 で代用しない）。
 * 点をタップ（クリック）・フォーカスすると、日時・値・状態を、グラフの下に表示する（SC-03-2。マウスを載せたときの `title` だけに頼らない）。
 * Tab で止まるのは 1 点だけで、矢印キー（←→・↑↓）・Home・End で、前後の点へ移る。
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { criterionStatusAt, type CriterionBand } from '@smart-farm/shared/criteria-text';
import { STATUS_LABELS } from '@smart-farm/shared/constants/status';
import type { SeriesPoint, SeriesResponse } from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { formatBucketFullLabel, formatBucketLabel } from './bucket-label.ts';
import {
  computeDomain,
  formatTick,
  labelIndices,
  niceStep,
  niceTicks,
  splitSegments,
  toLinePath,
  type Margin,
  type Point,
} from './chart-geometry.ts';

const WIDTH = 720;
const HEIGHT = 260;
const MAX_X_LABELS = 8;
/** 縦軸の目盛りの文字（12px）の、1文字あたりの幅（概算）。 */
const TICK_CHAR_WIDTH = 7;
/** 目盛りの文字と軸の間隔。 */
const TICK_LABEL_GAP = 8;
/** 目盛りの文字の左の余白。 */
const EDGE_PADDING = 8;

export interface LineChartProps {
  /** メトリクスの名前（グラフの説明に使う）。 */
  readonly title: string;
  readonly unit: string;
  readonly points: readonly SeriesPoint[];
  readonly bucket: SeriesResponse['bucket'];
  /** 判断基準の区分の範囲（背景の帯）。判断基準のない指標は空。 */
  readonly bands: readonly CriterionBand[];
  readonly average: number | null;
  /** 値の表示（点の説明）に使う整形。 */
  readonly formatValue: (value: number) => string;
}

export function LineChart(props: LineChartProps): ReactNode {
  const { points, bands, average } = props;
  const [selected, setSelected] = useState<number | null>(null);
  const pointRefs = useRef(new Map<number, SVGGElement>());
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const domain = computeDomain(values);
  const step = niceStep(domain.max - domain.min, 4);
  const ticks = niceTicks(domain, 4);
  const tickLabels = ticks.map((tick) => formatTick(tick, step));
  // 左の余白は、縦軸の目盛りの文字の幅に合わせる（グラフが、左右に偏らず、余計な隙間もできない）
  const longestTick = Math.max(...tickLabels.map((label) => label.length));
  const MARGIN: Margin = {
    top: 16,
    right: 24,
    bottom: 34,
    left: longestTick * TICK_CHAR_WIDTH + TICK_LABEL_GAP + EDGE_PADDING,
  };
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const xOf = (index: number): number =>
    MARGIN.left + (points.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1));
  const yOf = (value: number): number =>
    MARGIN.top + plotHeight * (1 - (value - domain.min) / (domain.max - domain.min));

  const plotted: (Point | null)[] = points.map((point, index) =>
    point.value === null ? null : { x: xOf(index), y: yOf(point.value) },
  );
  const segments = splitSegments(points.map((point) => point.value));

  // 値のある点だけを、選べる（矢印キーの移動も、欠損の区間は飛ばす）
  const selectable = points.flatMap((point, index) => (point.value === null ? [] : [index]));
  const tabbable = selected ?? selectable.at(-1);
  const moveTo = (index: number | undefined): void => {
    if (index !== undefined) {
      setSelected(index);
      pointRefs.current.get(index)?.focus();
    }
  };
  const onPointKeyDown = (event: KeyboardEvent<SVGGElement>, index: number): void => {
    const position = selectable.indexOf(index);
    const targets: Record<string, number | undefined> = {
      ArrowRight: selectable[position + 1],
      ArrowDown: selectable[position + 1],
      ArrowLeft: selectable[position - 1],
      ArrowUp: selectable[position - 1],
      Home: selectable[0],
      End: selectable.at(-1),
    };
    if (event.key in targets) {
      event.preventDefault();
      moveTo(targets[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(index);
    }
  };

  const selectedPoint = selected === null ? undefined : points[selected];
  const selectedValue = selectedPoint?.value ?? null;
  const selectedStatus = selectedValue === null ? null : criterionStatusAt(bands, selectedValue);

  return (
    <>
      <svg
        className="line-chart"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="group"
        aria-label={`${props.title}の推移（${String(values.length)}区間にデータあり）`}
      >
        {bands
          .filter((band) => band.to > domain.min && band.from < domain.max)
          .map((band) => {
            const top = yOf(Math.min(band.to, domain.max));
            const bottom = yOf(Math.max(band.from, domain.min));
            return (
              <rect
                key={`${band.status}-${String(band.from)}`}
                className={`chart-band chart-band-${band.status.toLowerCase()}`}
                x={MARGIN.left}
                y={top}
                width={plotWidth}
                height={bottom - top}
              />
            );
          })}

        {ticks.map((tick, tickIndex) => (
          <g key={tick}>
            <line
              className="chart-grid"
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
            />
            <text
              className="chart-axis-text"
              x={MARGIN.left - TICK_LABEL_GAP}
              y={yOf(tick)}
              textAnchor="end"
              dy="0.32em"
            >
              {tickLabels[tickIndex]}
            </text>
          </g>
        ))}

        {labelIndices(points.length, MAX_X_LABELS).map((index) => (
          <text
            key={points[index]?.at}
            className="chart-axis-text"
            x={xOf(index)}
            y={HEIGHT - MARGIN.bottom + 20}
            textAnchor="middle"
          >
            {formatBucketLabel(points[index]?.at ?? '', props.bucket)}
          </text>
        ))}
        <line
          className="chart-axis"
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={HEIGHT - MARGIN.bottom}
          y2={HEIGHT - MARGIN.bottom}
        />

        {average === null ? null : (
          <line
            className="chart-average"
            data-testid="chart-average-line"
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={yOf(average)}
            y2={yOf(average)}
          />
        )}

        {segments.map((segment) => {
          const segmentPoints = segment.flatMap((index) => {
            const point = plotted[index];
            return point === null || point === undefined ? [] : [point];
          });
          return segmentPoints.length > 1 ? (
            <path key={segment[0]} className="chart-line" d={toLinePath(segmentPoints)} />
          ) : null;
        })}

        {plotted.map((point, index) => {
          const source = points[index];
          if (point === null || source?.value === null || source === undefined) {
            return null;
          }
          const label = MESSAGES.viewpoint.chartPointLabel(
            formatBucketLabel(source.at, props.bucket),
            props.formatValue(source.value),
          );
          return (
            <g
              key={source.at}
              ref={(element) => {
                if (element === null) {
                  pointRefs.current.delete(index);
                } else {
                  pointRefs.current.set(index, element);
                }
              }}
              className="chart-point"
              role="button"
              tabIndex={index === tabbable ? 0 : -1}
              aria-label={label}
              aria-pressed={selected === index}
              onClick={() => {
                setSelected(index);
              }}
              onFocus={() => {
                setSelected(index);
              }}
              onKeyDown={(event) => {
                onPointKeyDown(event, index);
              }}
            >
              {/* 指で押しやすいよう、見えない大きな当たりを重ねる */}
              <circle className="chart-hit" cx={point.x} cy={point.y} r={12} />
              <circle className="chart-dot" cx={point.x} cy={point.y} r={3.5}>
                <title>{label}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="chart-readout" data-testid="chart-readout" aria-live="polite">
        {selectedPoint === undefined || selectedValue === null ? (
          <p className="muted">{MESSAGES.viewpoint.chartReadoutHint}</p>
        ) : (
          <dl>
            <div>
              <dt>{MESSAGES.viewpoint.chartReadoutTime}</dt>
              <dd>{formatBucketFullLabel(selectedPoint.at, props.bucket)}</dd>
            </div>
            <div>
              <dt>{MESSAGES.viewpoint.chartReadoutValue}</dt>
              <dd>{props.formatValue(selectedValue)}</dd>
            </div>
            <div>
              <dt>{MESSAGES.viewpoint.chartReadoutStatus}</dt>
              <dd>
                {selectedStatus === null
                  ? MESSAGES.viewpoint.noJudgement
                  : STATUS_LABELS[selectedStatus]}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </>
  );
}
