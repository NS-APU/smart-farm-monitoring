/**
 * エラーバウンダリ。画面の描画の例外（データの形が想定と異なる場合など）で、アプリ全体が白紙にならないよう、
 * 「画面を表示できませんでした」と、ダッシュボードへの導線を表示する（V-063）。
 * 別の画面へ移動（URL の変更）すると、エラーを解除して、通常の表示に戻す。利用者には、内部情報を見せない
 * （原因は、React が、ブラウザのコンソールに出力する）。
 * 画面の部品（遅延読み込みのチャンク）の取得の失敗は、デプロイのあとに、古い画面を使い続けているときに起きる（Issue #323）。
 * 1 回だけ、自動で再読み込みし、続けて失敗するときは、「新しい版に更新されました」と、再読み込みのボタンを示す。
 * React の仕様上、エラーバウンダリはクラスコンポーネントでのみ実装できる（それ以外は、関数コンポーネントとフック）。
 */

import { Component, type ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import { isChunkLoadError, pageReloader, tryAutoReload } from '../lib/page-reload.ts';
import { PATHS } from '../router/paths.ts';
import { Link, useLocation } from '../router/router.tsx';
import { Icon } from './icon.tsx';

interface BoundaryProps {
  readonly children: ReactNode;
  /** 変わったら、エラーの状態を解除する（現在の位置）。 */
  readonly resetKey: string;
}

interface BoundaryState {
  readonly hasError: boolean;
  /** 画面の部品（チャンク）の取得の失敗か（古い画面。再読み込みで直る）。 */
  readonly isChunkError: boolean;
  readonly resetKey: string;
}

class RenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = {
    hasError: false,
    isChunkError: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { hasError: true, isChunkError: isChunkLoadError(error) };
  }

  override componentDidCatch(error: unknown): void {
    if (isChunkLoadError(error)) {
      tryAutoReload();
    }
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    // 別の画面へ移動したら、エラーを解除する
    return props.resetKey === state.resetKey
      ? null
      : { hasError: false, isChunkError: false, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    if (this.state.hasError && this.state.isChunkError) {
      return (
        <div role="alert" className="state-view state-error">
          <Icon name="status-error" size={20} />
          <p>{MESSAGES.common.updated}</p>
          <p>
            <button
              type="button"
              onClick={() => {
                pageReloader.reload();
              }}
            >
              {MESSAGES.common.retry}
            </button>
          </p>
        </div>
      );
    }
    if (this.state.hasError) {
      return (
        <div role="alert" className="state-view state-error">
          <Icon name="status-error" size={20} />
          <p>{MESSAGES.common.renderFailed}</p>
          <p>
            <Link to={PATHS.dashboard}>{MESSAGES.common.backToDashboard}</Link>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary(props: { readonly children: ReactNode }): ReactNode {
  const { pathname, search } = useLocation();
  return (
    <RenderErrorBoundary resetKey={`${pathname}?${search.toString()}`}>
      {props.children}
    </RenderErrorBoundary>
  );
}
