/**
 * SC-13 判断基準の編集（UC-19。FR-5.7、FR-5.8）。観点の判断基準（指標ごとの型・閾値・条件名）の参照・編集・保存と、
 * 既定値へ戻す操作。変更はシステム全体（すべての利用者）に適用し、変更済みであることを識別できる（版・変更者・日時）。
 * 大小関係・数値・条件名（空欄・200文字超）を検証し、不正な組み合わせは保存できない。
 * ステータスコードで判定する指標は、ここでは編集できない（ステータスコード〔SC-12〕で設定する）。
 * 同時編集の検出（SC-13-1）: 読み込んだときの版（ETag）を、保存・既定値へ戻す操作の If-Match に付ける。
 * 他の管理者が先に変更していたら（409）、その旨と「読み込み直す」を示す。
 * 既定値の併記（SC-13-3）: 各閾値の横に「既定: xx」を示し、保存されている値が既定値と違うとき（変更済み）は強調する。
 * 既定値は、画面と評価で共有する `shared/constants/default-criteria.ts` から得る（API の応答には含めない）。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { getDefaultCriteria } from '@smart-farm/shared/constants/default-criteria';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import {
  CriteriaUpdateRequestSchema,
  CriterionSchema,
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
import { CriterionZoneBar } from '../components/criterion-zone-bar.tsx';
import { ThresholdInput } from '../components/threshold-input.tsx';
import { thresholdSliderRange } from '../components/threshold-slider.ts';
import { ResultNotice } from '../components/result-notice.tsx';

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
  /** 保存されている判断基準（現在値。帯・「現在値」の表示に使う）。 */
  readonly saved: Criterion;
  readonly indicator: string;
  readonly kind: Criterion['kind'];
  readonly label: string;
  readonly values: Readonly<Record<string, string>>;
}

function rowsOf(criteria: CriteriaView): Row[] {
  return criteria.criteria.map((criterion) => ({
    saved: criterion,
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

/** 入力の途中の値から、判断基準を組み立てる。すべて数値として読め、保存の検証（大小関係・率の範囲）に通るときだけ（帯を描ける）。 */
function draftCriterion(row: Row): Criterion | undefined {
  const thresholds = Object.fromEntries(
    Object.entries(row.values).map(([key, text]) => [key, toNumber(text)]),
  );
  if (!Object.values(thresholds).every((value) => Number.isFinite(value))) {
    return undefined;
  }
  const candidate = { indicator: row.indicator, kind: row.kind, label: row.label, thresholds };
  const parsed = CriterionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** 入力欄の文字（型に合う閾値の名前だけを呼ぶため、値は、必ずある）。 */
function thresholdText(row: Row, key: ThresholdKey): string {
  return row.values[key] ?? '';
}

/** 保存されている閾値（現在値）。型に合う閾値の名前だけを呼ぶため、値は、必ずある。 */
function savedThresholdOf(saved: Criterion, key: ThresholdKey): number {
  const thresholds: Readonly<Record<string, number>> = saved.thresholds;
  return thresholds[key] ?? Number.NaN;
}

/** 既定の閾値（SC-13-3）。既定値に、同じ指標・同じ型がなければ undefined（比べる既定値がない）。 */
function defaultThresholdOf(
  defaults: readonly Criterion[],
  saved: Criterion,
  key: ThresholdKey,
): number | undefined {
  const base = defaults.find(
    (criterion) => criterion.indicator === saved.indicator && criterion.kind === saved.kind,
  );
  const thresholds: Readonly<Record<string, number>> | undefined = base?.thresholds;
  return thresholds?.[key];
}

interface EditorProps {
  readonly viewpointId: string;
  readonly criteria: CriteriaView;
  /** 読み込んだときの版（ETag）。保存・既定値へ戻す操作の If-Match に付ける。 */
  readonly etag: string | undefined;
  readonly canEdit: boolean;
  readonly onChanged: (message: string) => void;
  /** 最新の判断基準を読み込み直す（他の管理者の変更が見つかったとき）。 */
  readonly onReload: () => void;
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
    const result = await submit.run(() =>
      updateCriteria(api, props.viewpointId, parsed.data, props.etag),
    );
    if (result.ok) {
      props.onChanged(TEXT.saved);
    }
  }

  async function handleReset(): Promise<void> {
    const result = await submit.run(() => resetCriteria(api, props.viewpointId, props.etag));
    setConfirmingReset(false);
    if (result.ok) {
      props.onChanged(TEXT.resetDone);
    }
  }

  const { criteria } = props;
  const defaults = getDefaultCriteria(criteria.viewpointId).criteria;
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
        const { saved } = row;
        const draft = draftCriterion(row);
        const numbers = Object.values(row.values).map(toNumber);
        const range = thresholdSliderRange(row.indicator, [
          ...numbers,
          ...Object.values(saved.thresholds),
        ]);
        const changedFromSaved =
          draft !== undefined &&
          JSON.stringify(draft.thresholds) !== JSON.stringify(saved.thresholds);
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
            <div className="zone-bars">
              <CriterionZoneBar
                title={TEXT.zoneCurrent}
                criterion={saved}
                range={range}
                testId={`zone-current-${row.indicator}`}
              />
              {draft !== undefined && changedFromSaved ? (
                <CriterionZoneBar
                  title={TEXT.zoneAfter}
                  criterion={draft}
                  range={range}
                  testId={`zone-after-${row.indicator}`}
                />
              ) : null}
              {draft === undefined ? (
                <p className="muted zone-invalid" data-testid={`zone-invalid-${row.indicator}`}>
                  {TEXT.zoneInvalid}
                </p>
              ) : null}
            </div>
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
                    <ThresholdInput
                      control={control}
                      shortLabel={TEXT.thresholdShortLabels[key]}
                      unit={unit}
                      range={range}
                      text={thresholdText(row, key)}
                      value={toNumber(thresholdText(row, key))}
                      savedValue={savedThresholdOf(saved, key)}
                      defaultValue={defaultThresholdOf(defaults, saved, key)}
                      editable={props.canEdit}
                      onChange={(text) => {
                        change(index, (current) => ({
                          ...current,
                          values: { ...current.values, [key]: text },
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
      {submit.errorCode === 'CONFLICT' ? (
        <div role="alert" className="state-view state-error" data-testid="criteria-conflict">
          <Icon name="status-error" size={20} />
          <p>{TEXT.conflict}</p>
          <p>{TEXT.conflictNote}</p>
          <button type="button" className="button-secondary" onClick={props.onReload}>
            {TEXT.reload}
          </button>
        </div>
      ) : (
        <FormError message={submit.formMessage} />
      )}
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
  const { data: loaded, error, reload } = usePolling(fetchCriteria, NO_POLLING_MS);
  const data = loaded?.data;

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
  } else if (loaded === undefined || data === undefined) {
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
          key={loaded.etag ?? `${data.version}|${data.updatedAt ?? ''}`}
          viewpointId={viewpointId}
          criteria={data}
          etag={loaded.etag}
          canEdit={canEdit}
          onReload={() => {
            setNotice(undefined);
            reload();
          }}
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
      <ResultNotice message={notice} testId="criteria-notice" />
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
    </div>
  );
}
