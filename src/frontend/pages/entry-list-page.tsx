/**
 * SC-07 入力データ一覧（UC-18。FR-4.2.1、FR-4.2.2）。手動入力したデータの一覧・検索・絞り込み・並べ替え・
 * ページ分割と、修正・削除（論理削除。確認を求める）。修正は、ダイアログで行う（#150。SC-07-2）。
 * 修正・削除の後は、評価を更新し（サーバー側）、評価の更新（AWS: 数分かかる／ローカル: 関連する観点のステータス）を示す（D-27）。
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
import type { ManualEntry, ManualEntrySaveResponse } from '@smart-farm/shared/schemas/manual-entry';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { deleteManualEntry, listManualEntries } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { ConfirmDialog, FormError, Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { jstDateToIso } from '../components/jst.ts';
import { ManualEntryForm } from '../components/manual-entry-form.tsx';
import {
  ManualEntryResult,
  type ManualEntryResultKind,
} from '../components/manual-entry-result.tsx';
import { Modal } from '../components/modal.tsx';
import {
  DIRECTION_OPTIONS,
  FilterPanel,
  InputFilter,
  SelectFilter,
} from '../components/filter-controls.tsx';
import { equipmentOptionLabel } from '../components/equipment-options.ts';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { userLabel } from '../lib/user-label.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import {
  countActiveConditions,
  readSortParams,
  useQueryParams,
} from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.entries;
const SORT_LABELS = {
  observedAt: TEXT.sortObservedAt,
  category: TEXT.sortCategory,
  enteredBy: TEXT.sortEnteredBy,
} as const;
/** 条件のクリアで、初期値に戻す条件（URL のクエリ）。 */
const CONDITION_NAMES = ['q', 'category', 'equipmentId', 'from', 'to', 'sort', 'direction'];

/** 修正・削除の結果（SC-07。評価の更新を示す）。 */
interface EntryResult {
  readonly kind: ManualEntryResultKind;
  readonly response: ManualEntrySaveResponse;
}

/** 入力項目の値の表示（値・単位）。 */
function formatItemValue(itemKey: string, value: number | string): string {
  return `${typeof value === 'number' ? formatThreshold(value) : value}${findItemDefinition(itemKey)?.unit ?? ''}`;
}

/** 入力項目と値の表示（項目の名称・値・単位）。 */
export function EntryValues(props: { readonly entry: ManualEntry }): ReactNode {
  return (
    <ul className="entry-values">
      {Object.entries(props.entry.items).map(([itemKey, value]) => (
        <li key={itemKey}>
          {findItemDefinition(itemKey)?.label ?? itemKey}:{' '}
          <strong>{formatItemValue(itemKey, value)}</strong>
        </li>
      ))}
    </ul>
  );
}

/** 削除の確認で示す、入力項目と値（「項目名: 値単位」を、読点でつなぐ）。 */
function entryItemsText(entry: ManualEntry): string {
  return Object.entries(entry.items)
    .map(
      ([itemKey, value]) =>
        `${findItemDefinition(itemKey)?.label ?? itemKey}: ${formatItemValue(itemKey, value)}`,
    )
    .join('、');
}

