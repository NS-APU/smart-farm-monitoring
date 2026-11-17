/**
 * 観点の詳細の、右からのドロワー（Issue #357。ui-design-guidelines.md 8 章）。ダッシュボードのカード・観点別の状態の表から開く。
 * ダッシュボードの上に重ねて表示し、ダッシュボードは、描画したまま保つ（スクロール位置・選択・期間が、閉じたあとも保たれる）。
 * - 閉じる: ✕・Esc・背面（スクリーン）を押す・ブラウザの「戻る」。開いている間は、本文のスクロールを固定し、フォーカスをドロワーの中に閉じ込める
 * - 閉じたら、開いた要素（カードのリンク）へ、フォーカスを戻す
 * - 幅は、`min(880px, 100vw)`。900px 以下は、全画面（styles/app.css）
 * - 中身は、全画面のページと同じ（観点の詳細。満足度は、満足度の詳細）。「ページで開く」で、全画面のページへ移れる
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import { MESSAGES } from '../i18n/messages.ts';
import { SatisfactionView } from '../pages/satisfaction-page.tsx';
import { ViewpointDetailView } from '../pages/viewpoint-detail-page.tsx';
import { Link } from '../router/router.tsx';
import { Icon } from './icon.tsx';

/** フォーカスを受けられる要素（ドロワーの中で、Tab の移動を閉じ込める範囲を決める）。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function ViewpointDrawer(props: {
  readonly viewpointId: string;
  /** 全画面のページのパス（「ページで開く」の移動先）。 */
  readonly pagePath: string;
  readonly onClose: () => void;
}): ReactNode {
  const { viewpointId, pagePath, onClose } = props;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 閉じる処理は、親が毎回作り直すため、最新のものを参照する（キーボードの購読を、張り直さない）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 開いている間: 開いた要素を覚え、閉じるボタンへフォーカスを移す。Esc で閉じ、Tab の移動を中に閉じ込める。閉じたら、フォーカスを戻す
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    document.body.classList.add('drawer-open');
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== 'Tab' || dialog === null) {
        return;
      }
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items.at(0);
      const last = items.at(-1);
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('drawer-open');
      if (opener !== null && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  const name = findViewpointMeta(viewpointId)?.name ?? MESSAGES.nav.dashboard;
  return (
    <>
      <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={MESSAGES.viewpoint.drawer.label(name)}
        className="viewpoint-drawer"
        data-testid="viewpoint-drawer"
      >
        <div className="drawer-head">
          <Link to={pagePath} className="drawer-page-link">
            {MESSAGES.viewpoint.drawer.openAsPage}
          </Link>
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            aria-label={MESSAGES.viewpoint.drawer.close}
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="drawer-body">
          {viewpointId === 'satisfaction' ? (
            <SatisfactionView variant="drawer" />
          ) : (
            <ViewpointDetailView viewpointId={viewpointId} variant="drawer" />
          )}
        </div>
      </aside>
    </>
  );
}
