/**
 * 小さなイラスト（イチゴとハウス。自前の SVG）。使う場面は、ログイン・空の状態・404 だけ（ui-design-guidelines.md 7 章）。
 * 業務の画面（ダッシュボードなど）には、使わない。装飾のため、読み上げの対象から外す。色は文字の色（`currentColor`）。
 */

import type { ReactNode } from 'react';

export function HouseAndStrawberry(props: { readonly width?: number }): ReactNode {
  const width = props.width ?? 120;
  return (
    <svg
      className="illustration"
      width={width}
      height={(width * 96) / 120}
      viewBox="0 0 120 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* 地面 */}
      <path d="M8 84h104" opacity=".5" />
      {/* ハウス（かまぼこ型の屋根） */}
      <path d="M14 84V46q0-26 38-26t38 26v38" />
      <path d="M14 46h76" opacity=".5" />
      <path d="M44 84V62h16v22" />
      {/* イチゴ（実・へた・種） */}
      <path
        d="M82 84c-9-4-14-12-14-19 0-6 5-9 14-9s14 3 14 9c0 7-5 15-14 19z"
        fill="currentColor"
        fillOpacity=".12"
      />
      <path d="M76 54c2-4 4-5 6-5s4 1 6 5" />
      <path d="M82 49v-5" />
      <circle cx="78" cy="64" r=".9" fill="currentColor" />
      <circle cx="85" cy="62" r=".9" fill="currentColor" />
      <circle cx="82" cy="70" r=".9" fill="currentColor" />
      <circle cx="88" cy="69" r=".9" fill="currentColor" />
    </svg>
  );
}
