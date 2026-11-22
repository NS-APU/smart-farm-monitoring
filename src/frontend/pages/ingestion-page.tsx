/**
 * SC-11 取り込み設定・状況（UC-15、UC-16。FR-1.4〜1.8、FR-8.3）。取り込み元ごとの有効／無効の設定、即時取得（実行中は二重実行を防ぐ）、
 * 設備ごとの接続と状況の表（接続先・認証情報の状態・最後にデータが取れた日時・停止中・設備だけの接続テスト。Issue #367）、
 * 解釈に使っている仕様の版と状態、取り込みのログ、農業情報基盤への連携の状況（成功・失敗・保留）。接続・認証情報の入力は、設備のダイアログ（SC-10）で行う。
 * 認証情報は、画面に表示しない。設定・実行の権限（ingestion:configure・ingestion:run）がなければ、参照のみ。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  type FederationLogListResponse,
  type IngestionLog,
  type IngestionLogListResponse,
  type IngestionSourceStatus,
} from '@smart-farm/shared/schemas/ingestion';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  listFederationLogs,
  listIngestionLogs,
  runIngestion,
  testEquipmentConnection,
  updateIngestionSettings,
  getIngestionSettings,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import {
  EquipmentIngestionTable,
  type EquipmentTestResult,
} from '../components/equipment-ingestion-table.tsx';
import { FilterPanel, InputFilter, SelectFilter } from '../components/filter-controls.tsx';
import { FederationSettingsPanel } from '../components/federation-settings-panel.tsx';
import { FormError, Pager, PermissionNotice } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { isoToJstDateTimeInput, jstDateToIso } from '../components/jst.ts';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { notifyUnreadChanged } from '../components/unread-events.ts';
import { useCursorPaging, type CursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { countActiveConditions, useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { FacilityIngestionView } from './facility-ingestion-view.tsx';
import { ResultNotice } from '../components/result-notice.tsx';

const TEXT = MESSAGES.ingestion;
/** 一覧の 1 ページの件数（共通の一覧のルール。ADR-0016 の D-48）。 */
const LOG_PAGE_SIZE = 20;
/** ログの条件のクリアで、初期値に戻す条件（URL のクエリ。ほかのクエリは残す）。 */
const LOG_CONDITION_NAMES = ['equipment', 'result', 'from', 'to'];

function sourceName(sourceId: string): string {
  const names: Readonly<Record<string, string>> = TEXT.sourceNames;
  return names[sourceId] ?? sourceId;
}

/** 操作（保存・即時取得）の結果の表示。設定の保存で、カードが作り直されても、残す。 */
interface OperationResult {
  readonly ok: boolean;
  readonly text: string;
}

interface SourceCardProps {
  readonly source: IngestionSourceStatus;
  readonly result: OperationResult | undefined;
  readonly onResult: (result: OperationResult | undefined) => void;
  readonly canConfigure: boolean;
  readonly canRun: boolean;
  /** 設備のダイアログ（SC-10）へのリンクを出す（設備を変更する権限がある）。 */
  readonly canOpenEquipment: boolean;
  /** 設定の保存・即時取得の後に、画面の表示を更新する。 */
  readonly onChanged: () => void;
}

