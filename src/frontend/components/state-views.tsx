/** 読み込み中・エラー・空の状態の共通の表示。 */

import type { ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from './icon.tsx';

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
