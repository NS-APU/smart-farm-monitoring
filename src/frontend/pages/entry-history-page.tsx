/**
 * SC-08 変更履歴（UC-18。FR-4.2.3）。入力・変更・削除の履歴（操作種別、対象データ、変更者、変更前後の値、日時）。
 * 操作種別・変更者・対象・期間で絞り込み、日時の並べ替え（新しい順・古い順）とページ分割ができる。
 * 変更履歴を参照する権限（audit:read）が必要。
 */

import { useCallback, type ReactNode } from 'react';
import { CATEGORY_LABELS, findItemDefinition } from '@smart-farm/shared/constants/items';
import { formatThreshold } from '@smart-farm/shared/criteria-text';
import {
  AUDIT_OPERATIONS,
  AUDIT_TARGET_TYPES,
  type AuditLogEntry,
} from '@smart-farm/shared/schemas/audit';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { listAuditLogs } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { Pager, PermissionNotice } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { jstDateToIso } from '../components/jst.ts';
import { InputFilter, SelectFilter } from '../components/filter-controls.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { readSortDirection, useQueryParams } from '../hooks/use-query-params.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.history;

/** 対象の種類の表示名。未知の種類は、そのまま表示する。 */
function targetTypeLabel(targetType: string): string {
  const labels: Readonly<Record<string, string>> = TEXT.targetTypeLabels;
  return labels[targetType] ?? targetType;
}