function SourceCard(props: SourceCardProps): ReactNode {
  const { source } = props;
  const { api } = useAuth();
  const submit = useSubmit();
  /** 実行中の操作（実行中の表示を、その操作のボタンだけに出す）。 */
  const [operation, setOperation] = useState<'run' | undefined>(undefined);
  /** 接続テストを実行している設備と、設備ごとの接続テストの結果。 */
  const [testingId, setTestingId] = useState<string | undefined>(undefined);
  const [testResults, setTestResults] = useState<
    Readonly<Record<string, EquipmentTestResult | undefined>>
  >({});
  const [isEnabled, setIsEnabled] = useState(source.isEnabled);
  const { result, onResult: setResult } = props;
  const locked = submit.busy || source.isRunning;

  async function handleSave(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setResult(undefined);
    // 接続は、設備ごとに設定する（この画面では送らない。取り込み元ごとの設定は、有効／無効だけ）
    const saved = await submit.run(() =>
      updateIngestionSettings(api, { sources: [{ sourceId: source.sourceId, isEnabled }] }),
    );
    if (saved.ok) {
      setResult({ ok: true, text: TEXT.saved });
      props.onChanged();
    }
  }

  async function handleTestEquipment(equipmentId: string): Promise<void> {
    setResult(undefined);
    setTestingId(equipmentId);
    const tested = await submit.run(() => testEquipmentConnection(api, equipmentId));
    setTestingId(undefined);
    if (tested.ok) {
      setTestResults((current) => ({
        ...current,
        [equipmentId]: { ok: tested.value.ok, text: tested.value.message },
      }));
    }
  }

  async function handleRun(): Promise<void> {
    setResult(undefined);
    setOperation('run');
    const ran = await submit.run(() => runIngestion(api, source.sourceId));
    setOperation(undefined);
    if (ran.ok) {
      setResult({
        ok: ran.value.result !== 'FAILURE',
        text: `${TEXT.runDone}（${TEXT.runResultLabels[ran.value.result]}）: ${TEXT.runSummary(
          ran.value.filesProcessed,
          ran.value.recordCount,
          ran.value.rejectedCount,
          ran.value.deletedEquipmentCount,
        )}`,
      });
    }
    // 取り込みの失敗・取り込み後の評価で、通知が作られることがある
    notifyUnreadChanged();
    props.onChanged();
  }

  return (
    <section
      className="panel source-card"
      aria-labelledby={`source-${source.sourceId}`}
      data-testid={`source-${source.sourceId}`}
    >
      <div className="panel-head">
        <h3 id={`source-${source.sourceId}`}>{sourceName(source.sourceId)}</h3>
        {source.isRunning ? <span className="tag tag-changed">{TEXT.isRunning}</span> : null}
        <span className="tag">
          {TEXT.profile}: {source.formatProfile.versionLabel}（
          {TEXT.profileStatus[source.formatProfile.status]}）
        </span>
      </div>
      <dl className="source-meta">
        <div>
          <dt>{TEXT.lastStarted}</dt>
          <dd data-testid={`last-started-${source.sourceId}`}>
            {source.lastStartedAt === null
              ? TEXT.neverRun
              : formatDateTimeJst(source.lastStartedAt)}
          </dd>
        </div>
      </dl>
      <EquipmentIngestionTable
        source={source}
        sourceLabel={sourceName(source.sourceId)}
        canRun={props.canRun}
        canOpenEquipment={props.canOpenEquipment}
        locked={locked}
        testingId={testingId}
        results={testResults}
        now={new Date()}
        onTest={(equipmentId) => {
          void handleTestEquipment(equipmentId);
        }}
      />
      <form
        noValidate
        aria-label={`${sourceName(source.sourceId)}の設定`}
        onSubmit={(event) => {
          void handleSave(event);
        }}
      >
        <div className="form-grid">
          <p className="muted" data-testid={`interval-moved-${source.sourceId}`}>
            {TEXT.intervalMoved}
          </p>
          <div className="field field-checkbox">
            <label>
              <input
                type="checkbox"
                checked={isEnabled}
                disabled={!props.canConfigure}
                aria-describedby={`enabled-impact-${source.sourceId}`}
                onChange={(event) => {
                  setIsEnabled(event.target.checked);
                }}
              />
              {TEXT.enabled}
            </label>
            <p
              id={`enabled-impact-${source.sourceId}`}
              className="field-hint"
              data-testid={`enabled-impact-${source.sourceId}`}
            >
              {TEXT.enabledImpact}
            </p>
          </div>
        </div>
        <FormError message={submit.formMessage} />
        {props.canConfigure || props.canRun ? (
          <div className="form-actions">
            {props.canConfigure ? (
              <button type="submit" disabled={locked}>
                {TEXT.save}
              </button>
            ) : null}
            {props.canRun ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  void handleRun();
                }}
              >
                {operation === 'run' || source.isRunning ? TEXT.running : TEXT.run}
              </button>
            ) : null}
          </div>
        ) : null}
        <ResultNotice message={result?.text} ok={result?.ok} testId={`result-${source.sourceId}`} />
      </form>
    </section>
  );
}

