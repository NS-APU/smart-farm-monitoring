/**
 * 設備のダイアログ（SC-10）の「取り込み元の接続」の欄（Issue #367。ADR-0026。ロボット・環境センサーだけ）。プロトコル・ホスト名・ポート・認証方式
 * （・API キーのヘッダー名）の入力、認証情報の登録（書き込み専用）、その設備だけの接続テスト、同じ種別の設備からのコピー、接続の解除。
 * 入力の検証は、共有のスキーマ（FileServerConnectionSchema）で行い、項目ごとにエラーを示す。保存は、親のフォームが、設備の保存のあとに行う。
 */

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  FILE_SERVER_AUTH_METHODS,
  FILE_SERVER_PROTOCOLS,
  IngestionCredentialsInputSchema,
  defaultHttpPort,
} from '@smart-farm/shared/schemas/ingestion';
import { Field, FormError } from './form-controls.tsx';
import { formatDateTimeJst } from './format.ts';
import { Icon } from './icon.tsx';
import { fieldErrorsOfZod } from './zod-errors.ts';
import { MESSAGES } from '../i18n/messages.ts';
import type { CopyCandidate } from './equipment-connection.ts';
import type { EquipmentConnectionController } from './use-equipment-connection.ts';

const TEXT = MESSAGES.equipment.connection;

export interface EquipmentConnectionSectionProps {
  readonly controller: EquipmentConnectionController;
  /** 設備 ID（新規の登録では、まだない）。認証情報・接続テスト・解除は、設備を保存してから使う。 */
  readonly equipmentId: string | undefined;
  readonly canConfigure: boolean;
  readonly canRun: boolean;
  /** 保存済みの接続の情報を読み込めなかった（設備の保存はできるが、接続は変更しない）。 */
  readonly loadFailed: boolean;
  /** コピーできる設備（同じ種別で、設備ごとの接続を持つ設備）。 */
  readonly copyCandidates: readonly CopyCandidate[];
}

function credentialStatusText(controller: EquipmentConnectionController): string {
  const { credentials } = controller.server;
  if (credentials.state === 'CONFIGURED') {
    return credentials.updatedAt === undefined
      ? TEXT.credentialsConfigured
      : TEXT.credentialsUpdatedAt(formatDateTimeJst(credentials.updatedAt));
  }
  return TEXT.credentialsStatus[credentials.state];
}

