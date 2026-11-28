/**
 * 未登録のコード値の一覧（SC-12-5。Issue #158。管理者のみ）。取り込みで、定義にないコード値として記録した値を、件数の多い順に示し、
 * 行の「登録」で、ステータスコードの登録のダイアログを開く（コード値は、登録の初期値の案にする）。
 * 自動では更新しない（費用方針。手動の「更新」で読み直す）。データの取得は、親が持つ（登録・修正・削除のあとに、親が読み直すため）。
 */

import { useState, type ReactNode } from 'react';
import type {
  UnregisteredStatusCode,
  UnregisteredStatusCodeListResponse,
} from '@smart-farm/shared/schemas/status-code';
import type { PollingState } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { formatDateTimeJst } from './format.ts';
import { Icon } from './icon.tsx';
import { EmptyState, ErrorView, LoadingView } from './state-views.tsx';

const TEXT = MESSAGES.statusCodes.unregistered;

export interface UnregisteredStatusCodesPanelProps {
  readonly polling: PollingState<UnregisteredStatusCodeListResponse>;
  /** 「登録」を押した行。登録できる形式の行だけ、押せる。 */
  readonly onRegister: (item: UnregisteredStatusCode) => void;
}

function Row(props: {
  readonly item: UnregisteredStatusCode;
  readonly onRegister: (item: UnregisteredStatusCode) => void;
}): ReactNode {
  const { item } = props;
  // 登録するコード値は、取り込んだ値のままでなければ、取り込みで一致しない（大文字化などの案で登録しても、この値は有効にならない）
  const canRegister = item.isRegistrable;
  return (
    <tr data-testid="unregistered-row" data-code={item.code}>
      <td data-label={MESSAGES.statusCodes.code}>{item.code}</td>
      <td data-label={TEXT.count}>{TEXT.countValue(item.count)}</td>
      <td data-label={TEXT.lastSeenAt}>
        <time dateTime={item.lastSeenAt}>{formatDateTimeJst(item.lastSeenAt)}</time>
      </td>
      <td data-label={MESSAGES.statusCodes.actions}>
        {canRegister ? (
          <div className="row-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                props.onRegister(item);
              }}
            >
              {TEXT.register}
            </button>
          </div>
        ) : (
          <>
            <span>{TEXT.unregistrable}</span>
            <span className="muted category-note">{TEXT.unregistrableNote}</span>
            {item.suggestedCode === undefined ? null : (
              <span className="muted category-note">
                {TEXT.unregistrableExample(item.suggestedCode)}
              </span>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

export function UnregisteredStatusCodesPanel(props: UnregisteredStatusCodesPanelProps): ReactNode {
  const { data, error, reload, version } = props.polling;
  // 手動の更新: 押した時点の取得の回数を覚え、取得が完了する（回数が変わる）まで、更新中にする（ダッシュボードと同じ）
  const [refreshFrom, setRefreshFrom] = useState<number | null>(null);
  const refreshing = refreshFrom !== null && refreshFrom === version;
  const refresh = (): void => {
    if (!refreshing) {
      setRefreshFrom(version);
      reload();
    }
  };

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    body = (
      <EmptyState testId="unregistered-codes-empty">
        <p>{TEXT.empty}</p>
      </EmptyState>
    );
  } else {
    body = (
      <div className="table-scroll">
        <table className="data-table card-table unregistered-table">
          <thead>
            <tr>
              <th scope="col">{MESSAGES.statusCodes.code}</th>
              <th scope="col">{TEXT.count}</th>
              <th scope="col">{TEXT.lastSeenAt}</th>
              <th scope="col">{MESSAGES.statusCodes.actions}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <Row key={item.code} item={item} onRegister={props.onRegister} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="panel" aria-label={TEXT.title} data-testid="unregistered-codes">
      <h2>{TEXT.title}</h2>
      <p className="muted">{TEXT.lead}</p>
      <p className="muted">{TEXT.effectNote}</p>
      <div className="table-toolbar">
        <button
          type="button"
          className="refresh-button"
          aria-disabled={refreshing}
          aria-busy={refreshing}
          onClick={refresh}
        >
          <Icon name="refresh" size={16} />
          {refreshing ? TEXT.refreshing : TEXT.refresh}
        </button>
        <span className="muted">{TEXT.refreshNote}</span>
      </div>
      {body}
    </section>
  );
}
