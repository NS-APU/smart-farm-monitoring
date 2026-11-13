/**
 * SC-11 取り込みの状況（一般ユーザー向け。Issue #332。ADR-0013。FR-9.8）。取り込みの参照権限（ingestion:read）がない利用者に、
 * 閲覧できるハウスの、取り込み・農業情報基盤への連携の記録（日時・ハウス・結果・件数）だけを示す。
 * 取り込みの設定・接続先・認証情報・失敗の理由・全体の件数・連携キューの件数は、取得も表示もしない（管理者の画面で確認する）。
 */

import { useCallback, type ReactNode } from 'react';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type {
  FacilityFederationLogListResponse,
  FacilityIngestionLogListResponse,
} from '@smart-farm/shared/schemas/ingestion';
import {
  listFacilityFederationLogs,
  listFacilityIngestionLogs,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { Pager } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { useCursorPaging, type CursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';

const TEXT = MESSAGES.ingestion;
const VIEW = TEXT.facilityView;
const LOG_PAGE_SIZE = 10;

function sourceName(sourceId: string): string {
  const names: Readonly<Record<string, string>> = TEXT.sourceNames;
  return names[sourceId] ?? sourceId;
}

function ResultLabel(props: { readonly result: string; readonly label: string }): ReactNode {
  return (
    <span className={`log-result log-result-${props.result.toLowerCase()}`}>{props.label}</span>
  );
}

function PagerOf(props: {
  readonly paging: CursorPaging;
  readonly nextCursor: string | null;
}): ReactNode {
  const { paging, nextCursor } = props;
  return (
    <Pager
      pageNumber={paging.pageNumber}
      hasPrevious={paging.hasPrevious}
      hasNext={nextCursor !== null}
      onPrevious={paging.goPrevious}
      onNext={() => {
        if (nextCursor !== null) {
          paging.goNext(nextCursor);
        }
      }}
    />
  );
}

function IngestionTable(props: {
  readonly data: FacilityIngestionLogListResponse;
  readonly paging: CursorPaging;
  readonly facilityName: (facilityId: string) => string;
}): ReactNode {
  const { data, paging, facilityName } = props;
  if (data.items.length === 0) {
    return (
      <p className="state-view" data-testid="facility-ingestion-empty">
        {VIEW.ingestionEmpty}
      </p>
    );
  }
  return (
    <>
      <div className="table-scroll">
        <table className="data-table log-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.logStarted}</th>
              <th scope="col">{VIEW.facility}</th>
              <th scope="col">{TEXT.logSource}</th>
              <th scope="col">{TEXT.logResult}</th>
              <th scope="col" className="numeric">
                {TEXT.logRecords}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((entry) => (
              <tr
                key={`${entry.logId}|${entry.facilityId}`}
                data-testid="facility-ingestion-row"
                data-result={entry.result}
              >
                <td data-label={TEXT.logStarted}>
                  <time dateTime={entry.occurredAt}>{formatDateTimeJst(entry.occurredAt)}</time>
                </td>
                <td data-label={VIEW.facility}>{facilityName(entry.facilityId)}</td>
                <td data-label={TEXT.logSource}>{sourceName(entry.sourceId)}</td>
                <td data-label={TEXT.logResult}>
                  <ResultLabel result={entry.result} label={VIEW.resultLabels[entry.result]} />
                </td>
                <td className="numeric" data-label={TEXT.logRecords}>
                  {entry.recordCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PagerOf paging={paging} nextCursor={data.nextCursor} />
    </>
  );
}

function FederationTable(props: {
  readonly data: FacilityFederationLogListResponse;
  readonly paging: CursorPaging;
  readonly facilityName: (facilityId: string) => string;
}): ReactNode {
  const { data, paging, facilityName } = props;
  if (data.items.length === 0) {
    return (
      <p className="state-view" data-testid="facility-federation-empty">
        {VIEW.federationEmpty}
      </p>
    );
  }
  return (
    <>
      <div className="table-scroll">
        <table className="data-table log-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.federationOccurred}</th>
              <th scope="col">{VIEW.facility}</th>
              <th scope="col">{TEXT.federationResult}</th>
              <th scope="col" className="numeric">
                {TEXT.federationCount}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((entry) => (
              <tr
                key={`${entry.logId}|${entry.facilityId}`}
                data-testid="facility-federation-row"
                data-result={entry.result}
              >
                <td data-label={TEXT.federationOccurred}>
                  <time dateTime={entry.occurredAt}>{formatDateTimeJst(entry.occurredAt)}</time>
                </td>
                <td data-label={VIEW.facility}>{facilityName(entry.facilityId)}</td>
                <td data-label={TEXT.federationResult}>
                  <ResultLabel
                    result={entry.result}
                    label={TEXT.federationResultLabels[entry.result]}
                  />
                </td>
                <td className="numeric" data-label={TEXT.federationCount}>
                  {entry.itemCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PagerOf paging={paging} nextCursor={data.nextCursor} />
    </>
  );
}

export function FacilityIngestionView(): ReactNode {
  const { api } = useAuth();
  const { equipmentNames } = useAppState();
  const facilityName = useCallback(
    (facilityId: string) => equipmentNames.get(facilityId) ?? facilityId,
    [equipmentNames],
  );

  const ingestionPaging = useCursorPaging('facility-ingestion');
  const { cursor: ingestionCursor } = ingestionPaging;
  const fetchIngestion = useCallback(
    () =>
      listFacilityIngestionLogs(api, {
        limit: LOG_PAGE_SIZE,
        ...omitUndefined({ cursor: ingestionCursor }),
      }),
    [api, ingestionCursor],
  );
  const ingestion = usePolling(fetchIngestion);

  const federationPaging = useCursorPaging('facility-federation');
  const { cursor: federationCursor } = federationPaging;
  const fetchFederation = useCallback(
    () =>
      listFacilityFederationLogs(api, {
        limit: LOG_PAGE_SIZE,
        ...omitUndefined({ cursor: federationCursor }),
      }),
    [api, federationCursor],
  );
  const federation = usePolling(fetchFederation);

  const { reload: reloadIngestion } = ingestion;
  const { reload: reloadFederation } = federation;
  const refreshAll = useCallback(() => {
    reloadIngestion();
    reloadFederation();
  }, [reloadIngestion, reloadFederation]);

  return (
    <div className="ingestion-page">
      <div className="page-head">
        <h1>{VIEW.title}</h1>
        <p className="page-meta">
          <button type="button" className="button-secondary" onClick={refreshAll}>
            {TEXT.reload}
          </button>
        </p>
      </div>
      <p className="muted">{VIEW.lead}</p>

      <section
        className="panel"
        aria-labelledby="facility-ingestion-heading"
        data-testid="facility-ingestion"
      >
        <div className="panel-head">
          <h2 id="facility-ingestion-heading">{VIEW.ingestion}</h2>
        </div>
        {ingestion.error !== undefined ? (
          <ErrorView error={ingestion.error} onRetry={ingestion.reload} />
        ) : ingestion.data === undefined ? (
          <LoadingView />
        ) : (
          <IngestionTable
            data={ingestion.data}
            paging={ingestionPaging}
            facilityName={facilityName}
          />
        )}
      </section>

      <section
        className="panel"
        aria-labelledby="facility-federation-heading"
        data-testid="facility-federation"
      >
        <div className="panel-head">
          <h2 id="facility-federation-heading">{VIEW.federation}</h2>
        </div>
        <p className="muted">{VIEW.federationLead}</p>
        {federation.error !== undefined ? (
          <ErrorView error={federation.error} onRetry={federation.reload} />
        ) : federation.data === undefined ? (
          <LoadingView />
        ) : (
          <FederationTable
            data={federation.data}
            paging={federationPaging}
            facilityName={facilityName}
          />
        )}
      </section>
    </div>
  );
}
