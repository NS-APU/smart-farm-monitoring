/**
 * 連携先の設定（SC-11 の「農業情報基盤への連携」。UC-15。ADR-0024）。
 * 接続先は書き込み専用: 値は、表示しない（設定済みか・更新日時だけ）。入力して保存すると、上書きする。空のままなら、保存済みの接続先を保つ。
 * テナント名・context の URL・有効／無効を設定する。接続の確認は、読み取りだけを行い、成功か、理由だけを示す。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import type { ZodType } from 'zod';
import {
  FederationContextUrlSchema,
  FederationEndpointInputSchema,
  FederationTenantSchema,
  type FederationSettingsResponse,
} from '@smart-farm/shared/schemas/federation-connection';
import {
  getFederationSettings,
  testFederation,
  updateFederationSettings,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { Field, FormError } from './form-controls.tsx';
import { formatDateTimeJst } from './format.ts';
import { ErrorView, LoadingView } from './state-views.tsx';

const TEXT = MESSAGES.ingestion.federationSettings;
/** 設定の読み直しの間隔（ミリ秒）。設定は、まれにしか変わらないため、画面の更新（約 10 秒）より、長くする。 */
const SETTINGS_REFRESH_MS = 60_000;

interface OperationResult {
  readonly ok: boolean;
  readonly text: string;
}

