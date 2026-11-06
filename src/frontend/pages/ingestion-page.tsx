/**
 * SC-11 取り込み設定・状況（UC-15、UC-16。FR-1.4〜1.8、FR-8.3）。取り込み元ごとの接続先（参照名）・取得間隔・有効／無効の設定、
 * 接続テスト、即時取得（実行中は二重実行を防ぐ）、解釈に使っている仕様の版と状態、取り込みのログ、農業情報基盤への連携の
 * 状況（成功・失敗・保留）。認証情報は、画面に表示しない。設定・実行の権限（ingestion:configure・ingestion:run）がなければ、参照のみ。
 */

import {
  useCallback,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { INGESTION_INTERVAL_MINUTES_OPTIONS } from '@smart-farm/shared/constants/status';
import {
  DEFAULT_API_KEY_HEADER_NAME,
  FILE_SERVER_AUTH_METHODS,
  FILE_SERVER_PROTOCOLS,
  IngestionCredentialsInputSchema,
  IngestionSourceUpdateSchema,
  defaultHttpPort,
  type FederationLogListResponse,
  type FileServerAuthMethod,
  type FileServerConnection,
  type FileServerProtocol,
  type IngestionLogListResponse,
  type IngestionSourceStatus,
} from '@smart-farm/shared/schemas/ingestion';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  listFederationLogs,
  listIngestionLogs,
  runIngestion,
  saveIngestionCredentials,
  testIngestionConnection,
  updateIngestionSettings,
  getIngestionSettings,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { SelectFilter } from '../components/filter-controls.tsx';
import { Field, FormError, Pager, PermissionNotice } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { Icon } from '../components/icon.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { notifyUnreadChanged } from '../components/unread-events.ts';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { useCursorPaging, type CursorPaging } from '../hooks/use-cursor-paging.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';

const TEXT = MESSAGES.ingestion;
const LOG_PAGE_SIZE = 10;

function sourceName(sourceId: string): string {
  const names: Readonly<Record<string, string>> = TEXT.sourceNames;
  return names[sourceId] ?? sourceId;
}

/** 接続設定の内容が同じか（保存済みの接続設定を変えていないときは、送らない）。 */
function isSameConnection(a: FileServerConnection, b: FileServerConnection): boolean {
  if (a.type === 'HTTP' && b.type === 'HTTP') {
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.port === b.port &&
      a.authMethod === b.authMethod &&
      a.apiKeyHeaderName === b.apiKeyHeaderName
    );
  }
  return a.type === b.type;
}

/** ポートの入力が、数字でない（空は、省略として、有効）。 */
function portIsInvalid(port: string): boolean {
  return port.trim() !== '' && !/^[0-9]+$/.test(port.trim());
}

/** 項目のエラーのキー（`sources.0.connectionRef` → `connectionRef`）。 */
function withoutSourcePrefix(errors: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([name, message]) => [name.replace(/^sources\.\d+\./, ''), message]),
  );
}

/** 操作（保存・接続テスト・即時取得）の結果の表示。設定の保存で、カードが作り直されても、残す。 */
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
  /** 設定の保存・即時取得の後に、画面の表示を更新する。 */
  readonly onChanged: () => void;
}

