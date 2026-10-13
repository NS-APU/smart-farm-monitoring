/**
 * 観点の詳細: 元データ（FR-6.4。UC-02）。診断に使った、取り込みデータ・手動入力データの一覧。
 * キーワードでの絞り込み、並べ替え（日時・値・カテゴリ）、ページ分割ができる。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { CATEGORY_LABELS, findItemDefinition } from '@smart-farm/shared/constants/items';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from '@smart-farm/shared/constants/observation-labels';
import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import { formatThreshold } from '@smart-farm/shared/criteria-text';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { listObservations } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useCursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useStatusNames } from '../hooks/use-status-names.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { useAppState } from './app-state.tsx';
import { DIRECTION_OPTIONS } from './filter-controls.tsx';
import { Pager } from './form-controls.tsx';
import { formatDateTimeJst } from './format.ts';
import { ErrorView, LoadingView } from './state-views.tsx';

const PAGE_SIZE = 10;

const SORT_OPTIONS: readonly { readonly key: ObservationSortKey; readonly label: string }[] = [
  { key: 'observedAt', label: MESSAGES.viewpoint.sortObservedAt },
  { key: 'value', label: MESSAGES.viewpoint.sortValue },
  { key: 'category', label: MESSAGES.viewpoint.sortCategory },
];

/** 値の表示（単位つき。ステータスコードは名称。欠損は「—」）。 */
export function formatObservationValue(
  observation: Observation,
  statusNames: ReadonlyMap<string, string>,
): string {
  if (observation.value === null) {
    return MESSAGES.common.missingValue;
  }
  if (typeof observation.value === 'string') {
    return statusNames.get(observation.value) ?? observation.value;
  }
  const unit = findItemDefinition(observation.itemKey)?.unit ?? '';
  return `${formatThreshold(observation.value)}${unit}`;
}

export interface SourceDataSectionProps {
  readonly equipmentId: string;
  readonly viewpointId: string;
  /** 診断の対象期間（評価していなければ null。期間で絞り込まない）。 */
  readonly period: { readonly from: string; readonly to: string } | null;
}

export function SourceDataSection(props: SourceDataSectionProps): ReactNode {
  const { api } = useAuth();
  const { equipmentNames } = useAppState();
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<ObservationSortKey>('observedAt');
  const [direction, setDirection] = useState<SortDirection>('desc');
  // 絞り込み・並べ替えの条件が変わったら、先頭のページに戻る
  const paging = useCursorPaging([keyword, sort, direction].join('|'));
  const { cursor } = paging;

  const { equipmentId, viewpointId, period } = props;
  const periodFrom = period?.from;
  const periodTo = period?.to;
  const fetchPage = useCallback(
    () =>
      listObservations(api, {
        equipmentId,
        viewpointId,
        ...omitUndefined({
          from: periodFrom,
          to: periodTo,
        }),
        ...(keyword.trim() === '' ? {} : { q: keyword.trim() }),
        sort,
        direction,
        limit: PAGE_SIZE,
        ...omitUndefined({ cursor }),
      }),
    [api, equipmentId, viewpointId, periodFrom, periodTo, keyword, sort, direction, cursor],
  );
  const { data, error, reload } = usePolling(fetchPage);
  const statusNames = useStatusNames();

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    body = (
      <p className="state-view" data-testid="source-data-empty">
        {MESSAGES.viewpoint.sourceDataEmpty}
      </p>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table source-table">
            <thead>
              <tr>
                <th scope="col">{MESSAGES.viewpoint.observedAt}</th>
                <th scope="col">{MESSAGES.layout.equipment}</th>
                <th scope="col">{MESSAGES.viewpoint.item}</th>
                <th scope="col" className="numeric">
                  {MESSAGES.viewpoint.value}
                </th>
                <th scope="col">{MESSAGES.viewpoint.source}</th>
                <th scope="col">{MESSAGES.viewpoint.quality}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={`${item.equipmentId}#${item.itemKey}#${item.observedAt}#${item.source}`}>
                  <td className="nowrap-cell">
                    <time dateTime={item.observedAt}>{formatDateTimeJst(item.observedAt)}</time>
                  </td>
                  <td>{equipmentNames.get(item.equipmentId) ?? item.equipmentId}</td>
                  <td>
                    {findItemDefinition(item.itemKey)?.label ?? item.itemKey}
                    <span className="muted category-note">
                      （{CATEGORY_LABELS[item.category]}）
                    </span>
                  </td>
                  <td className="numeric">{formatObservationValue(item, statusNames)}</td>
                  <td className="nowrap-cell">{OBSERVATION_SOURCE_LABELS[item.source]}</td>
                  <td className="nowrap-cell">
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
          pageTestId="source-data-page"
        />
      </>
    );
  }

  return (
    <section className="panel" aria-labelledby="source-heading" data-testid="source-data">
      <div className="panel-head">
        <h2 id="source-heading">{MESSAGES.viewpoint.sourceData}</h2>
        <Link className="panel-link" to={PATHS.observations}>
          {MESSAGES.viewpoint.toObservations}
        </Link>
      </div>
      <p className="muted">{MESSAGES.viewpoint.sourceDataLead}</p>
      <div className="source-controls">
        <label>
          <span>{MESSAGES.viewpoint.keyword}</span>
          <input
            type="search"
            value={keyword}
            placeholder={MESSAGES.viewpoint.keywordPlaceholder}
            onChange={(event) => {
              setKeyword(event.target.value);
            }}
          />
        </label>
        <label>
          <span>{MESSAGES.viewpoint.sort}</span>
          <select
            value={sort}
            onChange={(event) => {
              const selected = SORT_OPTIONS.find((option) => option.key === event.target.value);
              if (selected !== undefined) {
                setSort(selected.key);
              }
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label={`${MESSAGES.viewpoint.sort}の向き`}
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value === 'asc' ? 'asc' : 'desc');
          }}
        >
          {DIRECTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {body}
    </section>
  );
}
