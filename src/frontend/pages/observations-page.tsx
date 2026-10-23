/**
 * SC-09 取り込み済みデータ一覧（UC-20。FR-6.8）。評価の根拠となる、取り込み済みのデータ（自動取り込み・手動入力）を、
 * 日時・設備・カテゴリ・項目・値・取得元・状態の一覧で示す。カテゴリ・設備・取得元・日時の期間・キーワードで絞り込み、
 * 日時・カテゴリ・値で並べ替え、ページを移動できる。条件は URL のクエリに反映する。
 */

import { useCallback, type ReactNode } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  findItemDefinition,
} from '@smart-farm/shared/constants/items';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from '@smart-farm/shared/constants/observation-labels';
import { OBSERVATION_SORT_KEYS } from '@smart-farm/shared/constants/sorting';
import { OBSERVATION_SOURCES } from '@smart-farm/shared/constants/status';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { listObservations } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { jstDateToIso } from '../components/jst.ts';
import { DIRECTION_OPTIONS, InputFilter, SelectFilter } from '../components/filter-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { formatObservationValue } from '../components/source-data-section.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { readSortParams, useQueryParams } from '../hooks/use-query-params.ts';
import { useStatusNames } from '../hooks/use-status-names.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

const PAGE_SIZE = 20;
const TEXT = MESSAGES.observations;
const SORT_LABELS = {
  observedAt: TEXT.sortObservedAt,
  category: TEXT.sortCategory,
  value: TEXT.sortValue,
} as const;

export function ObservationsPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentList, equipmentNames } = useAppState();
  const query = useQueryParams();

  const keyword = query.get('q').trim();
  const category = CATEGORIES.find((value) => value === query.get('category')) ?? '';
  const source = OBSERVATION_SOURCES.find((value) => value === query.get('source')) ?? '';
  const equipmentId = query.get('equipmentId');
  const from = query.get('from');
  const to = query.get('to');
  const { sort, direction } = readSortParams(query, OBSERVATION_SORT_KEYS, 'observedAt');
  const paging = useCursorPaging(
    [keyword, category, source, equipmentId, from, to, sort, direction].join('|'),
  );

  const { cursor } = paging;
  const fromIso = jstDateToIso(from, 'start');
  const toIso = jstDateToIso(to, 'end');
  const fetchPage = useCallback(
    () =>
      listObservations(api, {
        ...(keyword === '' ? {} : { q: keyword }),
        ...(category === '' ? {} : { category }),
        ...(source === '' ? {} : { source }),
        ...(equipmentId === '' ? {} : { equipmentId }),
        ...(fromIso === null ? {} : { from: fromIso }),
        ...(toIso === null ? {} : { to: toIso }),
        sort,
        direction,
        limit: PAGE_SIZE,
        ...omitUndefined({ cursor }),
      }),
    [api, keyword, category, source, equipmentId, fromIso, toIso, sort, direction, cursor],
  );
  const { data, error, reload } = usePolling(fetchPage);
  const statusNames = useStatusNames();

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    const filtered = [keyword, category, source, equipmentId, from, to].some(
      (value) => value !== '',
    );
    body = (
      <EmptyState testId="observations-empty">
        <p>{filtered ? TEXT.empty : TEXT.emptyLead}</p>
        {filtered ? null : (
          <p className="notice-links">
            <Link to={PATHS.settingsIngestion}>{TEXT.goIngestion}</Link>
            <Link to={PATHS.dataEntry}>{TEXT.goEntry}</Link>
          </p>
        )}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table card-table source-table observation-table">
            <thead>
              <tr>
                <th scope="col">{MESSAGES.viewpoint.observedAt}</th>
                <th scope="col">{TEXT.equipment}</th>
                <th scope="col">{TEXT.category}</th>
                <th scope="col">{MESSAGES.viewpoint.item}</th>
                <th scope="col" className="numeric">
                  {MESSAGES.viewpoint.value}
                </th>
                <th scope="col">{TEXT.source}</th>
                <th scope="col">{MESSAGES.viewpoint.quality}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr
                  key={`${item.equipmentId}#${item.itemKey}#${item.observedAt}#${item.source}`}
                  data-testid="observation-row"
                >
                  <td className="nowrap-cell" data-label={MESSAGES.viewpoint.observedAt}>
                    <time dateTime={item.observedAt}>{formatDateTimeJst(item.observedAt)}</time>
                  </td>
                  <td data-label={TEXT.equipment}>
                    {equipmentNames.get(item.equipmentId) ?? item.equipmentId}
                  </td>
                  <td data-label={TEXT.category}>{CATEGORY_LABELS[item.category]}</td>
                  <td data-label={MESSAGES.viewpoint.item}>
                    {findItemDefinition(item.itemKey)?.label ?? item.itemKey}
                  </td>
                  <td className="numeric" data-label={MESSAGES.viewpoint.value}>
                    {formatObservationValue(item, statusNames)}
                  </td>
                  <td className="nowrap-cell" data-label={TEXT.source}>
                    {OBSERVATION_SOURCE_LABELS[item.source]}
                  </td>
                  <td className="nowrap-cell" data-label={MESSAGES.viewpoint.quality}>
                    <span className={`quality quality-${item.quality.toLowerCase()}`}>
                      {OBSERVATION_QUALITY_LABELS[item.quality]}
                    </span>
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
    <div className="observations-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
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
            options={CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
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
          <SelectFilter
            label={TEXT.source}
            value={source}
            withAll
            options={OBSERVATION_SOURCES.map((value) => ({
              value,
              label: OBSERVATION_SOURCE_LABELS[value],
            }))}
            onChange={(value) => {
              query.set({ source: value });
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
            options={OBSERVATION_SORT_KEYS.map((value) => ({ value, label: SORT_LABELS[value] }))}
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
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