function SourceCard(props: SourceCardProps): ReactNode {
  const { source } = props;
  const { api } = useAuth();
  const submit = useSubmit();
  /** 実行中の操作（実行中の表示を、その操作のボタンだけに出す）。 */
  const [operation, setOperation] = useState<'test' | 'run' | undefined>(undefined);
  const [connectionRef, setConnectionRef] = useState(source.connectionRef);
  const saved = source.connection;
  const savedHttp = saved.type === 'HTTP' ? saved : undefined;
  const [connectionType, setConnectionType] = useState<FileServerConnection['type']>(saved.type);
  const [protocol, setProtocol] = useState<FileServerProtocol>(savedHttp?.protocol ?? 'HTTPS');
  const [host, setHost] = useState(savedHttp?.host ?? '');
  const [port, setPort] = useState(savedHttp?.port === undefined ? '' : String(savedHttp.port));
  const [authMethod, setAuthMethod] = useState<FileServerAuthMethod>(
    savedHttp?.authMethod ?? 'NONE',
  );
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState(
    savedHttp?.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
  );
  // 認証情報の入力（書き込み専用。保存したら、空に戻す。保存済みの値は、受け取らない）
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialErrors, setCredentialErrors] = useState<Readonly<Record<string, string>>>({});
  const [interval, setInterval] = useState(String(source.intervalMinutes));
  const [isEnabled, setIsEnabled] = useState(source.isEnabled);
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const { result, onResult: setResult } = props;
  const errors = { ...clientErrors, ...withoutSourcePrefix(submit.fieldErrors) };
  const isHttp = connectionType === 'HTTP';
  const canEdit = props.canConfigure;
  // 認証情報の登録は、保存済みの設定の認証方式で行う（サーバーが、保存済みの設定と照合する）
  const savedAuthMethod =
    saved.type === 'HTTP' && saved.authMethod !== 'NONE' ? saved.authMethod : undefined;
  const credentialsBlocked = !(isHttp && authMethod === savedAuthMethod);
  const credentialStatus = source.credentials;
  const credentialErrorsShown = { ...credentialErrors, ...errors };
  const locked = submit.busy || source.isRunning;

  async function handleSave(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setResult(undefined);
    const portText = port.trim();
    const connection =
      connectionType === 'MOCK'
        ? { type: 'MOCK' }
        : {
            type: 'HTTP',
            protocol,
            host,
            ...(portText === ''
              ? {}
              : { port: portIsInvalid(portText) ? Number.NaN : Number(portText) }),
            authMethod,
            apiKeyHeaderName,
          };
    const parsed = IngestionSourceUpdateSchema.safeParse({
      sourceId: source.sourceId,
      connectionRef,
      connection,
      intervalMinutes: Number(interval),
      isEnabled,
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    // 接続設定を変えていないときは、送らない（現在の接続設定を保つ）
    const { connection: changed, ...unchanged } = parsed.data;
    const payload =
      changed === undefined || isSameConnection(changed, saved) ? unchanged : parsed.data;
    const result = await submit.run(() => updateIngestionSettings(api, { sources: [payload] }));
    if (result.ok) {
      setResult({ ok: true, text: TEXT.saved });
      props.onChanged();
    }
  }

  /** 認証情報の入力で Enter を押したときは、設定のフォームを送らず、認証情報を保存する。 */
  function handleCredentialEnter(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!credentialsBlocked) {
        void handleSaveCredentials();
      }
    }
  }

  async function handleSaveCredentials(): Promise<void> {
    if (savedAuthMethod === undefined) {
      return;
    }
    setResult(undefined);
    const candidate =
      savedAuthMethod === 'BASIC'
        ? { authMethod: 'BASIC', username: credentialUsername, password: credentialPassword }
        : savedAuthMethod === 'BEARER'
          ? { authMethod: 'BEARER', token: credentialSecret }
          : { authMethod: 'API_KEY', apiKey: credentialSecret };
    const parsed = IngestionCredentialsInputSchema.safeParse(candidate);
    if (!parsed.success) {
      setCredentialErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setCredentialErrors({});
    const result = await submit.run(() =>
      saveIngestionCredentials(api, source.sourceId, parsed.data),
    );
    if (result.ok) {
      setCredentialUsername('');
      setCredentialPassword('');
      setCredentialSecret('');
      setResult({ ok: true, text: TEXT.credentialsSaved });
      props.onChanged();
    }
  }

  async function handleTest(): Promise<void> {
    setResult(undefined);
    setOperation('test');
    const tested = await submit.run(() => testIngestionConnection(api, source.sourceId));
    setOperation(undefined);
    if (tested.ok) {
      setResult({ ok: tested.value.ok, text: tested.value.message });
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
        <div>
          <dt>{TEXT.lastSuccess}</dt>
          <dd data-testid={`last-success-${source.sourceId}`}>
            {source.lastSuccessAt === null
              ? TEXT.neverRun
              : formatDateTimeJst(source.lastSuccessAt)}
          </dd>
        </div>
      </dl>
      <form
        noValidate
        aria-label={`${sourceName(source.sourceId)}の設定`}
        onSubmit={(event) => {
          void handleSave(event);
        }}
      >
        <div className="form-grid">
          <Field
            label={TEXT.connectionRef}
            name="connectionRef"
            error={errors.connectionRef}
            hint={TEXT.connectionRefHint}
            required
          >
            {(control) => (
              <input
                {...control}
                value={connectionRef}
                readOnly={!props.canConfigure}
                autoComplete="off"
                onChange={(event) => {
                  setConnectionRef(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={TEXT.connectionType} name="connectionType" required>
            {(control) => (
              <select
                {...control}
                value={connectionType}
                disabled={!canEdit}
                onChange={(event) => {
                  setConnectionType(event.target.value === 'HTTP' ? 'HTTP' : 'MOCK');
                }}
              >
                {(['MOCK', 'HTTP'] as const).map((type) => (
                  <option key={type} value={type}>
                    {TEXT.connectionTypeLabels[type]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {isHttp ? (
            <>
              <Field
                label={TEXT.protocol}
                name="connection.protocol"
                error={errors['connection.protocol']}
              >
                {(control) => (
                  <select
                    {...control}
                    value={protocol}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setProtocol(event.target.value === 'HTTP' ? 'HTTP' : 'HTTPS');
                    }}
                  >
                    {FILE_SERVER_PROTOCOLS.map((value) => (
                      <option key={value} value={value}>
                        {TEXT.protocolLabels[value]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label={TEXT.host}
                name="connection.host"
                error={errors['connection.host']}
                hint={TEXT.hostHint}
                required
              >
                {(control) => (
                  <input
                    {...control}
                    value={host}
                    readOnly={!canEdit}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setHost(event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field
                label={TEXT.port}
                name="connection.port"
                error={errors['connection.port']}
                hint={TEXT.portHint}
              >
                {(control) => (
                  <input
                    {...control}
                    inputMode="numeric"
                    value={port}
                    placeholder={String(defaultHttpPort(protocol))}
                    readOnly={!canEdit}
                    autoComplete="off"
                    onChange={(event) => {
                      setPort(event.target.value);
                    }}
                  />
                )}
              </Field>
              <p className="field-note muted">{TEXT.filePathNotice}</p>
              <Field
                label={TEXT.authMethod}
                name="connection.authMethod"
                error={errors['connection.authMethod']}
              >
                {(control) => (
                  <select
                    {...control}
                    value={authMethod}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setAuthMethod(
                        FILE_SERVER_AUTH_METHODS.find((value) => value === event.target.value) ??
                          'NONE',
                      );
                    }}
                  >
                    {FILE_SERVER_AUTH_METHODS.map((value) => (
                      <option key={value} value={value}>
                        {TEXT.authMethodLabels[value]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {authMethod === 'API_KEY' ? (
                <Field
                  label={TEXT.apiKeyHeaderName}
                  name="connection.apiKeyHeaderName"
                  error={errors['connection.apiKeyHeaderName']}
                  hint={TEXT.apiKeyHeaderNameHint}
                >
                  {(control) => (
                    <input
                      {...control}
                      value={apiKeyHeaderName}
                      readOnly={!canEdit}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        setApiKeyHeaderName(event.target.value);
                      }}
                    />
                  )}
                </Field>
              ) : null}
            </>
          ) : null}
          <Field
            label={TEXT.interval}
            name="intervalMinutes"
            error={errors.intervalMinutes}
            required
          >
            {(control) => (
              <select
                {...control}
                value={interval}
                disabled={!props.canConfigure}
                onChange={(event) => {
                  setInterval(event.target.value);
                }}
              >
                {INGESTION_INTERVAL_MINUTES_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {TEXT.intervalLabels[minutes]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="field field-checkbox">
            <label>
              <input
                type="checkbox"
                checked={isEnabled}
                disabled={!props.canConfigure}
                onChange={(event) => {
                  setIsEnabled(event.target.checked);
                }}
              />
              {TEXT.enabled}
            </label>
          </div>
        </div>
        {isHttp && protocol === 'HTTP' ? (
          <p
            role="alert"
            className="notice notice-warning"
            data-testid={`plaintext-warning-${source.sourceId}`}
          >
            <Icon name="status-caution" size={18} />
            {TEXT.plaintextWarning}
          </p>
        ) : null}
        {isHttp && authMethod !== 'NONE' && savedAuthMethod === undefined ? (
          <p className="muted" data-testid={`credentials-note-${source.sourceId}`}>
            {TEXT.credentialsAfterSave}
          </p>
        ) : null}
        {savedAuthMethod === undefined ? null : (
          <fieldset className="credentials-section" data-testid={`credentials-${source.sourceId}`}>
            <legend>{TEXT.credentialsHeading}</legend>
            <p data-testid={`credentials-status-${source.sourceId}`}>
              {TEXT.credentialsStatusLabel}:{' '}
              {credentialStatus.state === 'CONFIGURED'
                ? credentialStatus.updatedAt === undefined
                  ? TEXT.credentialsConfigured
                  : TEXT.credentialsUpdatedAt(formatDateTimeJst(credentialStatus.updatedAt))
                : credentialStatus.state === 'UNAVAILABLE'
                  ? TEXT.credentialsStatus.UNAVAILABLE
                  : TEXT.credentialsStatus.NOT_CONFIGURED}
            </p>
            {props.canConfigure ? (
              <>
                <p className="muted">{TEXT.credentialsLead}</p>
                {credentialsBlocked ? (
                  <p className="muted" data-testid={`credentials-unsaved-${source.sourceId}`}>
                    {TEXT.credentialsUnsaved}
                  </p>
                ) : null}
                <div className="form-grid">
                  {savedAuthMethod === 'BASIC' ? (
                    <>
                      <Field
                        label={TEXT.credentialsUsername}
                        name="username"
                        error={credentialErrorsShown.username}
                      >
                        {(control) => (
                          <input
                            {...control}
                            value={credentialUsername}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={credentialsBlocked}
                            onKeyDown={handleCredentialEnter}
                            onChange={(event) => {
                              setCredentialUsername(event.target.value);
                            }}
                          />
                        )}
                      </Field>
                      <Field
                        label={TEXT.credentialsPassword}
                        name="password"
                        error={credentialErrorsShown.password}
                      >
                        {(control) => (
                          <input
                            {...control}
                            type="password"
                            value={credentialPassword}
                            autoComplete="new-password"
                            disabled={credentialsBlocked}
                            onKeyDown={handleCredentialEnter}
                            onChange={(event) => {
                              setCredentialPassword(event.target.value);
                            }}
                          />
                        )}
                      </Field>
                    </>
                  ) : (
                    <Field
                      label={
                        savedAuthMethod === 'BEARER'
                          ? TEXT.credentialsToken
                          : TEXT.credentialsApiKey
                      }
                      name={savedAuthMethod === 'BEARER' ? 'token' : 'apiKey'}
                      error={
                        credentialErrorsShown[savedAuthMethod === 'BEARER' ? 'token' : 'apiKey']
                      }
                    >
                      {(control) => (
                        <input
                          {...control}
                          type="password"
                          value={credentialSecret}
                          autoComplete="new-password"
                          spellCheck={false}
                          disabled={credentialsBlocked}
                          onKeyDown={handleCredentialEnter}
                          onChange={(event) => {
                            setCredentialSecret(event.target.value);
                          }}
                        />
                      )}
                    </Field>
                  )}
                </div>
                {credentialErrorsShown.authMethod === undefined ? null : (
                  <p className="field-error">{credentialErrorsShown.authMethod}</p>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    disabled={locked || credentialsBlocked}
                    onClick={() => {
                      void handleSaveCredentials();
                    }}
                  >
                    {TEXT.credentialsSave}
                  </button>
                </div>
              </>
            ) : null}
          </fieldset>
        )}
        <FormError message={submit.formMessage} />
        {props.canConfigure || props.canRun ? (
          <div className="form-actions">
            {props.canConfigure ? (
              <button type="submit" disabled={locked}>
                {TEXT.save}
              </button>
            ) : null}
            {props.canRun ? (
              <>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={locked}
                  onClick={() => {
                    void handleTest();
                  }}
                >
                  {operation === 'test' ? TEXT.testing : TEXT.test}
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    void handleRun();
                  }}
                >
                  {operation === 'run' || source.isRunning ? TEXT.running : TEXT.run}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {result === undefined ? null : (
          <p
            role="status"
            className={result.ok ? 'form-success' : 'form-error'}
            data-testid={`result-${source.sourceId}`}
          >
            {result.text}
          </p>
        )}
      </form>
    </section>
  );
}

function LogTable(props: {
  readonly data: IngestionLogListResponse;
  readonly paging: CursorPaging;
}): ReactNode {
  const { data, paging } = props;
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
              <th scope="col">{TEXT.logError}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((log) => (
              <tr key={log.logId} data-testid="ingestion-log-row" data-result={log.result}>
                <td data-label={TEXT.logStarted}>
                  <time dateTime={log.startedAt}>{formatDateTimeJst(log.startedAt)}</time>
                </td>
                <td data-label={TEXT.logSource}>{sourceName(log.sourceId)}</td>
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
                <td data-label={TEXT.logError}>
                  {log.errorMessage ?? MESSAGES.common.missingValue}
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
          />
        </>
      )}
    </>
  );
}

export function IngestionPage(): ReactNode {
  const { api } = useAuth();
  const [results, setResults] = useState<Readonly<Record<string, OperationResult | undefined>>>({});
  const canConfigure = usePermission('ingestion:configure');
  const canRun = usePermission('ingestion:run');
  const query = useQueryParams();
  const logSource = query.get('source');

  const fetchSettings = useCallback(() => getIngestionSettings(api), [api]);
  const settings = usePolling(fetchSettings);

  const logPaging = useCursorPaging(`log|${logSource}`);
  const { cursor: logCursor } = logPaging;
  const fetchLogs = useCallback(
    () =>
      listIngestionLogs(api, {
        ...(logSource === '' ? {} : { sourceId: logSource }),
        limit: LOG_PAGE_SIZE,
        ...omitUndefined({ cursor: logCursor }),
      }),
    [api, logSource, logCursor],
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

  const sourceOptions = (settings.data?.sources ?? []).map((source) => ({
    value: source.sourceId,
    label: sourceName(source.sourceId),
  }));

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
      {canConfigure || canRun ? null : <PermissionNotice message={TEXT.readOnly} />}

      <h2>{TEXT.sources}</h2>
      {settings.error !== undefined ? (
        <ErrorView error={settings.error} onRetry={settings.reload} />
      ) : settings.data === undefined ? (
        <LoadingView />
      ) : (
        settings.data.sources.map((source) => (
          <SourceCard
            key={`${source.sourceId}|${source.connectionRef}|${JSON.stringify(source.connection)}|${String(source.intervalMinutes)}|${String(source.isEnabled)}`}
            source={source}
            result={results[source.sourceId]}
            onResult={(result) => {
              setResults((current) => ({ ...current, [source.sourceId]: result }));
            }}
            canConfigure={canConfigure}
            canRun={canRun}
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
        <div className="filter-bar">
          <SelectFilter
            label={TEXT.logSource}
            value={logSource}
            withAll
            options={sourceOptions}
            onChange={(value) => {
              query.set({ source: value });
            }}
          />
        </div>
        {logs.error !== undefined ? (
          <ErrorView error={logs.error} onRetry={logs.reload} />
        ) : logs.data === undefined ? (
          <LoadingView />
        ) : (
          <LogTable data={logs.data} paging={logPaging} />
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
