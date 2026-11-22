/**
 * 結果の通知（Issue #150 の方針 1）。保存・修正・削除・接続の確認などの結果を、文字で示す共通の部品。
 * `role="status"` で、スクリーンリーダーに知らせ、表示されたとき（現れた・変わったとき）に、画面内へスクロールする
 * （`useRevealOnChange`。フォーカスは動かさない）。見た目は、成功が完了メッセージ（`form-success`）、失敗が `form-error`
 * （どちらも、先頭に、形のアイコン。NFR-7.2）。失敗のうち、画面全体のエラーは、`FormError`（`role="alert"`）を使う。
 * `message` がなければ、何も表示しない。
 */

import type { ReactNode } from 'react';
import { useRevealOnChange } from '../hooks/use-reveal-on-change.ts';
import { Icon } from './icon.tsx';

export function ResultNotice(props: {
  readonly message: string | undefined;
  readonly testId: string;
  /** false なら、失敗の見た目（既定: 成功）。 */
  readonly ok?: boolean;
}): ReactNode {
  const ref = useRevealOnChange<HTMLParagraphElement>(props.message);
  if (props.message === undefined) {
    return null;
  }
  const ok = props.ok ?? true;
  return (
    <p
      ref={ref}
      role="status"
      className={ok ? 'form-success' : 'form-error'}
      data-testid={props.testId}
    >
      <Icon name={ok ? 'status-normal' : 'status-error'} size={16} />
      {props.message}
    </p>
  );
}
