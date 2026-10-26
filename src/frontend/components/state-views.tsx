/** 読み込み中・エラー・空の状態の共通の表示。 */

import type { ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { HouseAndStrawberry } from './illustration.tsx';
import { Icon } from './icon.tsx';

/**
 * 空の状態（データがまだない・見つからない）。イラスト（装飾）と、何が起きているか・次に何をするかの文を示す。
 * 本文（children）に、文（p）と、次の操作への導線（リンク）を置く。
 */
export function EmptyState(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="state-view state-empty" data-testid={props.testId}>
      <HouseAndStrawberry width={96} />
      <div className="state-empty-body">{props.children}</div>
    </div>
  );
}

export function LoadingView(): ReactNode {
  return (
    <p role="status" className="state-view">
      {MESSAGES.common.loading}
    </p>
  );
}

/** エラーを、利用者向けのメッセージで表示する（内部情報は含めない）。 */
export function ErrorView(props: {
  readonly error: Error;
  readonly onRetry?: () => void;
}): ReactNode {
  const message =
    props.error instanceof ApiError ? props.error.message : MESSAGES.common.unexpectedError;
  return (
    <div role="alert" className="state-view state-error">
      <Icon name="status-error" size={20} />
      <p>{message}</p>
      {props.onRetry === undefined ? null : (
        <button type="button" onClick={props.onRetry}>
          {MESSAGES.common.retry}
        </button>
      )}
    </div>
  );
}
