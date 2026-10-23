/**
 * アイコン（自前の SVG。外部のアイコンライブラリ・フォントは使わない。ui-design-guidelines.md 7 章）。
 * 線幅・角丸・大きさをそろえる（24×24 の線のアイコン。線幅 1.8）。色は `currentColor`（文字の色）。
 * 装飾のため、読み上げの対象から外す（`aria-hidden`）。意味は、必ず、隣の文字が持つ。
 */

import type { ReactNode } from 'react';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';

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
} as const satisfies Record<string, ReactNode>;

export type IconName = keyof typeof GLYPHS;

/** ステータスごとのアイコン。 */
export const STATUS_ICON: Readonly<Record<EvaluationStatus, IconName>> = {
  NORMAL: 'status-normal',
  CAUTION: 'status-caution',
  ERROR: 'status-error',
  UNKNOWN: 'status-unknown',
};

export function Icon(props: { readonly name: IconName; readonly size?: number }): ReactNode {
  const size = props.size ?? 18;
  return (
    <svg
      className="icon"
      data-icon={props.name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[props.name]}
    </svg>
  );
}