function LogTable(props: {
  readonly data: IngestionLogListResponse;
  readonly paging: CursorPaging;
  /** 設備の識別子 → 名前（設備ごとのログの表示。登録にない設備は、識別子のまま）。 */
  readonly equipmentNames: ReadonlyMap<string, string>;
}): ReactNode {
  const { data, paging, equipmentNames } = props;
  if (data.items.length === 0) {
    return (
      <p className="state-view" data-testid="ingestion-logs-empty">
        {TEXT.logEmpty}
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
              <th scope="col">{TEXT.logSource}</th>
              <th scope="col">{TEXT.logEquipment}</th>
              <th scope="col">{TEXT.logResult}</th>
              <th scope="col" className="numeric">
                {TEXT.logFiles}
              </th>
              <th scope="col" className="numeric">
                {TEXT.logRecords}
              </th>
              <th scope="col" className="numeric">
                {TEXT.logRejected}
              </th>
              <th scope="col" className="numeric">
                {TEXT.logDeleted}
              </th>
              <th scope="col">{TEXT.logError}</th>
              <th scope="col">{TEXT.logData}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((log) => (
              <tr key={log.logId} data-testid="ingestion-log-row" data-result={log.result}>
                <td data-label={TEXT.logStarted}>
                  <time dateTime={log.startedAt}>{formatDateTimeJst(log.startedAt)}</time>
                </td>
                <td data-label={TEXT.logSource}>{sourceName(log.sourceId)}</td>
                <td data-label={TEXT.logEquipment}>
                  {log.equipmentId === undefined
                    ? MESSAGES.common.missingValue
                    : (equipmentNames.get(log.equipmentId) ?? log.equipmentId)}
                </td>
                <td data-label={TEXT.logResult}>
                  <span className={`log-result log-result-${log.result.toLowerCase()}`}>
                    {TEXT.runResultLabels[log.result]}
                  </span>
                </td>
                <td className="numeric" data-label={TEXT.logFiles}>
                  {log.filesProcessed}
                </td>
                <td className="numeric" data-label={TEXT.logRecords}>
                  {log.recordCount}
                </td>
                <td className="numeric" data-label={TEXT.logRejected}>
                  {log.rejectedCount}
                </td>
                <td className="numeric" data-label={TEXT.logDeleted}>
                  {log.deletedEquipmentCount ?? MESSAGES.common.missingValue}
                </td>
                <td data-label={TEXT.logError}>
                  {log.errorMessage ?? MESSAGES.common.missingValue}
                </td>
                <td data-label={TEXT.logData}>
                  {log.recordCount === 0 ? (
                    MESSAGES.common.missingValue
                  ) : (
                    <Link to={loggedDataPath(log)}>{TEXT.logDataLink}</Link>
                  )}
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
        pageSize={LOG_PAGE_SIZE}
        itemCount={data.items.length}
      />
    </>
  );
}

function FederationTable(props: {
  readonly data: FederationLogListResponse;
  readonly paging: CursorPaging;
}): ReactNode {
  const { data, paging } = props;
  return (
    <>
      <ul className="queue-counts" aria-label={TEXT.queue} data-testid="federation-queue">
        {(['PENDING', 'SENT', 'FAILED', 'HELD', 'EXPIRED'] as const).map((status) => (
          <li key={status} data-testid={`queue-${status}`}>
            <span>{TEXT.queueLabels[status]}</span>
            <strong>{data.queue[status]}</strong>
          </li>
        ))}
      </ul>
      {data.items.length === 0 ? (
        <p className="state-view" data-testid="federation-logs-empty">
          {TEXT.federationEmpty}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table log-table">
              <thead>
                <tr>
                  <th scope="col">{TEXT.federationOccurred}</th>
                  <th scope="col">{TEXT.federationResult}</th>
                  <th scope="col" className="numeric">
                    {TEXT.federationCount}
                  </th>
                  <th scope="col">{TEXT.federationMessage}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((log) => (
                  <tr key={log.logId} data-testid="federation-log-row" data-result={log.result}>
                    <td data-label={TEXT.federationOccurred}>
                      <time dateTime={log.occurredAt}>{formatDateTimeJst(log.occurredAt)}</time>
                    </td>
                    <td data-label={TEXT.federationResult}>
                      <span className={`log-result log-result-${log.result.toLowerCase()}`}>
                        {TEXT.federationResultLabels[log.result]}
                      </span>
                    </td>
                    <td className="numeric" data-label={TEXT.federationCount}>
                      {log.itemCount}
                    </td>
                    <td data-label={TEXT.federationMessage}>
                      {log.message ?? MESSAGES.common.missingValue}
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
            pageSize={LOG_PAGE_SIZE}
            itemCount={data.items.length}
          />
        </>
      )}
    </>
  );
}

/**
 * 取り込みの設定・状況・ログ。閲覧の権限（ingestion:read）がない利用者（一般）には、閲覧できるハウスの、取り込み・連携の記録だけを示す
 * （設定・接続先・失敗の理由・全体の件数は、取得も表示もしない。ADR-0013。Issue #332）。
 */
/**
 * 取り込みのログから、取得したデータ（取り込み済みデータの一覧）へのリンク（Issue #363）。設備（あれば）・自動取り込み・
 * 実行の期間（日本時間の日付）で絞る。一覧は日付単位の絞り込みのため、同じ日の、ほかの取り込みのデータも含む。
 */
function loggedDataPath(log: IngestionLog): string {
  const jstDate = (iso: string): string => isoToJstDateTimeInput(iso).slice(0, 10);
  const params = new URLSearchParams({ source: 'AUTO_IMPORT' });
  if (log.equipmentId !== undefined) {
    params.set('equipmentId', log.equipmentId);
  }
  params.set('from', jstDate(log.startedAt));
  params.set('to', jstDate(log.finishedAt));
  return `${PATHS.observations}?${params.toString()}`;
}

export function IngestionPage(): ReactNode {
  return usePermission('ingestion:read') ? <IngestionContent /> : <FacilityIngestionView />;
}

function IngestionContent(): ReactNode {
  const { api } = useAuth();
  const [results, setResults] = useState<Readonly<Record<string, OperationResult | undefined>>>({});
  const canConfigure = usePermission('ingestion:configure');
  const canRun = usePermission('ingestion:run');
  const canOpenEquipment = usePermission('equipment:manage');
  const query = useQueryParams();
  // ログの絞り込み（設備・結果・期間〔日本時間の日付〕。条件は URL に反映する。Issue #201）
  const logEquipment = query.get('equipment');
  const logResultFilter = query.get('result');
  const logFrom = query.get('from');
  const logTo = query.get('to');

  const fetchSettings = useCallback(() => getIngestionSettings(api), [api]);
  const settings = usePolling(fetchSettings);

  const logPaging = useCursorPaging(
    ['log', logEquipment, logResultFilter, logFrom, logTo].join('|'),
  );
  const { cursor: logCursor } = logPaging;
  const logFromIso = jstDateToIso(logFrom, 'start');
  const logToIso = jstDateToIso(logTo, 'end');
  const logActiveCount = countActiveConditions([
    logEquipment !== '',
    logResultFilter !== '',
    logFrom !== '',
    logTo !== '',
  ]);
  const fetchLogs = useCallback(
    () =>
      listIngestionLogs(api, {
        ...(logEquipment === '' ? {} : { equipmentId: logEquipment }),
        ...(logResultFilter === 'SUCCESS' || logResultFilter === 'FAILURE'
          ? { result: logResultFilter }
          : {}),
        ...(logFromIso === null ? {} : { from: logFromIso }),
        ...(logToIso === null ? {} : { to: logToIso }),
        limit: LOG_PAGE_SIZE,
        ...omitUndefined({ cursor: logCursor }),
      }),
    [api, logEquipment, logResultFilter, logFromIso, logToIso, logCursor],
  );
  const logs = usePolling(fetchLogs);

  const federationPaging = useCursorPaging('federation');
  const { cursor: federationCursor } = federationPaging;
  const fetchFederation = useCallback(
    () =>
      listFederationLogs(api, {
        limit: LOG_PAGE_SIZE,
        ...omitUndefined({ cursor: federationCursor }),
      }),
    [api, federationCursor],
  );
  const federation = usePolling(fetchFederation);

  const { reload: reloadSettings } = settings;
  const { reload: reloadLogs } = logs;
  const { reload: reloadFederation } = federation;
  const refreshAll = useCallback(() => {
    reloadSettings();
    reloadLogs();
    reloadFederation();
  }, [reloadSettings, reloadLogs, reloadFederation]);

  // 設備の選択肢・名前は、取り込み元ごとの設備（設定・状況の応答）から作る
  const equipmentNames = new Map(
    (settings.data?.sources ?? []).flatMap((source) =>
      source.equipment.map((item) => [item.equipmentId, item.name] as const),
    ),
  );
  const equipmentOptions = [...equipmentNames].map(([value, label]) => ({ value, label }));

  return (
    <div className="ingestion-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
        <p className="page-meta">
          <button type="button" className="button-secondary" onClick={refreshAll}>
            {TEXT.reload}
          </button>
        </p>
      </div>
      <p className="muted">{TEXT.lead}</p>
      <p className="muted" data-testid="ingestion-connection-lead">
        <strong>{TEXT.connectionHeading}</strong> {TEXT.connectionLead}
      </p>
      {canConfigure || canRun ? null : <PermissionNotice message={TEXT.readOnly} />}

      <h2>{TEXT.sources}</h2>
      {settings.error !== undefined ? (
        <ErrorView error={settings.error} onRetry={settings.reload} />
      ) : settings.data === undefined ? (
        <LoadingView />
      ) : (
        settings.data.sources.map((source) => (
          <SourceCard
            key={`${source.sourceId}|${String(source.isEnabled)}`}
            source={source}
            result={results[source.sourceId]}
            onResult={(result) => {
              setResults((current) => ({ ...current, [source.sourceId]: result }));
            }}
            canConfigure={canConfigure}
            canRun={canRun}
            canOpenEquipment={canOpenEquipment}
            onChanged={refreshAll}
          />
        ))
      )}

      <section
        className="panel"
        aria-labelledby="ingestion-logs-heading"
        data-testid="ingestion-logs"
      >
        <div className="panel-head">
          <h2 id="ingestion-logs-heading">{TEXT.logs}</h2>
        </div>
        <FilterPanel
          activeCount={logActiveCount}
          onClear={() => {
            query.clear(LOG_CONDITION_NAMES);
          }}
        >
          <SelectFilter
            label={TEXT.logEquipment}
            value={logEquipment}
            withAll
            options={equipmentOptions}
            onChange={(value) => {
              query.set({ equipment: value });
            }}
          />
          <SelectFilter
            label={TEXT.logResult}
            value={logResultFilter}
            withAll
            options={[
              { value: 'SUCCESS', label: TEXT.logResultFilterLabels.SUCCESS },
              { value: 'FAILURE', label: TEXT.logResultFilterLabels.FAILURE },
            ]}
            onChange={(value) => {
              query.set({ result: value });
            }}
          />
          <InputFilter
            label={MESSAGES.form.from}
            type="date"
            value={logFrom}
            onChange={(value) => {
              query.set({ from: value });
            }}
          />
          <InputFilter
            label={MESSAGES.form.to}
            type="date"
            value={logTo}
            onChange={(value) => {
              query.set({ to: value });
            }}
          />
        </FilterPanel>
        {logs.error !== undefined ? (
          <ErrorView error={logs.error} onRetry={logs.reload} />
        ) : logs.data === undefined ? (
          <LoadingView />
        ) : (
          <LogTable data={logs.data} paging={logPaging} equipmentNames={equipmentNames} />
        )}
      </section>

      <section
        className="panel"
        aria-labelledby="federation-heading"
        data-testid="federation-section"
      >
        <div className="panel-head">
          <h2 id="federation-heading">{TEXT.federation}</h2>
        </div>
        <p className="muted">{TEXT.federationLead}</p>
        <FederationSettingsPanel />
        {federation.error !== undefined ? (
          <ErrorView error={federation.error} onRetry={federation.reload} />
        ) : federation.data === undefined ? (
          <LoadingView />
        ) : (
          <FederationTable data={federation.data} paging={federationPaging} />
        )}
      </section>
    </div>
  );
}
