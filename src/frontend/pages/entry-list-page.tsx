/**
 * SC-07 入力データ一覧（UC-18。FR-4.2.1、FR-4.2.2）。手動入力したデータの一覧・検索・絞り込み・並べ替え・
 * ページ分割と、修正・削除（論理削除。確認を求める）。修正・削除の後は、評価を更新する（サーバー側）。
 * 条件は URL のクエリに反映する（再読み込みで保持）。
 */

import { useCallback, useState, type ReactNode } from 'react';
import {
  CATEGORY_LABELS,
  MANUAL_INPUT_CATEGORIES,
  findItemDefinition,
} from '@smart-farm/shared/constants/items';
import { MANUAL_ENTRY_SORT_KEYS } from '@smart-farm/shared/constants/sorting';
import { formatThreshold } from '@smart-farm/shared/criteria-text';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { deleteManualEntry, listManualEntries } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { ConfirmDialog, FormError, Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { jstDateToIso } from '../components/jst.ts';
import { ManualEntryForm } from '../components/manual-entry-form.tsx';
import { DIRECTION_OPTIONS, InputFilter, SelectFilter } from '../components/filter-controls.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { readSortParams, useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.entries;
const SORT_LABELS = {
  observedAt: TEXT.sortObservedAt,
  category: TEXT.sortCategory,
  enteredBy: TEXT.sortEnteredBy,
} as const;

/** 入力項目と値の表示（項目の名称・値・単位）。 */
export function EntryValues(props: { readonly entry: ManualEntry }): ReactNode {
  return (
    <ul className="entry-values">
      {Object.entries(props.entry.items).map(([itemKey, value]) => {
        const item = findItemDefinition(itemKey);
        return (
          <li key={itemKey}>
            {item?.label ?? itemKey}:{' '}
            <strong>{`${formatThreshold(value)}${item?.unit ?? ''}`}</strong>
          </li>
        );
      })}
    </ul>
  );
}

export function EntryListPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentList, equipmentNames } = useAppState();
  const canWrite = usePermission('manual-entry:write');
  const canReadAudit = usePermission('audit:read');
  const query = useQueryParams();
  const submit = useSubmit();
  const [editing, setEditing] = useState<ManualEntry | undefined>(undefined);
  const [deleting, setDeleting] = useState<ManualEntry | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const keyword = query.get('q').trim();
  const category = MANUAL_INPUT_CATEGORIES.find((value) => value === query.get('category')) ?? '';
  const equipmentId = query.get('equipmentId');
  const from = query.get('from');
  const to = query.get('to');
  const { sort, direction } = readSortParams(query, MANUAL_ENTRY_SORT_KEYS, 'observedAt');
  const paging = useCursorPaging(
    [keyword, category, equipmentId, from, to, sort, direction].join('|'),
  );

  const { cursor } = paging;
  const fromIso = jstDateToIso(from, 'start');
  const toIso = jstDateToIso(to, 'end');
  const fetchPage = useCallback(
    () =>
      listManualEntries(api, {
        ...(keyword === '' ? {} : { q: keyword }),
        ...(category === '' ? {} : { category }),
        ...(equipmentId === '' ? {} : { equipmentId }),
        ...(fromIso === null ? {} : { from: fromIso }),
        ...(toIso === null ? {} : { to: toIso }),
        sort,
        direction,
        limit: PAGE_SIZE,
        ...omitUndefined({ cursor }),
      }),
    [api, keyword, category, equipmentId, fromIso, toIso, sort, direction, cursor],
  );
  const { data, error, reload } = usePolling(fetchPage);

  async function confirmDelete(entry: ManualEntry): Promise<void> {
    const result = await submit.run(() => deleteManualEntry(api, entry.entryId));
    setDeleting(undefined);
    if (result.ok) {
      setNotice(TEXT.deleted);
      reload();
    }
  }

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    const filtered = [keyword, category, equipmentId, from, to].some((value) => value !== '');
    body = (
      <div className="state-view" data-testid="entries-empty">
        <p>{filtered ? MESSAGES.form.emptyList : TEXT.empty}</p>
        {filtered ? null : <Link to={PATHS.dataEntry}>{TEXT.emptyAction}</Link>}
      </div>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table card-table entry-table">
            <thead>
              <tr>
                <th scope="col">{TEXT.observedAt}</th>
                <th scope="col">{TEXT.equipment}</th>
                <th scope="col">{TEXT.category}</th>
                <th scope="col">{TEXT.values}</th>
                <th scope="col">{TEXT.enteredBy}</th>
                <th scope="col">{TEXT.note}</th>
                {canWrite ? <th scope="col">{TEXT.actions}</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.entryId} data-testid="entry-row">
                  <td data-label={TEXT.observedAt}>
                    <time dateTime={entry.observedAt}>{formatDateTimeJst(entry.observedAt)}</time>
                  </td>
                  <td data-label={TEXT.equipment}>
                    {equipmentNames.get(entry.equipmentId) ?? entry.equipmentId}
                  </td>
                  <td data-label={TEXT.category}>{CATEGORY_LABELS[entry.category]}</td>
                  <td data-label={TEXT.values}>
                    <EntryValues entry={entry} />
                  </td>
                  <td data-label={TEXT.enteredBy}>{entry.enteredBy}</td>
                  <td data-label={TEXT.note}>
                    {entry.note === undefined ? (
                      MESSAGES.common.missingValue
                    ) : (
                      <div className="entry-note">{entry.note}</div>
                    )}
                  </td>
                  {canWrite ? (
                    <td data-label={TEXT.actions}>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => {
                            setNotice(undefined);
                            setEditing(entry);
                          }}
                        >
                          {MESSAGES.form.edit}
                        </button>
                        <button
                          type="button"
                          className="button-danger-outline"
                          onClick={() => {
                            setNotice(undefined);
                            setDeleting(entry);
                          }}
                        >
                          {MESSAGES.form.delete}
                        </button>
                      </div>
                    </td>
                  ) : null}
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
    <div className="entry-list-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
        <p className="page-meta">
          <Link to={PATHS.dataEntry}>{TEXT.goEntry}</Link>
          {canReadAudit ? (
            <>
              <span className="meta-separator">|</span>
              <Link to={PATHS.dataEntryHistory}>{TEXT.goHistory}</Link>
            </>
          ) : null}
        </p>
      </div>
      <p className="muted">{TEXT.lead}</p>

      <section className="panel" aria-label={MESSAGES.form.search}>
        <div className="filter-bar">
          <InputFilter
            label={MESSAGES.form.keyword}
            type="search"
            value={query.get('q')}
            onChange={(value) => {
              query.set({ q: value });
            }}
          />
          <SelectFilter
            label={TEXT.category}
            value={category}
            withAll
            options={MANUAL_INPUT_CATEGORIES.map((value) => ({
              value,
              label: CATEGORY_LABELS[value],
            }))}
            onChange={(value) => {
              query.set({ category: value });
            }}
          />
          <SelectFilter
            label={TEXT.equipment}
            value={equipmentId}
            withAll
            options={equipmentList.map((item) => ({
              value: item.equipmentId,
              label: item.name,
            }))}
            onChange={(value) => {
              query.set({ equipmentId: value });
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
            value={sort}
            options={MANUAL_ENTRY_SORT_KEYS.map((value) => ({ value, label: SORT_LABELS[value] }))}
            onChange={(value) => {
              query.set({ sort: value });
            }}
          />
          <SelectFilter
            label={MESSAGES.form.direction}
            value={direction}
            options={DIRECTION_OPTIONS}
            onChange={(value) => {
              query.set({ direction: value });
            }}
          />
        </div>
      </section>

      {notice === undefined ? null : (
        <p role="status" className="form-success" data-testid="entries-notice">
          <Icon name="status-normal" size={16} />
          {notice}
        </p>
      )}
      <FormError message={submit.formMessage} />

      {editing === undefined ? null : (
        <section className="panel" aria-labelledby="entry-edit-heading" data-testid="entry-edit">
          <h2 id="entry-edit-heading">{MESSAGES.entry.editTitle}</h2>
          <ManualEntryForm
            entry={editing}
            onSaved={() => {
              setEditing(undefined);
              setNotice(TEXT.updated);
              reload();
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </section>
      )}

      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>

      {deleting === undefined ? null : (
        <ConfirmDialog
          title={TEXT.deleteTitle}
          message={TEXT.deleteMessage}
          confirmLabel={MESSAGES.form.delete}
          busy={submit.busy}
          onConfirm={() => {
            void confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}
