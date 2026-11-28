/**
 * 観点の詳細の、右からのドロワー（Issue #357。ui-design-guidelines.md 8 章）。ダッシュボードのカード・観点別の状態の表から開く。
 * ダッシュボードの上に重ねて表示し、ダッシュボードは、描画したまま保つ（スクロール位置・選択・期間が、閉じたあとも保たれる）。
 * - 閉じる: ✕・Esc・背面（スクリーン）を押す・ブラウザの「戻る」。開いている間は、本文のスクロールを固定し、フォーカスをドロワーの中に閉じ込める
 * - 閉じたら、開いた要素（カードのリンク）へ、フォーカスを戻す
 * - 幅は、`min(880px, 100vw)`。900px 以下は、全画面（styles/app.css）
 * - 前の観点・次の観点（SC-03-6）: ダッシュボードの観点の並びで、前後の観点へ切り替える（URL の `viewpoint` を差し替える。期間・対象の設備は保つ）。
 *   最初・最後では、片方を無効にする。観点の並びが分からない間（ダッシュボードの読み込み中）は、出さない
 * - 中身は、全画面のページと同じ（観点の詳細。満足度は、満足度の詳細）。「ページで開く」で、全画面のページへ移れる
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { PeriodDays } from '@smart-farm/shared/constants/status';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import { MESSAGES } from '../i18n/messages.ts';
import { SatisfactionView } from '../pages/satisfaction-page.tsx';
import { ViewpointDetailView } from '../pages/viewpoint-detail-page.tsx';
import { viewpointDrawerPath } from '../router/paths.ts';
import { Link, navigate } from '../router/router.tsx';
import { Icon } from './icon.tsx';

/** フォーカスを受けられる要素（ドロワーの中で、Tab の移動を閉じ込める範囲を決める）。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function ViewpointDrawer(props: {
  readonly viewpointId: string;
  /** 全画面のページのパス（「ページで開く」の移動先）。 */
  readonly pagePath: string;
  /** ダッシュボードの観点の並び（前後の観点の順）。読み込み前は空。 */
  readonly viewpointIds: readonly string[];
  /** 選んでいる期間（前後の観点へ引き継ぐ）。 */
  readonly selectedPeriodDays: PeriodDays | undefined;
  readonly onClose: () => void;
}): ReactNode {
  const { viewpointId, pagePath, viewpointIds, selectedPeriodDays, onClose } = props;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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

  // 観点を切り替えたら、先頭から読めるように、本文のスクロールを戻す
  useEffect(() => {
    if (bodyRef.current !== null) {
      bodyRef.current.scrollTop = 0;
    }
  }, [viewpointId]);

  const index = viewpointIds.indexOf(viewpointId);
  const previousId = index > 0 ? viewpointIds[index - 1] : undefined;
  const nextId = index >= 0 ? viewpointIds[index + 1] : undefined;
  // 切り替えは、履歴を積まず（「戻る」で、ドロワーを閉じられる）、同じ画面の中で行う
  const moveTo = (targetId: string | undefined): void => {
    if (targetId !== undefined) {
      navigate(viewpointDrawerPath(targetId, selectedPeriodDays), { replace: true });
    }
  };
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
          {index < 0 ? null : (
            <nav className="drawer-nav" aria-label={MESSAGES.viewpoint.drawer.navLabel}>
              <button
                type="button"
                className="drawer-nav-button"
                aria-disabled={previousId === undefined}
                onClick={() => {
                  moveTo(previousId);
                }}
              >
                <span aria-hidden="true">←</span>
                {MESSAGES.viewpoint.drawer.previous}
              </button>
              <button
                type="button"
                className="drawer-nav-button"
                aria-disabled={nextId === undefined}
                onClick={() => {
                  moveTo(nextId);
                }}
              >
                {MESSAGES.viewpoint.drawer.next}
                <span aria-hidden="true">→</span>
              </button>
            </nav>
          )}
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
        <div ref={bodyRef} className="drawer-body">
          {viewpointId === 'satisfaction' ? (
            <SatisfactionView key={viewpointId} variant="drawer" />
          ) : (
            <ViewpointDetailView key={viewpointId} viewpointId={viewpointId} variant="drawer" />
          )}
        </div>
      </aside>
    </>
  );
}
