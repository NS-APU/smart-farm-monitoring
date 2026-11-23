/**
 * SC-05 通知一覧（UC-05、UC-22。FR-7.5、FR-7.6）。通知の一覧（新しい順）、種別・既読状態での絞り込み、
 * 個別・一括の既読化（一括は、画面に読み込んだ時点までの未読に限り、件数つきの確認をする。ADR-0019 の D-39）。通知から、対象の観点の詳細（ダッシュボード上のドロワー。SC-03）または取り込みの状況（SC-11）へ移る
 * （#159 の SC-05-6。ドロワーを開くとき、ダッシュボードの対象のハウスを、通知のハウスにする。通知時点の判定は再現しない。経過で示す）。
 * 約 10 秒の再取得で届いた新しい通知は、自動では加えず、「新着あり（N 件）」を示す（押すと更新する。操作中に、行が下へずれないように。#159 の SC-05-10）。
 * 通知ごとに、回復日時と、開閉できる欄（経過・メモ。共有・追記のみ）を示す（#159。ADR-0019 の D-42）。
 * 状態は、未読・既読の2つのみ（対応状況の管理・承認はない。Q-018）。
 */

import { useCallback, useState, type ReactNode } from 'react';
import {
  NOTIFICATION_KINDS,
  READ_STATES,
  type NotificationKind,
  type ReadState,
} from '@smart-farm/shared/constants/status';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { NotificationItem, ReadAllRequest } from '@smart-farm/shared/schemas/notification';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { ConfirmDialog, FormError, Pager } from '../components/form-controls.tsx';
import { NotificationDetails, NotificationRecovery } from '../components/notification-details.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { FilterPanel, SelectFilter } from '../components/filter-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { notifyUnreadChanged } from '../components/unread-events.ts';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { useHoldNewItems } from '../hooks/use-hold-new-items.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { countActiveConditions, useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS, viewpointDrawerPath } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { ResultNotice } from '../components/result-notice.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.notifications;
/** 条件のクリアで、初期値に戻す条件（URL のクエリ）。 */
const CONDITION_NAMES = ['kind', 'readState'];

/**
 * 通知の「対象」と「設備」の表示（Issue #362）。
 * - 対象: ハウスの名称（設備の通知は、親のハウス。ハウスの通知は、そのハウス）。取り込み失敗などは、取り込み元の名称
 * - 設備: ロボット・環境センサーの名称。ハウスの通知・設備のない通知は「—」
 * 削除などで、設備の一覧にない設備は、対象を「—」、設備を設備 ID で示す。
 */
function targetAndEquipment(
  item: NotificationItem,
  equipmentList: readonly Equipment[],
  equipmentNames: ReadonlyMap<string, string>,
): { readonly target: string; readonly equipment: string } {
  const none = MESSAGES.common.missingValue;
  if (item.equipmentId === undefined) {
    const sourceNames: Readonly<Record<string, string>> = MESSAGES.ingestion.sourceNames;
    const source =
      (item.sourceId === undefined ? undefined : sourceNames[item.sourceId]) ?? item.sourceId;
    return { target: source ?? none, equipment: none };
  }
  const found = equipmentList.find((candidate) => candidate.equipmentId === item.equipmentId);
  if (found === undefined) {
    return { target: none, equipment: item.equipmentId };
  }
  if (found.equipmentType === 'FACILITY') {
    return { target: found.name, equipment: none };
  }
  // ロボット・環境センサーは、親のハウスを持つ（持たないデータは、対象を「—」にする）。ハウスの名称が分からなければ、ハウスの ID
  const facilityId = found.facilityId ?? none;
  return { target: equipmentNames.get(facilityId) ?? facilityId, equipment: found.name };
}

/**
 * 観点のドロワーを開くとき、選ぶ設備（ダッシュボードの対象のハウスは、選んだ設備が属するハウスになる）。
 * 通知の設備が、通知のハウス（作成時に固定した facilityId）の配下（またはそのハウス自身）なら、その設備。
 * 設備が、別のハウスへ移った・階層にない（削除した）ときは、通知のハウス。通知のハウスがなければ（古い記録など）、通知の設備。
 */
export function drawerTargetEquipmentId(
  item: NotificationItem,
  equipmentList: readonly Equipment[],
): EquipmentId | undefined {
  const { equipmentId, facilityId } = item;
  if (facilityId === undefined) {
    return equipmentId;
  }
  const found = equipmentList.find((candidate) => candidate.equipmentId === equipmentId);
  const belongs = found !== undefined && (found.facilityId ?? found.equipmentId) === facilityId;
  return belongs ? equipmentId : facilityId;
}

/** 確認待ちの一括既読: 確認で示した件数と、実行する範囲（読み込んだ時点まで）。 */
interface PendingMark {
  readonly count: number;
  readonly request: ReadAllRequest;
}

