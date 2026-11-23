/**
 * 通知一覧（SC-05）の、通知ごとの経過・回復日時・メモ（Issue #159 の SC-05-1。ADR-0019 の D-42）。
 * - 回復日時（`NotificationRecovery`）: 状態変化の通知に、「11:20 に回復（20 分）」または「未回復」を、常に示す。経過を示せない通知（`progress` が
 *   null・状態変化ではない通知）には、出さない
 * - 経過・メモ（`NotificationDetails`）: 開閉できる欄（既定は閉じる）。経過（「11:00 異常 → 11:20 正常 → 11:40 異常」。通知の日と違う日の時刻は、
 *   月/日つき）と、メモ（共有・追記のみ。入力者〔「ユーザー名（ID）」〕・日時つき）。メモは、欄を開いたときに読み込み、追記できる（手動入力と同じ権限 `manual-entry:write`）
 * 推奨アクションは、一覧に載せない（リンク先の観点の詳細で確認する）。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABELS } from '@smart-farm/shared/constants/status';
import {
  NotificationMemoInputSchema,
  type NotificationItem,
  type NotificationMemoView,
} from '@smart-farm/shared/schemas/notification';
import { addNotificationMemo, listNotificationMemos } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePermission } from '../hooks/use-permission.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { userLabel } from '../lib/user-label.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { Field, FormError } from './form-controls.tsx';
import { formatDateTimeJst, formatElapsed, formatShortDateTimeJst } from './format.ts';
import { ResultNotice } from './result-notice.tsx';

const TEXT = MESSAGES.notifications;

/** 回復日時。経過を示せない通知（`progress` が null・なし）には、何も出さない。 */
export function NotificationRecovery(props: { readonly item: NotificationItem }): ReactNode {
  const { item } = props;
  if (item.progress === undefined || item.progress === null) {
    return null;
  }
  const { recovery } = item.progress;
  return (
    <div className="notification-recovery" data-testid="notification-recovery">
      {recovery === null
        ? TEXT.notRecovered
        : TEXT.recovered(
            formatShortDateTimeJst(recovery.recoveredAt, item.createdAt),
            formatElapsed(recovery.elapsedSeconds),
          )}
    </div>
  );
}

function MemoSection(props: {
  readonly notificationId: string;
  readonly memoCount: number;
  readonly onAdded: () => void;
}): ReactNode {
  const { api } = useAuth();
  const canWrite = usePermission('manual-entry:write');
  const { notificationId, memoCount, onAdded } = props;
  const [memos, setMemos] = useState<readonly NotificationMemoView[] | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [body, setBody] = useState('');
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const submit = useSubmit();

  // 開いたときに読み込む。ほかの利用者の追記（件数の変化）も、読み直す
  useEffect(() => {
    let cancelled = false;
    listNotificationMemos(api, notificationId).then(
      (result) => {
        if (!cancelled) {
          setMemos(result.items);
          setLoadFailed(false);
        }
      },
      () => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, notificationId, memoCount]);

  async function add(): Promise<void> {
    setNotice(undefined);
    const parsed = NotificationMemoInputSchema.safeParse({ body });
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message);
      return;
    }
    setInputError(undefined);
    const result = await submit.run(() => addNotificationMemo(api, notificationId, parsed.data));
    if (result.ok) {
      setBody('');
      setNotice(TEXT.memoAdded);
      setMemos((previous) => [...(previous ?? []), result.value]);
      onAdded();
    }
  }

  let list: ReactNode;
  if (loadFailed && memos === undefined) {
    list = (
      <div className="form-error" data-testid="notification-memo-error">
        {TEXT.memoLoadFailed}
      </div>
    );
  } else if (memos === undefined) {
    list = <div className="muted">{MESSAGES.common.loading}</div>;
  } else if (memos.length === 0) {
    list = (
      <div className="muted" data-testid="notification-memo-empty">
        {TEXT.memoEmpty}
      </div>
    );
  } else {
    list = (
      <ul className="notification-memo-list">
        {memos.map((memo) => (
          <li key={memo.memoId} data-testid="notification-memo">
            <div className="notification-memo-meta muted">
              {userLabel(memo.enteredBy, memo.enteredByName)} / {formatDateTimeJst(memo.createdAt)}
            </div>
            <div className="notification-memo-body">{memo.body}</div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="notification-memos">
      {list}
      {canWrite ? (
        <form
          className="notification-memo-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field
            label={TEXT.memoLabel}
            name="body"
            error={inputError ?? submit.fieldErrors.body}
            help={{ help: TEXT.memoHelp, example: TEXT.memoExample }}
          >
            {(control) => (
              <textarea
                {...control}
                rows={2}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
              />
            )}
          </Field>
          <FormError message={submit.formMessage} />
          <ResultNotice message={notice} testId="notification-memo-notice" />
          <button type="submit" className="button-secondary" disabled={submit.busy}>
            {submit.busy ? TEXT.memoAdding : TEXT.memoAdd}
          </button>
        </form>
      ) : (
        <div className="muted" data-testid="notification-memo-no-permission">
          {TEXT.memoNoPermission}
        </div>
      )}
    </div>
  );
}

/** 経過・メモの欄（開閉）。`onMemoAdded`: メモを追記したあと、通知の一覧を読み直す（メモの件数を更新する）。 */
export function NotificationDetails(props: {
  readonly item: NotificationItem;
  readonly onMemoAdded: () => void;
}): ReactNode {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const { progress } = item;
  const hasProgress = progress !== undefined && progress !== null;
  return (
    <details
      className="notification-details"
      data-testid="notification-details"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>{TEXT.detailsSummary(hasProgress, item.memoCount)}</summary>
      {hasProgress ? (
        <div className="notification-progress" data-testid="notification-progress">
          <span className="muted">{TEXT.progress}</span>{' '}
          {progress.changes
            .map(
              (change) =>
                `${formatShortDateTimeJst(change.changedAt, item.createdAt)} ${STATUS_LABELS[change.status]}`,
            )
            .join(' → ')}
        </div>
      ) : null}
      {open ? (
        <MemoSection
          notificationId={item.notificationId}
          memoCount={item.memoCount}
          onAdded={props.onMemoAdded}
        />
      ) : null}
    </details>
  );
}
