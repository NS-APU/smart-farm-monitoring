/**
 * SC-12 ステータスコード管理（UC-17。FR-3）。ロボットのステータスコードの定義（コード値・名称・説明・カテゴリ）の
 * 参照・登録・編集・削除（論理削除。確認を求める）。コード値は一意（重複はエラー）。
 * カテゴリは、収穫速度・メンテナンス性・耐久性の判定に影響する。変更する権限（status-code:manage）がなければ、参照のみ。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import { JUDGED_STATUSES } from '@smart-farm/shared/constants/status';
import {
  StatusCodeCreateRequestSchema,
  StatusCodeUpdateRequestSchema,
  type StatusCodeDefinition,
} from '@smart-farm/shared/schemas/status-code';
import { getStatusCodes } from '../api/endpoints.ts';
import {
  createStatusCode,
  deleteStatusCode,
  updateStatusCode,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { ConfirmDialog, Field, FormError, PermissionNotice } from '../components/form-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from '../components/icon.tsx';

const TEXT = MESSAGES.statusCodes;

interface StatusCodeFormProps {
  /** 編集する定義。なければ、新規の登録。 */
  readonly definition?: StatusCodeDefinition;
  readonly onDone: (message: string) => void;
  readonly onCancel?: () => void;
}

function StatusCodeForm(props: StatusCodeFormProps): ReactNode {
  const { definition } = props;
  const { api } = useAuth();
  const submit = useSubmit();
  const [code, setCode] = useState(definition?.code ?? '');
  const [name, setName] = useState(definition?.name ?? '');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [category, setCategory] = useState<string>(definition?.category ?? 'NORMAL');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const base = { name, category, ...(description.trim() === '' ? {} : { description }) };
    if (definition === undefined) {
      const parsed = StatusCodeCreateRequestSchema.safeParse({ code, ...base });
      if (!parsed.success) {
        setClientErrors(fieldErrorsOfZod(parsed.error));
        return;
      }
      setClientErrors({});
      const result = await submit.run(() => createStatusCode(api, parsed.data));
      if (result.ok) {
        setCode('');
        setName('');
        setDescription('');
        props.onDone(TEXT.created);
      }
      return;
    }
    const parsed = StatusCodeUpdateRequestSchema.safeParse(base);
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => updateStatusCode(api, definition.code, parsed.data));
    if (result.ok) {
      props.onDone(TEXT.updated);
    }
  }

  const title = definition === undefined ? TEXT.add : `${definition.name}を${MESSAGES.form.edit}`;
  return (
    <form
      className="inline-form"
      noValidate
      aria-label={title}
      data-testid={definition === undefined ? 'status-code-add' : 'status-code-edit'}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3>{title}</h3>
      <div className="form-grid">
        {definition === undefined ? (
          <Field label={TEXT.code} name="code" error={errors.code} hint={TEXT.codeHint} required>
            {(control) => (
              <input
                {...control}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        <Field label={TEXT.name} name="name" error={errors.name} required>
          {(control) => (
            <input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.category} name="category" error={errors.category} required>
          {(control) => (
            <select
              {...control}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
              }}
            >
              {JUDGED_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {TEXT.categoryLabels[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={TEXT.description} name="description" error={errors.description}>
          {(control) => (
            <input
              {...control}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {definition === undefined ? TEXT.addSubmit : MESSAGES.form.save}
        </button>
        {props.onCancel === undefined ? null : (
          <button type="button" className="button-secondary" onClick={props.onCancel}>
            {MESSAGES.form.cancel}
          </button>
        )}
      </div>
    </form>
  );
}

export function StatusCodesPage(): ReactNode {
  const { api } = useAuth();
  const canManage = usePermission('status-code:manage');
  const submit = useSubmit();
  const fetchList = useCallback(() => getStatusCodes(api), [api]);
  const { data, error, reload } = usePolling(fetchList);
  const [editing, setEditing] = useState<StatusCodeDefinition | undefined>(undefined);
  const [deleting, setDeleting] = useState<StatusCodeDefinition | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  function done(message: string): void {
    setEditing(undefined);
    setNotice(message);
    reload();
  }

  async function confirmDelete(target: StatusCodeDefinition): Promise<void> {
    const result = await submit.run(() => deleteStatusCode(api, target.code));
    setDeleting(undefined);
    if (result.ok) {
      done(TEXT.deleted);
    }
  }

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else if (data.items.length === 0) {
    body = (
      <EmptyState testId="status-codes-empty">
        <p>{TEXT.empty}</p>
      </EmptyState>
    );
  } else {
    body = (
      <div className="table-scroll">
        <table className="data-table card-table status-code-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.code}</th>
              <th scope="col">{TEXT.name}</th>
              <th scope="col">{TEXT.category}</th>
              <th scope="col">{TEXT.description}</th>
              {canManage ? <th scope="col">{TEXT.actions}</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.code} data-testid="status-code-row" data-code={item.code}>
                <td data-label={TEXT.code}>{item.code}</td>
                <td data-label={TEXT.name}>{item.name}</td>
                <td data-label={TEXT.category}>
                  <StatusBadge status={item.category} />
                </td>
                <td data-label={TEXT.description}>
                  {item.description ?? MESSAGES.common.missingValue}
                </td>
                {canManage ? (
                  <td data-label={TEXT.actions}>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => {
                          setNotice(undefined);
                          setEditing(item);
                        }}
                      >
                        {MESSAGES.form.edit}
                      </button>
                      <button
                        type="button"
                        className="button-danger-outline"
                        onClick={() => {
                          setNotice(undefined);
                          setDeleting(item);
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
    );
  }

  return (
    <div className="status-codes-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      <p className="muted">{TEXT.impact}</p>
      {canManage ? null : <PermissionNotice message={TEXT.readOnly} />}
      {notice === undefined ? null : (
        <p role="status" className="form-success" data-testid="status-codes-notice">
          <Icon name="status-normal" size={16} />
          {notice}
        </p>
      )}
      <FormError message={submit.formMessage} />
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
      {canManage && editing !== undefined ? (
        <section className="panel">
          <StatusCodeForm
            key={editing.code}
            definition={editing}
            onDone={done}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </section>
      ) : null}
      {canManage ? (
        <section className="panel">
          <StatusCodeForm onDone={done} />
        </section>
      ) : null}
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