export function NotificationsPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentList, equipmentNames, selectEquipment } = useAppState();
  const query = useQueryParams();
  const kind = NOTIFICATION_KINDS.find((candidate) => candidate === query.get('kind')) ?? '';
  const readState = READ_STATES.find((candidate) => candidate === query.get('readState')) ?? '';
  const paging = useCursorPaging(`${kind}|${readState}`);
  const submit = useSubmit();
  const [pending, setPending] = useState<PendingMark | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

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
  const polling = usePolling(fetchPage);
  const { error, reload } = polling;
  // 再取得で届いた新しい通知は、自動では加えない（押すと、加える）。自分の操作のあとは、加えて更新する
  const {
    shown: data,
    newCount,
    showNew,
    refresh,
  } = useHoldNewItems(
    polling.data,
    `${kind}|${readState}|${cursor ?? ''}`,
    (item: NotificationItem) => item.notificationId,
    polling,
  );

  async function markRead(notification: NotificationItem): Promise<void> {
    const result = await submit.run(() => markNotificationRead(api, notification.notificationId));
    if (result.ok) {
      notifyUnreadChanged();
      refresh();
    }
  }

  /**
   * 一括既読の確認: 画面に読み込んだ時点（asOf）までの、範囲の未読の件数を示す。0 件なら、確認せず、その旨だけを示す。
   * 確認の件数と、実行する範囲（読み込んだ時点まで）は、同じにする（確認したあとに届いた通知は、既読にしない）。
   */
  async function requestMarkMany(scope: {
    kind?: NotificationKind;
    readState?: ReadState;
  }): Promise<void> {
    if (data === undefined) {
      return;
    }
    setNotice(undefined);
    const until = data.asOf;
    // 既読だけの範囲は、既読にする対象がない（サーバーへ問い合わせない）
    if (scope.readState === 'READ') {
      setNotice(TEXT.nothingToMark);
      return;
    }
    const counted = await submit.run(() =>
      countUnreadNotifications(api, {
        ...(scope.kind === undefined ? {} : { kind: scope.kind }),
        until,
      }),
    );
    if (!counted.ok) {
      return;
    }
    if (counted.value.unreadCount === 0) {
      setNotice(TEXT.nothingToMark);
      return;
    }
    setPending({ count: counted.value.unreadCount, request: { ...scope, until } });
  }

  async function confirmMarkMany(target: PendingMark): Promise<void> {
    const result = await submit.run(() => markAllNotificationsRead(api, target.request));
    setPending(undefined);
    if (result.ok) {
      setNotice(TEXT.markedNotice(result.value.markedCount));
      notifyUnreadChanged();
      refresh();
    }
  }

  /** 通知を選ぶと、通知を既読にして、対象の画面へ移る（移動は、リンクが行う）。 */
  function open(notification: NotificationItem): void {
    const target = drawerTargetEquipmentId(notification, equipmentList);
    if (target !== undefined) {
      selectEquipment(target);
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
  const activeCount = countActiveConditions([kind !== '', readState !== '']);
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
                <th scope="col">{TEXT.equipment}</th>
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
                  <td data-label={TEXT.target}>
                    {targetAndEquipment(item, equipmentList, equipmentNames).target}
                  </td>
                  <td data-label={TEXT.equipment}>
                    {targetAndEquipment(item, equipmentList, equipmentNames).equipment}
                  </td>
                  <td data-label={TEXT.status}>
                    {item.status === undefined ? (
                      MESSAGES.common.missingValue
                    ) : (
                      <StatusBadge status={item.status} />
                    )}
                  </td>
                  <td className="notification-message" data-label={TEXT.message}>
                    <p>{item.message}</p>
                    <NotificationRecovery item={item} />
                    <NotificationDetails item={item} onMemoAdded={reload} />
                    {item.kind === 'STATUS_CHANGE' && item.viewpointId !== undefined ? (
                      <Link
                        to={viewpointDrawerPath(item.viewpointId, undefined)}
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
          pageSize={PAGE_SIZE}
          itemCount={data.items.length}
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
        <FilterPanel
          activeCount={activeCount}
          onClear={() => {
            query.clear(CONDITION_NAMES);
          }}
        >
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
        </FilterPanel>
        {/* 既読にする操作は、絞り込みではなく操作のため、狭い幅で項目を折りたたんでも、隠さない */}
        <div className="filter-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={submit.busy || data === undefined || !hasFilter}
            onClick={() => {
              void requestMarkMany({
                ...(kind === '' ? {} : { kind }),
                ...(readState === '' ? {} : { readState }),
              });
            }}
          >
            {TEXT.markFilteredRead}
          </button>
          <button
            type="button"
            disabled={submit.busy || data === undefined}
            onClick={() => {
              void requestMarkMany({});
            }}
          >
            {TEXT.markAllRead}
          </button>
        </div>
        <FormError message={submit.formMessage} />
        <ResultNotice message={notice} testId="notifications-notice" />
      </section>
      <section className="panel" aria-label={TEXT.title}>
        {newCount === 0 ? null : (
          <p role="status" className="notice notice-info" data-testid="notifications-new">
            <button type="button" className="button-secondary" onClick={showNew}>
              {TEXT.newArrivals(newCount)}
            </button>
          </p>
        )}
        {body}
      </section>
      {pending === undefined ? null : (
        <ConfirmDialog
          title={TEXT.confirmMarkTitle}
          message={TEXT.confirmMarkMessage(pending.count)}
          confirmLabel={TEXT.markRead}
          busy={submit.busy}
          onConfirm={() => {
            void confirmMarkMany(pending);
          }}
          onCancel={() => {
            setPending(undefined);
          }}
        />
      )}
    </div>
  );
}
