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
import type { Measurement, Observation } from '@smart-farm/shared/schemas/observation';
import { OBSERVATION_SOURCES } from '@smart-farm/shared/constants/status';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  checkListPeriod,
  LIST_PERIOD_GUIDANCE,
  requiresListPeriod,
} from '@smart-farm/shared/observation-list-period';
import { listMeasurements, listObservations } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { jstDateToIso } from '../components/jst.ts';
import {
  DIRECTION_OPTIONS,
  FilterPanel,
  InputFilter,
  SelectFilter,
} from '../components/filter-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { formatObservationValue } from '../components/source-data-section.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePolling } from '../hooks/use-polling.ts';
import {
  countActiveConditions,
  readSortParams,
  useQueryParams,
} from '../hooks/use-query-params.ts';
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
/** 条件のクリアで、初期値に戻す条件（URL のクエリ）。 */
const CONDITION_NAMES = [
  'q',
  'category',
  'source',
  'equipmentId',
  'from',
  'to',
  'sort',
  'direction',
];

/** 一覧の取得結果。日時順は、1 回の計測ごと、それ以外（カテゴリ・値の順）は、項目ごと。 */
type ListResult =
  | {
      readonly mode: 'measurements';
      readonly items: Measurement[];
      readonly nextCursor: string | null;
    }
  | { readonly mode: 'items'; readonly items: Observation[]; readonly nextCursor: string | null };

const EMPTY_RESULT: ListResult = { mode: 'items', items: [], nextCursor: null };

/** 1 回の計測のカテゴリ（項目のカテゴリを、重複なしで、並べる）。 */
function categoriesOf(measurement: Measurement): string {
  return [...new Set(measurement.items.map((item) => CATEGORY_LABELS[item.category]))].join('・');
}

/** 1 回の計測の状態: すべて有効、または、有効でない項目の状態ごとの件数。 */
function QualitySummary(props: { readonly measurement: Measurement }): ReactNode {
  const counts = new Map<Observation['quality'], number>();
  for (const item of props.measurement.items) {
    if (item.quality !== 'VALID') {
      counts.set(item.quality, (counts.get(item.quality) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return <span className="quality quality-valid">{TEXT.qualityAllValid}</span>;
  }
  return (
    <>
      {[...counts].map(([quality, count]) => (
        <span key={quality} className={`quality quality-${quality.toLowerCase()}`}>
          {OBSERVATION_QUALITY_LABELS[quality]} {count}
        </span>
      ))}
    </>
  );
}

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

  const activeCount = countActiveConditions([
    keyword !== '',
    category !== '',
    source !== '',
    equipmentId !== '',
    from !== '',
    to !== '',
    sort !== 'observedAt',
    direction !== 'desc',
  ]);

  const { cursor } = paging;
  const fromIso = jstDateToIso(from, 'start');
  const toIso = jstDateToIso(to, 'end');
  // 値・カテゴリの順の並べ替えと、キーワード検索は、期間（31 日以内）が必須（ADR-0007 の判断。#91）。足りないときは、案内を示し、API を呼ばない
  const periodMissing =
    requiresListPeriod({ sort, keyword }) &&
    checkListPeriod({ from: fromIso ?? undefined, to: toIso ?? undefined }) !== null;
  // 日時順は、1 回の計測ごとの一覧（Issue #363）。カテゴリ・値の順は、項目ごとの一覧
  const measurementMode = sort === 'observedAt';
  const fetchPage = useCallback(async (): Promise<ListResult> => {
    if (periodMissing) {
      return EMPTY_RESULT;
    }
    const conditions = {
      ...(keyword === '' ? {} : { q: keyword }),
      ...(category === '' ? {} : { category }),
      ...(source === '' ? {} : { source }),
      ...(equipmentId === '' ? {} : { equipmentId }),
      ...(fromIso === null ? {} : { from: fromIso }),
      ...(toIso === null ? {} : { to: toIso }),
      direction,
      limit: PAGE_SIZE,
      ...omitUndefined({ cursor }),
    };
    if (measurementMode) {
      return { mode: 'measurements', ...(await listMeasurements(api, conditions)) };
    }
    return { mode: 'items', ...(await listObservations(api, { ...conditions, sort })) };
  }, [
    api,
    periodMissing,
    measurementMode,
    keyword,
    category,
    source,
    equipmentId,
    fromIso,
    toIso,
    sort,
    direction,
    cursor,
  ]);
  const { data, error, reload } = usePolling(fetchPage);
  const statusNames = useStatusNames();

  let body: ReactNode;
  if (periodMissing) {
    body = (
      <p className="state-view" role="status" data-testid="observations-period-guidance">
        {LIST_PERIOD_GUIDANCE}
      </p>
    );
  } else if (error !== undefined) {
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
        {data.mode === 'measurements' ? (
          <div className="table-scroll">
            <table className="data-table card-table measurement-table">
              <thead>
                <tr>
                  <th scope="col">{MESSAGES.viewpoint.observedAt}</th>
                  <th scope="col">{TEXT.equipment}</th>
                  <th scope="col">{TEXT.category}</th>
                  <th scope="col">{TEXT.itemsAndValues}</th>
                  <th scope="col">{TEXT.source}</th>
                  <th scope="col">{MESSAGES.viewpoint.quality}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((measurement) => (
                  <tr
                    key={`${measurement.equipmentId}#${measurement.observedAt}#${measurement.source}#${measurement.manualEntryId ?? ''}`}
                    data-testid="measurement-row"
                  >
                    <td className="nowrap-cell" data-label={MESSAGES.viewpoint.observedAt}>
                      <time dateTime={measurement.observedAt}>
                        {formatDateTimeJst(measurement.observedAt)}
                      </time>
                    </td>
                    <td data-label={TEXT.equipment}>
                      {equipmentNames.get(measurement.equipmentId) ?? measurement.equipmentId}
                    </td>
                    <td data-label={TEXT.category}>{categoriesOf(measurement)}</td>
                    <td data-label={TEXT.itemsAndValues}>
                      <ul
                        className="measurement-items"
                        aria-label={TEXT.itemCount(measurement.items.length)}
                      >
                        {measurement.items.map((item) => (
                          <li key={item.itemKey} data-testid="measurement-item">
                            <span className="measurement-item-label">
                              {findItemDefinition(item.itemKey)?.label ?? item.itemKey}
                            </span>
                            <span className="measurement-item-value">
                              {formatObservationValue(item, statusNames)}
                            </span>
                            {item.quality === 'VALID' ? null : (
                              <span className={`quality quality-${item.quality.toLowerCase()}`}>
                                {OBSERVATION_QUALITY_LABELS[item.quality]}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="nowrap-cell" data-label={TEXT.source}>
                      {OBSERVATION_SOURCE_LABELS[measurement.source]}
                    </td>
                    <td className="nowrap-cell" data-label={MESSAGES.viewpoint.quality}>
                      <QualitySummary measurement={measurement} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
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
        )}
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
    <div className="observations-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      <p className="muted" data-testid="observations-mode-note">
        {measurementMode ? TEXT.measurementNote : TEXT.itemsNote}
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
        </FilterPanel>
      </section>
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
