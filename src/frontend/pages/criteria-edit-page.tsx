/**
 * SC-13 判断基準の編集（UC-19。FR-5.7、FR-5.8）。観点の判断基準（指標ごとの型・閾値・条件名）の参照・編集・保存と、
 * 既定値へ戻す操作。変更はシステム全体（すべての利用者）に適用し、変更済みであることを識別できる（版・変更者・日時）。
 * 大小関係・数値・条件名（空欄・200文字超）を検証し、不正な組み合わせは保存できない。
 * ステータスコードで判定する指標は、ここでは編集できない（ステータスコード管理で設定する）。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import {
  CriteriaUpdateRequestSchema,
  type Criterion,
  type CriteriaView,
} from '@smart-farm/shared/schemas/criteria';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import { getCriteria, resetCriteria, updateCriteria } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { ConfirmDialog, Field, FormError, PermissionNotice } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { normalizeNumberText } from '../components/number-text.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';

const TEXT = MESSAGES.criteria;
/** 1時間ごとの再取得は不要（編集中の入力を、更新で壊さないため、読み込みは保存・リセットのときだけ行う）。 */
const NO_POLLING_MS = 24 * MS_PER_HOUR;

type ThresholdKey = keyof typeof TEXT.thresholdLabels;

/** 型ごとの、閾値の入力欄の順序。 */
const THRESHOLD_KEYS: Readonly<Record<Criterion['kind'], readonly ThresholdKey[]>> = {
  UPPER: ['cautionFrom', 'errorFrom'],
  LOWER: ['cautionBelow', 'errorBelow'],
  RANGE: ['errorLower', 'normalLower', 'normalUpper', 'errorUpper'],
};

interface Row {
  readonly indicator: string;
  readonly kind: Criterion['kind'];
  readonly label: string;
  readonly values: Readonly<Record<string, string>>;
}

function rowsOf(criteria: CriteriaView): Row[] {
  return criteria.criteria.map((criterion) => ({
    indicator: criterion.indicator,
    kind: criterion.kind,
    label: criterion.label,
    values: Object.fromEntries(
      Object.entries(criterion.thresholds).map(([key, value]) => [key, String(value)]),
    ),
  }));
}

/** 入力の文字列を数値にする。空欄・数値でない入力は NaN（検証で、数値でない旨のエラーになる）。 */
function toNumber(text: string): number {
  const normalized = normalizeNumberText(text);
  return normalized === '' ? Number.NaN : Number(normalized);
}

interface EditorProps {
  readonly viewpointId: string;
  readonly criteria: CriteriaView;
  readonly canEdit: boolean;
  readonly onChanged: (message: string) => void;
}

function CriteriaEditor(props: EditorProps): ReactNode {
  const { api } = useAuth();
  const submit = useSubmit();
  const [rows, setRows] = useState<readonly Row[]>(() => rowsOf(props.criteria));
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [confirmingReset, setConfirmingReset] = useState(false);
  const errors = { ...clientErrors, ...submit.fieldErrors };

  function change(index: number, patch: (row: Row) => Row): void {
    setRows((current) => current.map((row, position) => (position === index ? patch(row) : row)));
  }

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const parsed = CriteriaUpdateRequestSchema.safeParse({
      criteria: rows.map((row) => ({
        indicator: row.indicator,
        kind: row.kind,
        label: row.label,
        thresholds: Object.fromEntries(
          Object.entries(row.values).map(([key, text]) => [key, toNumber(text)]),
        ),
      })),
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => updateCriteria(api, props.viewpointId, parsed.data));
    if (result.ok) {
      props.onChanged(TEXT.saved);
    }
  }

  async function handleReset(): Promise<void> {
    const result = await submit.run(() => resetCriteria(api, props.viewpointId));
    setConfirmingReset(false);
    if (result.ok) {
      props.onChanged(TEXT.resetDone);
    }
  }

  const { criteria } = props;
  return (
    <form
      noValidate
      className="criteria-form"
      aria-label={TEXT.title}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      {rows.map((row, index) => {
        const unit = getMetricMeta(row.indicator).unit;
        return (
          <fieldset
            key={row.indicator}
            className="criterion-card"
            data-testid={`criterion-edit-${row.indicator}`}
          >
            <legend>
              {getMetricMeta(row.indicator).label}
              <span className="tag">{TEXT.kindLabels[row.kind]}</span>
            </legend>
            <div className="form-grid">
              <Field
                label={TEXT.label}
                name={`criteria.${String(index)}.label`}
                error={errors[`criteria.${String(index)}.label`]}
                required
              >
                {(control) => (
                  <input
                    {...control}
                    value={row.label}
                    readOnly={!props.canEdit}
                    onChange={(event) => {
                      change(index, (current) => ({ ...current, label: event.target.value }));
                    }}
                  />
                )}
              </Field>
              {THRESHOLD_KEYS[row.kind].map((key) => (
                <Field
                  key={key}
                  label={
                    unit === ''
                      ? TEXT.thresholdLabels[key]
                      : `${TEXT.thresholdLabels[key]}（${unit}）`
                  }
                  name={`criteria.${String(index)}.thresholds.${key}`}
                  error={errors[`criteria.${String(index)}.thresholds.${key}`]}
                  required
                >
                  {(control) => (
                    <input
                      {...control}
                      inputMode="decimal"
                      autoComplete="off"
                      value={row.values[key] ?? ''}
                      readOnly={!props.canEdit}
                      onChange={(event) => {
                        change(index, (current) => ({
                          ...current,
                          values: { ...current.values, [key]: event.target.value },
                        }));
                      }}
                    />
                  )}
                </Field>
              ))}
            </div>
            {errors[`criteria.${String(index)}.thresholds`] === undefined ? null : (
              <p className="field-error" data-testid={`criterion-error-${row.indicator}`}>
                <Icon name="status-error" size={14} />
                {errors[`criteria.${String(index)}.thresholds`]}
              </p>
            )}
          </fieldset>
        );
      })}
      {errors.criteria === undefined ? null : (
        <p className="field-error">
          <Icon name="status-error" size={14} />
          {errors.criteria}
        </p>
      )}
      {criteria.usesStatusIndicator ? (
        <p className="muted" data-testid="criteria-status-note">
          {TEXT.statusNote}（<Link to={PATHS.settingsStatusCodes}>{TEXT.goStatusCodes}</Link>）
        </p>
      ) : null}
      <FormError message={submit.formMessage} />
      {props.canEdit ? (
        <div className="form-actions">
          <button type="submit" disabled={submit.busy}>
            {submit.busy ? MESSAGES.form.saving : TEXT.save}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={submit.busy || criteria.isDefault}
            onClick={() => {
              setConfirmingReset(true);
            }}
          >
            {TEXT.reset}
          </button>
        </div>
      ) : null}
      {confirmingReset ? (
        <ConfirmDialog
          title={TEXT.resetTitle}
          message={TEXT.resetMessage}
          confirmLabel={TEXT.reset}
          busy={submit.busy}
          onConfirm={() => {
            void handleReset();
          }}
          onCancel={() => {
            setConfirmingReset(false);
          }}
        />
      ) : null}
    </form>
  );
}

