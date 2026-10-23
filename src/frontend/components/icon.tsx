/**
 * アイコン（自前の SVG。外部のアイコンライブラリ・フォントは使わない。ui-design-guidelines.md 7 章）。
 * 線幅・角丸・大きさをそろえる（24×24 の線のアイコン。線幅 1.8）。色は `currentColor`（文字の色）。
 * 装飾のため、読み上げの対象から外す（`aria-hidden`）。意味は、必ず、隣の文字が持つ。
 */

import type { ReactNode } from 'react';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';

const GLYPHS = {
  // 状態: 色だけに頼らず、形でも区別する（丸・三角・八角形・破線の丸）
  'status-normal': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.8L16.2 9.5" />
    </>
  ),
  'status-caution': (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.3" r="1" fill="currentColor" />
    </>
  ),
  'status-error': (
    <>
      <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" />
      <path d="M12 7.5v6" />
      <circle cx="12" cy="16.6" r="1.1" fill="currentColor" />
    </>
  ),
  'status-unknown': (
    <>
      <circle cx="12" cy="12" r="9" strokeDasharray="3.2 2.6" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.2 1-1.2 1.9" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </>
  ),
  // 案内（情報）。状態ではないため、状態の 4 つの形とは別の形（丸 + i）にする
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="1" fill="currentColor" />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

/** 観点のアイコン。全観点に、1 つずつ持つ（観点を足したときに、型の検査で気づける）。 */
const VIEWPOINT_GLYPHS = {
  // 的
  harvestAccuracy: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  // ストップウォッチ
  harvestSpeed: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 13.5V9.5M9.5 3h5M12 3v3M18.2 6.6l1.3-1.3" />
    </>
  ),
  // 温度計と葉
  environmentalAdaptability: (
    <>
      <path d="M9.5 5a2.5 2.5 0 0 1 5 0v8a4.2 4.2 0 1 1-5 0z" />
      <path d="M12 9.5v6" />
      <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
      <path d="M17.5 3.5c3 0 4 1.6 4 4.2-3 0-4.2-1.4-4-4.2z" />
    </>
  ),
  // 調整パネル（スライダー）
  operability: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h10M18 17h2" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  // スパナ
  maintainability: (
    <path d="M15.5 4.2a4.6 4.6 0 0 0-4.3 6.2L4.4 17.2a1.9 1.9 0 0 0 2.7 2.7l6.8-6.8a4.6 4.6 0 0 0 6.2-4.3l-3.1 1.3-2.1-2.1z" />
  ),
  // コイン（円）
  costEfficiency: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.8 7.8 12 12l3.2-4.2M12 12v5M9.6 13.4h4.8M9.6 15.4h4.8" />
    </>
  ),
  // 盾とチェック
  safety: (
    <>
      <path d="M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z" />
      <path d="m9 12 2.2 2.2L15.4 10" />
    </>
  ),
  // 棒グラフ
  dataUtilization: (
    <>
      <rect x="4" y="11" width="4" height="9" rx="1" />
      <rect x="10" y="4" width="4" height="16" rx="1" />
      <rect x="16" y="8" width="4" height="12" rx="1" />
    </>
  ),
  // バッテリー
  durability: (
    <>
      <rect x="3" y="8" width="16" height="9" rx="2" />
      <path d="M21 11v3M6.5 11v3M10 11v3M13.5 11v3" />
    </>
  ),
  // 笑顔
  satisfaction: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
      <path d="M8 14.2c1 1.8 2.4 2.8 4 2.8s3-1 4-2.8" />
    </>
  ),
} as const satisfies Record<ViewpointId, ReactNode>;

export type IconName = keyof typeof GLYPHS;

/** ステータスごとのアイコン。 */
export const STATUS_ICON: Readonly<Record<EvaluationStatus, IconName>> = {
  NORMAL: 'status-normal',
  CAUTION: 'status-caution',
  ERROR: 'status-error',
  UNKNOWN: 'status-unknown',
};

function Svg(props: {
  readonly name: string;
  readonly size: number;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <svg
      className="icon"
      data-icon={props.name}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export function Icon(props: { readonly name: IconName; readonly size?: number }): ReactNode {
  return (
    <Svg name={props.name} size={props.size ?? 18}>
      {GLYPHS[props.name]}
    </Svg>
  );
}

/**
 * 観点のアイコン（枠つき）。観点の名前の隣に置く。色は、状態の色と混ぜず、中立の 1 色にする。
 * 識別は `data-icon="viewpoint-<観点の ID>"`。
 */
export function ViewpointIcon(props: {
  readonly viewpointId: ViewpointId;
  readonly size?: number;
}): ReactNode {
  return (
    <span className="viewpoint-icon">
      <Svg name={`viewpoint-${props.viewpointId}`} size={props.size ?? 24}>
        {VIEWPOINT_GLYPHS[props.viewpointId]}
      </Svg>
    </span>
  );
}
