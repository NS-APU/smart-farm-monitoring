/**
 * SC-05 通知一覧（UC-05、UC-22。FR-7.5、FR-7.6）。通知の一覧（新しい順）、種別・既読状態での絞り込み、
 * 個別・一括の既読化。通知から、対象の観点の詳細（SC-03）または取り込みの状況（SC-11）へ移る。
 * 状態は、未読・既読の2つのみ（対応状況の管理・承認はない。Q-018）。
 */

import { useCallback, type ReactNode } from 'react';
import {
  NOTIFICATION_KINDS,
  READ_STATES,
  type NotificationKind,
  type ReadState,
} from '@smart-farm/shared/constants/status';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import type { NotificationItem } from '@smart-farm/shared/schemas/notification';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { FormError, Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { SelectFilter } from '../components/filter-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { notifyUnreadChanged } from '../components/unread-events.ts';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.notifications;

/** 通知の対象の表示（設備の名称。取り込み失敗は、取り込み元の名称）。 */
function targetLabel(item: NotificationItem, equipmentNames: ReadonlyMap<string, string>): string {
  if (item.equipmentId !== undefined) {
    return equipmentNames.get(item.equipmentId) ?? item.equipmentId;
  }
  const sourceNames: Readonly<Record<string, string>> = MESSAGES.ingestion.sourceNames;
  return (
    (item.sourceId === undefined ? undefined : sourceNames[item.sourceId]) ??
    item.sourceId ??
    MESSAGES.common.missingValue
  );
}

export function NotificationsPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentNames, selectEquipment } = useAppState();
  const query = useQueryParams();
  const kind = NOTIFICATION_KINDS.find((candidate) => candidate === query.get('kind')) ?? '';
  const readState = READ_STATES.find((candidate) => candidate === query.get('readState')) ?? '';
  const paging = useCursorPaging(`${kind}|${readState}`);
  const submit = useSubmit();

  const { cursor } = paging;
  const fetchPage = useCallback(
    () =>
      listNotifications(api, {
        ...(kind === '' ? {} : { kind }),
        ...(readState === '' ? {} : { readState }),
        limit: PAGE_SIZE,
        ...omitUndefined({ cursor }),
      }),
    [api, kind, readState, cursor],
  );
  const { data, error, reload } = usePolling(fetchPage);

  async function markRead(notification: NotificationItem): Promise<void> {
    const result = await submit.run(() => markNotificationRead(api, notification.notificationId));
    if (result.ok) {
      notifyUnreadChanged();
      reload();
    }
  }

  async function markMany(filter: {
    kind?: NotificationKind;
    readState?: ReadState;
  }): Promise<void> {
    const result = await submit.run(() => markAllNotificationsRead(api, filter));
    if (result.ok) {
      notifyUnreadChanged();
      reload();
    }
  }

  /** 通知を選ぶと、通知を既読にして、対象の画面へ移る（移動は、リンクが行う）。 */
  function open(notification: NotificationItem): void {
    if (notification.equipmentId !== undefined) {
      selectEquipment(notification.equipmentId);
    }
    if (notification.readState === 'UNREAD') {
      void markNotificationRead(api, notification.notificationId).then(
        () => {
          notifyUnreadChanged();
        },
        () => undefined,
      );
    }
  }

  const hasFilter = kind !== '' || readState !== '';
  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    body = (
      <EmptyState testId="notifications-empty">
        <p>{hasFilter ? TEXT.emptyFiltered : TEXT.empty}</p>
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table notification-table">
            <thead>
              <tr>
                <th scope="col">{TEXT.createdAt}</th>
                <th scope="col">{TEXT.kind}</th>
                <th scope="col">{TEXT.viewpoint}</th>
                <th scope="col">{TEXT.target}</th>
                <th scope="col">{TEXT.status}</th>
                <th scope="col">{TEXT.message}</th>
                <th scope="col">{TEXT.state}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr
                  key={item.notificationId}
                  data-testid="notification-row"
                  data-read-state={item.readState}
                  className={item.readState === 'UNREAD' ? 'row-unread' : undefined}
                >
                  <td data-label={TEXT.createdAt}>
                    <time dateTime={item.createdAt}>{formatDateTimeJst(item.createdAt)}</time>
                  </td>
                  <td data-label={TEXT.kind}>{TEXT.kindLabels[item.kind]}</td>
                  <td data-label={TEXT.viewpoint}>
                    {item.viewpointId === undefined
                      ? MESSAGES.common.missingValue
                      : (findViewpointMeta(item.viewpointId)?.name ?? item.viewpointId)}
                  </td>
                  <td data-label={TEXT.target}>{targetLabel(item, equipmentNames)}</td>
                  <td data-label={TEXT.status}>
                    {item.status === undefined ? (
                      MESSAGES.common.missingValue
                    ) : (
                      <StatusBadge status={item.status} />
                    )}
                  </td>
                  <td className="notification-message" data-label={TEXT.message}>
                    <p>{item.message}</p>
                    {item.kind === 'STATUS_CHANGE' && item.viewpointId !== undefined ? (
                      <Link
                        to={PATHS.viewpoint(item.viewpointId)}
                        onClick={() => {
                          open(item);
                        }}
                      >
                        {TEXT.open}
                      </Link>
                    ) : (
                      <Link
                        to={PATHS.settingsIngestion}
                        onClick={() => {
                          open(item);
                        }}
                      >
                        {TEXT.openIngestion}
                      </Link>
                    )}
                  </td>
                  <td data-label={TEXT.state}>
                    <div className="notification-state">
                      <span className={`read-state read-state-${item.readState.toLowerCase()}`}>
                        {TEXT.readLabels[item.readState]}
                      </span>
                      {item.readState === 'UNREAD' ? (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={submit.busy}
                          onClick={() => {
                            void markRead(item);
                          }}
                        >
                          {TEXT.markRead}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          pageNumber={paging.pageNumber}
          hasPrevious={paging.hasPrevious}
          hasNext={data.nextCursor !== null}
          onPrevious={paging.goPrevious}
          onNext={() => {
            if (data.nextCursor !== null) {
              paging.goNext(data.nextCursor);
            }
          }}
        />
      </>
    );
  }

  return (
    <div className="notifications-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      <section className="panel" aria-label={MESSAGES.form.filter}>
        <div className="filter-bar">
          <SelectFilter
            label={TEXT.kind}
            value={kind}
            withAll
            options={NOTIFICATION_KINDS.map((value) => ({
              value,
              label: TEXT.kindLabels[value],
            }))}
            onChange={(value) => {
              query.set({ kind: value });
            }}
          />
          <SelectFilter
            label={TEXT.readState}
            value={readState}
            withAll
            options={READ_STATES.map((value) => ({ value, label: TEXT.readLabels[value] }))}
            onChange={(value) => {
              query.set({ readState: value });
            }}
          />
          <div className="filter-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={submit.busy || !hasFilter}
              onClick={() => {
                void markMany({
                  ...(kind === '' ? {} : { kind }),
                  ...(readState === '' ? {} : { readState }),
                });
              }}
            >
              {TEXT.markFilteredRead}
            </button>
            <button
              type="button"
              disabled={submit.busy}
              onClick={() => {
                void markMany({});
              }}
            >
              {TEXT.markAllRead}
            </button>
          </div>
        </div>
        <FormError message={submit.formMessage} />
      </section>
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