export function CriteriaEditPage(props: { readonly viewpointId: string }): ReactNode {
  const { viewpointId } = props;
  const { api } = useAuth();
  const canEdit = usePermission('criteria:edit');
  const meta = findViewpointMeta(viewpointId);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const fetchCriteria = useCallback(
    async () => (meta === undefined ? undefined : getCriteria(api, viewpointId)),
    [api, viewpointId, meta],
  );
  const { data, error, reload } = usePolling(fetchCriteria, NO_POLLING_MS);

  let body: ReactNode;
  if (meta === undefined) {
    body = (
      <p className="state-view state-error" role="alert">
        <Icon name="status-error" size={20} />
        {TEXT.unknownViewpoint}
      </p>
    );
  } else if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else {
    body = (
      <>
        <p className="criteria-state" data-testid="criteria-state">
          <span>{TEXT.state}: </span>
          <span className={`tag ${data.isDefault ? '' : 'tag-changed'}`}>
            {data.isDefault ? TEXT.stateDefault : TEXT.stateChanged}
          </span>
          {data.isDefault ? null : (
            <span className="muted">
              {' '}
              {TEXT.version}: {data.version}
              {data.updatedBy === undefined ? '' : ` / ${TEXT.updatedBy}: ${data.updatedBy}`}
              {data.updatedAt === undefined ? '' : ` / ${formatDateTimeJst(data.updatedAt)}`}
            </span>
          )}
        </p>
        <CriteriaEditor
          key={`${data.version}|${data.updatedAt ?? ''}`}
          viewpointId={viewpointId}
          criteria={data}
          canEdit={canEdit}
          onChanged={(message) => {
            setNotice(message);
            reload();
          }}
        />
      </>
    );
  }

  return (
    <div className="criteria-edit-page">
      <nav aria-label={MESSAGES.viewpoint.breadcrumb} className="breadcrumb">
        <ol>
          <li>
            <Link to={PATHS.dashboard}>{MESSAGES.viewpoint.backToDashboard}</Link>
          </li>
          <li>
            <Link to={PATHS.viewpoint(viewpointId)}>{meta?.name ?? viewpointId}</Link>
          </li>
          <li aria-current="page">{TEXT.title}</li>
        </ol>
      </nav>
      <div className="page-head">
        <h1>
          {TEXT.title}
          {meta === undefined ? null : <span className="tag">{meta.name}</span>}
        </h1>
        <p className="page-meta">
          <Link to={PATHS.viewpoint(viewpointId)}>{TEXT.backToDetail}</Link>
        </p>
      </div>
      <p className="muted">{TEXT.lead}</p>
      {canEdit ? null : <PermissionNotice message={TEXT.readOnly} />}
      {notice === undefined ? null : (
        <p role="status" className="form-success" data-testid="criteria-notice">
          <Icon name="status-normal" size={16} />
          {notice}
        </p>
      )}
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