export function EntryListPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentList, equipmentNames } = useAppState();
  const canWrite = usePermission('manual-entry:write');
  const canReadAudit = usePermission('audit:read');
  // 操作の列: 修正・削除（入力の権限）と、その入力の変更履歴へのリンク（変更履歴の権限。SC-07-10）
  const showActions = canWrite || canReadAudit;
  const query = useQueryParams();
  const submit = useSubmit();
  const [editing, setEditing] = useState<ManualEntry | undefined>(undefined);
  const [deleting, setDeleting] = useState<ManualEntry | undefined>(undefined);
  const [result, setResult] = useState<EntryResult | undefined>(undefined);

  const keyword = query.get('q').trim();
  const category = MANUAL_INPUT_CATEGORIES.find((value) => value === query.get('category')) ?? '';
  const equipmentId = query.get('equipmentId');
  const from = query.get('from');
  const to = query.get('to');
  const { sort, direction } = readSortParams(query, MANUAL_ENTRY_SORT_KEYS, 'observedAt');
  const paging = useCursorPaging(
    [keyword, category, equipmentId, from, to, sort, direction].join('|'),
  );

  const activeCount = countActiveConditions([
    keyword !== '',
    category !== '',
    equipmentId !== '',
    from !== '',
    to !== '',
    sort !== 'observedAt',
    direction !== 'desc',
  ]);

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
    const deleted = await submit.run(() => deleteManualEntry(api, entry.entryId));
    setDeleting(undefined);
    if (deleted.ok) {
      setResult({ kind: 'deleted', response: deleted.value });
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
      <EmptyState testId="entries-empty">
        <p>{filtered ? MESSAGES.form.emptyList : TEXT.empty}</p>
        {filtered ? null : <Link to={PATHS.dataEntry}>{TEXT.emptyAction}</Link>}
      </EmptyState>
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
                {showActions ? <th scope="col">{TEXT.actions}</th> : null}
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
                  <td data-label={TEXT.enteredBy}>
                    {userLabel(entry.enteredBy, entry.enteredByName)}
                  </td>
                  <td data-label={TEXT.note}>
                    {entry.note === undefined ? (
                      MESSAGES.common.missingValue
                    ) : (
                      <div className="entry-note">{entry.note}</div>
                    )}
                  </td>
                  {showActions ? (
                    <td data-label={TEXT.actions}>
                      <div className="row-actions">
                        {canWrite ? (
                          <>
                            <button
                              type="button"
                              className="button-secondary"
                              onClick={() => {
                                setResult(undefined);
                                setEditing(entry);
                              }}
                            >
                              {MESSAGES.form.edit}
                            </button>
                            <button
                              type="button"
                              className="button-danger-outline"
                              onClick={() => {
                                setResult(undefined);
                                setDeleting(entry);
                              }}
                            >
                              {MESSAGES.form.delete}
                            </button>
                          </>
                        ) : null}
                        {canReadAudit ? (
                          <Link to={PATHS.historyOf('manual-entry', entry.entryId)}>
                            {TEXT.rowHistory}
                          </Link>
                        ) : null}
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
          pageSize={PAGE_SIZE}
          itemCount={data.items.length}
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
      <p className="muted" data-testid="entries-keyword-note">
        {TEXT.keywordNote}
      </p>

      <section className="panel" aria-label={MESSAGES.form.search}>
        <FilterPanel
          activeCount={activeCount}
          onClear={() => {
            query.clear(CONDITION_NAMES);
          }}
        >
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
              label: equipmentOptionLabel(item),
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
        </FilterPanel>
      </section>

      {result === undefined ? null : (
        <ManualEntryResult
          response={result.response}
          kind={result.kind}
          title={result.kind === 'deleted' ? TEXT.deleted : TEXT.updated}
          testId="entries-notice"
        />
      )}
      <FormError message={submit.formMessage} />

      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>

      {editing === undefined ? null : (
        <Modal
          title={MESSAGES.entry.editTitle}
          size="wide"
          testId="entry-edit"
          onClose={() => {
            setEditing(undefined);
          }}
        >
          <ManualEntryForm
            entry={editing}
            onSaved={(response) => {
              setEditing(undefined);
              setResult({ kind: 'updated', response });
              reload();
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </Modal>
      )}

      {deleting === undefined ? null : (
        <ConfirmDialog
          title={TEXT.deleteTitle}
          message={TEXT.deleteMessage}
          details={[
            { label: TEXT.observedAt, value: formatDateTimeJst(deleting.observedAt) },
            {
              label: TEXT.equipment,
              value: equipmentNames.get(deleting.equipmentId) ?? deleting.equipmentId,
            },
            { label: TEXT.deleteItems, value: entryItemsText(deleting) },
          ]}
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
