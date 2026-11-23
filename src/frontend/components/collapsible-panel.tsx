/**
 * 観点の詳細の、折りたたみの欄（推移・元データ。SC-03-4）。既定は閉じる。見出し（h2）を押すと、開閉する。
 * `<details>` を使うため、キーボード（Tab で届き、Enter・Space で開閉）・読み上げに、標準で対応する。
 * 開閉の状態を、親が持つ（`open`・`onOpenChange`）と、期間・設備を切り替えて、欄が作り直されても、開いたままになる。
 * 親が持たなければ、ブラウザが持つ。全画面のページとドロワーで、同じ。
 */

import type { ReactNode } from 'react';

/** 折りたたみの欄の、開閉の状態（親が持つとき）。 */
export interface PanelOpenProps {
  readonly open?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}

export function CollapsiblePanel(
  props: PanelOpenProps & {
    readonly testId: string;
    readonly headingId: string;
    readonly title: string;
    readonly children: ReactNode;
  },
): ReactNode {
  const { onOpenChange } = props;
  return (
    <details
      className="panel collapsible-panel"
      data-testid={props.testId}
      open={props.open}
      onToggle={(event) => {
        onOpenChange?.(event.currentTarget.open);
      }}
    >
      <summary>
        <h2 id={props.headingId}>{props.title}</h2>
      </summary>
      <div className="collapsible-body">{props.children}</div>
    </details>
  );
}