/** 検証の最初のメッセージ（正しければ undefined）。 */
function issueOf(schema: ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

function SettingsForm(props: {
  readonly data: FederationSettingsResponse;
  /** 保存の結果の表示（設定が変わって、フォームが作り直されても、残す）。 */
  readonly saved: OperationResult | undefined;
  readonly onSaved: (result: OperationResult | undefined) => void;
  /** 保存の後に、設定を読み直す。 */
  readonly reload: () => void;
}): ReactNode {
  const { data } = props;
  const { api } = useAuth();
  const canConfigure = usePermission('ingestion:configure');
  const canRun = usePermission('ingestion:run');
  const submit = useSubmit();
  const [tenant, setTenant] = useState(data.settings.tenant);
  const [contextUrl, setContextUrl] = useState(data.settings.contextUrl);
  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [endpoint, setEndpoint] = useState('');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [tested, setTested] = useState<OperationResult | undefined>(undefined);
  const errors = {
    ...clientErrors,
    ...Object.fromEntries(
      Object.entries(submit.fieldErrors).map(([name, message]) => [
        name.replace(/^settings\./, ''),
        message,
      ]),
    ),
  };

  async function handleSave(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const trimmedEndpoint = endpoint.trim();
    const found: Record<string, string> = {};
    const endpointIssue =
      trimmedEndpoint === '' ? undefined : issueOf(FederationEndpointInputSchema, trimmedEndpoint);
    if (endpointIssue !== undefined) {
      found.endpoint = endpointIssue;
    }
    const tenantIssue = issueOf(FederationTenantSchema, tenant);
    if (tenantIssue !== undefined) {
      found.tenant = tenantIssue;
    }
    const contextIssue = issueOf(FederationContextUrlSchema, contextUrl);
    if (contextIssue !== undefined) {
      found.contextUrl = contextIssue;
    }
    setClientErrors(found);
    props.onSaved(undefined);
    if (Object.keys(found).length > 0) {
      return;
    }
    const result = await submit.run(() =>
      updateFederationSettings(api, {
        settings: { tenant, contextUrl: contextUrl.trim(), enabled },
        ...(trimmedEndpoint === '' ? {} : { endpoint: trimmedEndpoint }),
      }),
    );
    if (result.ok) {
      setEndpoint('');
      props.onSaved({ ok: true, text: TEXT.saved });
      props.reload();
    }
  }

  async function handleTest(): Promise<void> {
    setTested(undefined);
    const result = await submit.run(() => testFederation(api));
    if (result.ok) {
      setTested({ ok: result.value.ok, text: result.value.message });
    }
  }

  const status = data.endpoint.configured
    ? data.endpoint.updatedAt === undefined
      ? TEXT.endpointConfigured
      : TEXT.endpointUpdatedAt(formatDateTimeJst(data.endpoint.updatedAt))
    : TEXT.endpointNotConfigured;

  return (
    <form
      noValidate
      aria-label={TEXT.heading}
      onSubmit={(event) => {
        void handleSave(event);
      }}
    >
      {data.mode === 'mock' ? (
        <p className="muted" data-testid="federation-mock-note">
          {TEXT.mockNote}
        </p>
      ) : null}
      <p data-testid="federation-endpoint-status">
        {TEXT.endpointStatus}: {status}
      </p>
      <div className="form-grid">
        <Field
          label={TEXT.endpoint}
          name="endpoint"
          error={errors.endpoint}
          hint={TEXT.endpointHint}
        >
          {(control) => (
            <input
              {...control}
              type="password"
              value={endpoint}
              readOnly={!canConfigure}
              autoComplete="off"
              onChange={(event) => {
                setEndpoint(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.tenant} name="tenant" error={errors.tenant} hint={TEXT.tenantHint}>
          {(control) => (
            <input
              {...control}
              value={tenant}
              readOnly={!canConfigure}
              autoComplete="off"
              onChange={(event) => {
                setTenant(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={TEXT.contextUrl}
          name="contextUrl"
          error={errors.contextUrl}
          hint={TEXT.contextUrlHint}
        >
          {(control) => (
            <input
              {...control}
              value={contextUrl}
              readOnly={!canConfigure}
              autoComplete="off"
              onChange={(event) => {
                setContextUrl(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="field field-checkbox" data-field="enabled">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canConfigure}
              onChange={(event) => {
                setEnabled(event.target.checked);
              }}
            />
            {TEXT.enabled}
          </label>
          <p className="field-hint">{TEXT.enabledHint}</p>
          {errors.enabled === undefined ? null : <p className="field-error">{errors.enabled}</p>}
        </div>
      </div>
      <FormError message={submit.formMessage} />
      {canConfigure || canRun ? (
        <div className="form-actions">
          {canConfigure ? (
            <button type="submit" disabled={submit.busy}>
              {submit.busy ? TEXT.saving : TEXT.save}
            </button>
          ) : null}
          {canRun ? (
            <button
              type="button"
              className="button-secondary"
              disabled={submit.busy}
              onClick={() => {
                void handleTest();
              }}
            >
              {submit.busy ? TEXT.testing : TEXT.test}
            </button>
          ) : null}
        </div>
      ) : null}
      {props.saved === undefined ? null : (
        <p role="status" className="form-success" data-testid="federation-settings-result">
          {props.saved.text}
        </p>
      )}
      {tested === undefined ? null : (
        <p
          role="status"
          className={tested.ok ? 'form-success' : 'form-error'}
          data-testid="federation-test-result"
        >
          {tested.text}
        </p>
      )}
    </form>
  );
}

export function FederationSettingsPanel(): ReactNode {
  const { api } = useAuth();
  const fetchSettings = useCallback(() => getFederationSettings(api), [api]);
  const settings = usePolling(fetchSettings, SETTINGS_REFRESH_MS);
  const [saved, setSaved] = useState<OperationResult | undefined>(undefined);
  return (
    <div className="federation-settings" data-testid="federation-settings">
      <h3>{TEXT.heading}</h3>
      <p className="muted">{TEXT.lead}</p>
      {settings.error !== undefined ? (
        <ErrorView error={settings.error} onRetry={settings.reload} />
      ) : settings.data === undefined ? (
        <LoadingView />
      ) : (
        // サーバーの設定が変わったときは、フォームを作り直して、入力を合わせる
        <SettingsForm
          key={`${settings.data.settings.tenant}|${settings.data.settings.contextUrl}|${String(settings.data.settings.enabled)}`}
          data={settings.data}
          saved={saved}
          onSaved={setSaved}
          reload={settings.reload}
        />
      )}
    </div>
  );
}