/** 手動入力の、項目の値以外の内容（計測日時・設備・カテゴリ・備考）。修正で、これらだけが変わった場合も、履歴で分かるようにする。 */
function entryMetaOf(record: Readonly<Record<string, unknown>>): { label: string; text: string }[] {
  const { observedAt, equipmentId, category, note } = record;
  const meta: { label: string; text: string }[] = [];
  if (typeof observedAt === 'string') {
    meta.push({ label: TEXT.metaObservedAt, text: formatDateTimeJst(observedAt) });
  }
  if (typeof equipmentId === 'string') {
    meta.push({ label: TEXT.metaEquipment, text: equipmentId });
  }
  if (typeof category === 'string') {
    const labels: Readonly<Record<string, string>> = CATEGORY_LABELS;
    meta.push({ label: TEXT.metaCategory, text: labels[category] ?? category });
  }
  if (typeof note === 'string' && note !== '') {
    meta.push({ label: TEXT.metaNote, text: note });
  }
  return meta;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** 変更前後の値の表示。手動入力は、項目と値（単位つき）。その他は、内容を開いて確認できる。 */
export function AuditValue(props: {
  readonly targetType: string;
  readonly value: unknown;
}): ReactNode {
  if (props.value === undefined) {
    return <span className="muted">{MESSAGES.common.missingValue}</span>;
  }
  const record = props.targetType === 'manual-entry' ? recordOf(props.value) : undefined;
  const items = record === undefined ? undefined : recordOf(record.items);
  if (record !== undefined && items !== undefined) {
    const meta = entryMetaOf(record);
    return (
      <div>
        <ul className="entry-values">
          {Object.entries(items).map(([itemKey, value]) => {
            const item = findItemDefinition(itemKey);
            return (
              <li key={itemKey}>
                {item?.label ?? itemKey}:{' '}
                <strong>
                  {typeof value === 'number' ? formatThreshold(value) : String(value)}
                  {item?.unit ?? ''}
                </strong>
              </li>
            );
          })}
        </ul>
        {meta.length === 0 ? null : (
          <dl className="audit-meta">
            {meta.map(({ label, text }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={label === TEXT.metaNote ? 'entry-note' : undefined}>{text}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }
  return (
    <details>
      <summary>{TEXT.showDetail}</summary>
      <pre className="audit-json">{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}

export function EntryHistoryPage(): ReactNode {
  const { api } = useAuth();
  const canRead = usePermission('audit:read');
  const query = useQueryParams();
  const operation = AUDIT_OPERATIONS.find((value) => value === query.get('operation')) ?? '';
  const targetType = AUDIT_TARGET_TYPES.find((value) => value === query.get('targetType')) ?? '';
  const actor = query.get('actor').trim();
  const from = query.get('from');
  const to = query.get('to');
  const direction = readSortDirection(query);
  const paging = useCursorPaging([operation, targetType, actor, from, to, direction].join('|'));

  const { cursor } = paging;
  const fromIso = jstDateToIso(from, 'start');
  const toIso = jstDateToIso(to, 'end');
  const fetchPage = useCallback(async () => {
    if (!canRead) {
      return undefined;
    }
    return listAuditLogs(api, {
      ...(operation === '' ? {} : { operation }),
      ...(targetType === '' ? {} : { targetType }),
      ...(actor === '' ? {} : { actor }),
      ...(fromIso === null ? {} : { from: fromIso }),
      ...(toIso === null ? {} : { to: toIso }),
      direction,
      limit: PAGE_SIZE,
      ...omitUndefined({ cursor }),
    });
  }, [api, canRead, operation, targetType, actor, fromIso, toIso, direction, cursor]);
  const { data, error, reload } = usePolling(fetchPage);

  function row(entry: AuditLogEntry): ReactNode {
    return (
      <tr key={entry.auditId} data-testid="audit-row">
        <td data-label={TEXT.occurredAt}>
          <time dateTime={entry.occurredAt}>{formatDateTimeJst(entry.occurredAt)}</time>
        </td>
        <td data-label={TEXT.operation}>{TEXT.operationLabels[entry.operation]}</td>
        <td data-label={TEXT.target}>
          {targetTypeLabel(entry.targetType)}
          <span className="muted category-note">（{entry.targetId}）</span>
        </td>
        <td data-label={TEXT.actor}>{entry.actor}</td>
        <td data-label={TEXT.before}>
          <AuditValue targetType={entry.targetType} value={entry.before} />
        </td>
        <td data-label={TEXT.after}>
          <AuditValue targetType={entry.targetType} value={entry.after} />
        </td>
      </tr>
    );
  }

  let body: ReactNode;
  if (!canRead) {
    body = <PermissionNotice message={TEXT.noPermission} />;
  } else if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    body = (
      <p className="state-view" data-testid="audit-empty">
        {TEXT.empty}
      </p>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table card-table audit-table">
            <thead>
              <tr>
                <th scope="col">{TEXT.occurredAt}</th>
                <th scope="col">{TEXT.operation}</th>
                <th scope="col">{TEXT.target}</th>
                <th scope="col">{TEXT.actor}</th>
                <th scope="col">{TEXT.before}</th>
                <th scope="col">{TEXT.after}</th>
              </tr>
            </thead>
            <tbody>{data.items.map(row)}</tbody>
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
    <div className="entry-history-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
        <p className="page-meta">
          <Link to={PATHS.dataEntryList}>{TEXT.backToEntries}</Link>
        </p>
      </div>
      <p className="muted">{TEXT.lead}</p>
      {canRead ? (
        <section className="panel" aria-label={MESSAGES.form.search}>
          <div className="filter-bar">
            <SelectFilter
              label={TEXT.operation}
              value={operation}
              withAll
              options={AUDIT_OPERATIONS.map((value) => ({
                value,
                label: TEXT.operationLabels[value],
              }))}
              onChange={(value) => {
                query.set({ operation: value });
              }}
            />
            <SelectFilter
              label={TEXT.targetType}
              value={targetType}
              withAll
              options={AUDIT_TARGET_TYPES.map((value) => ({
                value,
                label: TEXT.targetTypeLabels[value],
              }))}
              onChange={(value) => {
                query.set({ targetType: value });
              }}
            />
            <InputFilter
              label={TEXT.actor}
              value={query.get('actor')}
              onChange={(value) => {
                query.set({ actor: value });
              }}
            />
            <InputFilter
              label={MESSAGES.form.from}
              type="date"
              value={from}
              onChange={(value) => {
                query.set({ from: value });
              }}
            />
            <InputFilter
              label={MESSAGES.form.to}
              type="date"
              value={to}
              onChange={(value) => {
                query.set({ to: value });
              }}
            />
            <SelectFilter
              label={MESSAGES.form.sort}
              value={direction}
              options={[
                { value: 'desc', label: MESSAGES.form.newestFirst },
                { value: 'asc', label: MESSAGES.form.oldestFirst },
              ]}
              onChange={(value) => {
                query.set({ direction: value });
              }}
            />
          </div>
        </section>
      ) : null}
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