export function EquipmentConnectionSection(props: EquipmentConnectionSectionProps): ReactNode {
  const { controller, equipmentId, canConfigure, canRun } = props;
  const { draft, server, errors } = controller;
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialErrors, setCredentialErrors] = useState<Readonly<Record<string, string>>>({});
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [testing, setTesting] = useState(false);

  if (!controller.ready) {
    return (
      <fieldset className="connection-section" data-testid="equipment-connection">
        <legend>{TEXT.heading}</legend>
        <p className="muted" data-testid="equipment-connection-loading">
          {props.loadFailed ? TEXT.loadFailed : TEXT.loading}
        </p>
      </fieldset>
    );
  }

  const canEdit = canConfigure;
  // 認証情報の登録は、保存済みの設備ごとの接続の認証方式で行う（サーバーが、保存済みの接続と照合する）
  const savedAuthMethod =
    server.connection !== undefined && server.connection.authMethod !== 'NONE'
      ? server.connection.authMethod
      : undefined;
  const credentialsBlocked = equipmentId === undefined || draft.authMethod !== savedAuthMethod;
  const credentialErrorsShown = { ...credentialErrors, ...errors };
  const locked = controller.busy;

  async function handleSaveCredentials(): Promise<void> {
    if (savedAuthMethod === undefined || equipmentId === undefined) {
      return;
    }
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
    const saved = await controller.saveCredentials(equipmentId, parsed.data);
    if (saved) {
      setCredentialUsername('');
      setCredentialPassword('');
      setCredentialSecret('');
    }
  }

  /** 認証情報の入力で Enter を押したときは、設備のフォームを送らず、認証情報を保存する。 */
  function handleCredentialEnter(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!credentialsBlocked) {
        void handleSaveCredentials();
      }
    }
  }

  async function handleTest(): Promise<void> {
    if (equipmentId === undefined) {
      return;
    }
    setTesting(true);
    await controller.test(equipmentId);
    setTesting(false);
  }

  async function handleRemove(): Promise<void> {
    if (equipmentId === undefined) {
      return;
    }
    const removed = await controller.remove(equipmentId);
    if (removed) {
      setConfirmingRemove(false);
    }
  }

  return (
    <fieldset className="connection-section" data-testid="equipment-connection">
      <legend>{TEXT.heading}</legend>
      <p className="muted">{TEXT.lead}</p>
      {canEdit ? null : (
        <p className="muted" data-testid="equipment-connection-readonly">
          {TEXT.readOnly}
        </p>
      )}
      {server.connection === undefined ? (
        <p className="muted" data-testid="equipment-connection-unset">
          {TEXT.unset}
        </p>
      ) : null}
      {canEdit ? (
        <div className="form-grid">
          <Field label={TEXT.copyLabel} name="connectionCopy" hint={TEXT.copyHint}>
            {(control) => (
              <select
                {...control}
                value=""
                disabled={locked || props.copyCandidates.length === 0}
                data-testid="equipment-connection-copy"
                onChange={(event) => {
                  const candidate = props.copyCandidates.find(
                    (item) => item.equipmentId === event.target.value,
                  );
                  if (candidate !== undefined) {
                    controller.copyFrom(candidate);
                  }
                }}
              >
                <option value="">
                  {props.copyCandidates.length === 0 ? TEXT.copyNone : TEXT.copyPlaceholder}
                </option>
                {props.copyCandidates.map((item) => (
                  <option key={item.equipmentId} value={item.equipmentId}>
                    {item.name}（{item.equipmentId}）
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      ) : null}
      {controller.copiedFrom === undefined ? null : (
        <p role="status" className="muted" data-testid="equipment-connection-copied">
          {TEXT.copied(controller.copiedFrom)}
        </p>
      )}
      <div className="form-grid">
        <Field label={TEXT.protocol} name="protocol" error={errors.protocol}>
          {(control) => (
            <select
              {...control}
              value={draft.protocol}
              disabled={!canEdit}
              onChange={(event) => {
                controller.setDraft({ protocol: event.target.value === 'HTTP' ? 'HTTP' : 'HTTPS' });
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
        <Field label={TEXT.host} name="host" error={errors.host} hint={TEXT.hostHint}>
          {(control) => (
            <input
              {...control}
              value={draft.host}
              readOnly={!canEdit}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                controller.setDraft({ host: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={TEXT.port} name="port" error={errors.port} hint={TEXT.portHint}>
          {(control) => (
            <input
              {...control}
              inputMode="numeric"
              value={draft.port}
              placeholder={String(defaultHttpPort(draft.protocol))}
              readOnly={!canEdit}
              autoComplete="off"
              onChange={(event) => {
                controller.setDraft({ port: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={TEXT.authMethod} name="authMethod" error={errors.authMethod}>
          {(control) => (
            <select
              {...control}
              value={draft.authMethod}
              disabled={!canEdit}
              onChange={(event) => {
                controller.setDraft({
                  authMethod:
                    FILE_SERVER_AUTH_METHODS.find((value) => value === event.target.value) ??
                    'NONE',
                });
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
        {draft.authMethod === 'API_KEY' ? (
          <Field
            label={TEXT.apiKeyHeaderName}
            name="apiKeyHeaderName"
            error={errors.apiKeyHeaderName}
            hint={TEXT.apiKeyHeaderNameHint}
          >
            {(control) => (
              <input
                {...control}
                value={draft.apiKeyHeaderName}
                readOnly={!canEdit}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  controller.setDraft({ apiKeyHeaderName: event.target.value });
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
      {draft.protocol === 'HTTP' ? (
        <p
          role="alert"
          className="notice notice-warning"
          data-testid="equipment-connection-plaintext-warning"
        >
          <Icon name="status-caution" size={18} />
          {TEXT.plaintextWarning}
        </p>
      ) : null}
      {draft.authMethod !== 'NONE' && savedAuthMethod === undefined ? (
        <p className="muted" data-testid="equipment-connection-credentials-note">
          {TEXT.credentialsAfterSave}
        </p>
      ) : null}
      {savedAuthMethod === undefined ? null : (
        <fieldset className="credentials-section" data-testid="equipment-credentials">
          <legend>{TEXT.credentialsHeading}</legend>
          <p data-testid="equipment-credentials-status">
            {TEXT.credentialsStatusLabel}: {credentialStatusText(controller)}
          </p>
          {canEdit ? (
            <>
              <p className="muted">{TEXT.credentialsLead}</p>
              {credentialsBlocked ? (
                <p className="muted" data-testid="equipment-credentials-unsaved">
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
                      savedAuthMethod === 'BEARER' ? TEXT.credentialsToken : TEXT.credentialsApiKey
                    }
                    name={savedAuthMethod === 'BEARER' ? 'token' : 'apiKey'}
                    error={credentialErrorsShown[savedAuthMethod === 'BEARER' ? 'token' : 'apiKey']}
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
              <div className="form-actions">
                <button
                  type="button"
                  data-testid="equipment-credentials-save"
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
      <FormError message={controller.formMessage} />
      {equipmentId !== undefined &&
      (canRun || (canConfigure && server.connection !== undefined)) ? (
        <div className="form-actions">
          {canRun ? (
            <button
              type="button"
              className="button-secondary"
              data-testid="equipment-connection-test"
              disabled={locked || controller.dirty}
              onClick={() => {
                void handleTest();
              }}
            >
              {testing ? TEXT.testing : TEXT.test}
            </button>
          ) : null}
          {canConfigure && server.connection !== undefined ? (
            <button
              type="button"
              className="button-danger-outline"
              data-testid="equipment-connection-remove"
              disabled={locked}
              onClick={() => {
                setConfirmingRemove(true);
              }}
            >
              {TEXT.remove}
            </button>
          ) : null}
        </div>
      ) : null}
      {canRun && controller.dirty && equipmentId !== undefined ? (
        <p className="muted" data-testid="equipment-connection-test-unsaved">
          {TEXT.testUnsaved}
        </p>
      ) : null}
      {confirmingRemove ? (
        <div
          role="group"
          aria-label={TEXT.remove}
          className="notice notice-warning"
          data-testid="equipment-connection-remove-confirm"
        >
          <p>{TEXT.removeConfirm}</p>
          <div className="form-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setConfirmingRemove(false);
              }}
            >
              {MESSAGES.form.cancel}
            </button>
            <button
              type="button"
              className="button-danger"
              data-testid="equipment-connection-remove-yes"
              disabled={locked}
              onClick={() => {
                void handleRemove();
              }}
            >
              {controller.busy ? TEXT.removing : TEXT.removeConfirmYes}
            </button>
          </div>
        </div>
      ) : null}
      {controller.notice === undefined ? null : (
        <p
          role="status"
          className={controller.notice.ok ? 'form-success' : 'form-error'}
          data-testid="equipment-connection-result"
        >
          {controller.notice.text}
        </p>
      )}
    </fieldset>
  );
}
