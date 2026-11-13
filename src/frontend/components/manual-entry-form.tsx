/**
 * 手動入力のフォーム（SC-06 の入力、SC-07 の修正。FR-4.1、FR-4.2.2）。
 * 対象の設備・カテゴリ・計測日時（日本時間）を必須とし、カテゴリを選ぶと、そのカテゴリの項目だけを表示する。
 * 入力は、API と同じ検証（shared）で、保存の前に確認する（API が正）。保存後は、関連観点のステータスを返す。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import {
  CATEGORY_LABELS,
  MANUAL_INPUT_CATEGORIES,
  SATISFACTION_MAX_STARS,
  type Category,
  type ItemDefinition,
} from '@smart-farm/shared/constants/items';
import {
  ManualEntryInputSchema,
  describeRange,
  manualItemsOfCategory,
  validateManualEntry,
  type ManualEntry,
  type ManualEntrySaveResponse,
} from '@smart-farm/shared/schemas/manual-entry';
import { getStatusCodes } from '../api/endpoints.ts';
import { createManualEntry, updateManualEntry } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { useAppState } from './app-state.tsx';
import { equipmentOptionLabel } from './equipment-options.ts';
import { Field, FormError } from './form-controls.tsx';
import { isoToJstDateTimeInput, jstDateTimeToIso } from './jst.ts';
import { normalizeNumberText } from './number-text.ts';
import { notifyUnreadChanged } from './unread-events.ts';
import { Icon } from './icon.tsx';
import { StarRating } from './star-rating.tsx';

const TEXT = MESSAGES.entry;
const REMEMBER_KEY = 'smart-farm:last-entry-target';

interface Remembered {
  readonly equipmentId: string;
  readonly category: string;
}

/** 直前に入力した設備・カテゴリを記憶する（入力の負担を減らす）。保存できない環境では、何もしない。 */
function readRemembered(): Remembered | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(REMEMBER_KEY) ?? 'null');
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'equipmentId' in parsed &&
      'category' in parsed &&
      typeof parsed.equipmentId === 'string' &&
      typeof parsed.category === 'string'
    ) {
      return { equipmentId: parsed.equipmentId, category: parsed.category };
    }
  } catch {
    // 記憶は便宜のため、読めなくても、入力に支障はない
  }
  return undefined;
}

function writeRemembered(value: Remembered): void {
  try {
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
  } catch {
    // 記憶は便宜のため、保存できなくても、入力に支障はない
  }
}

export interface ManualEntryFormProps {
  /** 修正する入力。なければ、新規の入力。 */
  readonly entry?: ManualEntry | undefined;
  readonly onSaved: (response: ManualEntrySaveResponse) => void;
  readonly onCancel?: (() => void) | undefined;
}

/** スターで選んだ値（文字列で保持）。未選択なら undefined。 */
function starValue(text: string | undefined): number | undefined {
  const value = Number(text);
  return text === undefined || text === '' || Number.isNaN(value) ? undefined : value;
}

function categoryOf(value: string): Category | undefined {
  return MANUAL_INPUT_CATEGORIES.find((candidate) => candidate === value);
}

const STATUS_CODE_REFRESH_MS = 60_000;

/**
 * 文字列の項目（ステータスコード）の入力欄。登録済み（削除していない）のコードから、名称（コード）で選ぶ（#192）。
 * この欄を表示している間だけ、ステータスコードの一覧を取得する。修正で、すでに登録のないコードが入っているときは、その値も選択肢に残す（保存のとき、API が拒否する）。
 */
function StatusCodeField(props: {
  readonly item: ItemDefinition;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const { api } = useAuth();
  const fetchStatusCodes = useCallback(() => getStatusCodes(api), [api]);
  const statusCodes = usePolling(fetchStatusCodes, STATUS_CODE_REFRESH_MS);
  const registered = (statusCodes.data?.items ?? []).filter((definition) => !definition.isDeleted);
  const missing =
    props.value !== '' && !registered.some((definition) => definition.code === props.value);
  return (
    <Field
      label={props.item.label}
      name={`items.${props.item.itemKey}`}
      error={props.error}
      hint={TEXT.statusCodeHint}
    >
      {(control) => (
        <select
          {...control}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        >
          <option value="">{TEXT.selectPlaceholder}</option>
          {registered.map((definition) => (
            <option key={definition.code} value={definition.code}>
              {`${definition.name}（${definition.code}）`}
            </option>
          ))}
          {missing ? (
            <option value={props.value}>{`${props.value}${TEXT.statusCodeDeletedOption}`}</option>
          ) : null}
        </select>
      )}
    </Field>
  );
}

export function ManualEntryForm(props: ManualEntryFormProps): ReactNode {
  const { entry } = props;
  const { api } = useAuth();
  const { equipmentList, selectedEquipmentId } = useAppState();
  const submit = useSubmit();

  const [remembered] = useState(() => (entry === undefined ? readRemembered() : undefined));
  const [equipmentId, setEquipmentId] = useState(
    entry?.equipmentId ?? remembered?.equipmentId ?? selectedEquipmentId ?? '',
  );
  const [category, setCategory] = useState<string>(entry?.category ?? remembered?.category ?? '');
  const [observedAt, setObservedAt] = useState(() =>
    isoToJstDateTimeInput(entry?.observedAt ?? new Date().toISOString()),
  );
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      Object.entries(entry?.items ?? {}).map(([itemKey, value]) => [itemKey, String(value)]),
    ),
  );
  const [note, setNote] = useState(entry?.note ?? '');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  // 検証に失敗するたびに増やし、最初のエラーの項目へフォーカスを移す（V-150）
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [focusRequest]);

  const selectedCategory = categoryOf(category);
  const items = selectedCategory === undefined ? [] : manualItemsOfCategory(selectedCategory);
  const errors = { ...clientErrors, ...submit.fieldErrors };
  const equipmentOptions = equipmentList.map((item) => ({
    id: item.equipmentId,
    label: equipmentOptionLabel(item),
  }));

  function clear(): void {
    setValues({});
    setNote('');
    setClientErrors({});
    submit.clearError();
  }

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const enteredItems: Record<string, unknown> = {};
    for (const [itemKey, text] of Object.entries(values)) {
      const definition = items.find((item) => item.itemKey === itemKey);
      if (definition !== undefined && text.trim() !== '') {
        if (definition.valueType === 'string') {
          // 文字列の項目（ステータスコード）は、選んだコードの値のまま送る
          enteredItems[itemKey] = text.trim();
        } else {
          // 全角の数字・記号も、数値として読む（日本語の入力環境で、入力しやすいため）
          const number = Number(normalizeNumberText(text));
          enteredItems[itemKey] = Number.isNaN(number) ? text : number;
        }
      }
    }
    const iso = jstDateTimeToIso(observedAt);
    const found = validateManualEntry(
      {
        equipmentId,
        category,
        observedAt: observedAt === '' ? '' : (iso ?? 'invalid'),
        items: enteredItems,
        note,
      },
      new Date(),
    );
    const parsed = ManualEntryInputSchema.safeParse({
      equipmentId,
      category,
      observedAt: iso,
      items: enteredItems,
      ...(note.trim() === '' ? {} : { note }),
    });
    if (found.length > 0 || !parsed.success) {
      setClientErrors(Object.fromEntries(found.map((item) => [item.name, item.message])));
      setFocusRequest((count) => count + 1);
      return;
    }
    setClientErrors({});
    const target = parsed.data;
    const result = await submit.run(() =>
      entry === undefined
        ? createManualEntry(api, target)
        : updateManualEntry(api, entry.entryId, target),
    );
    if (result.ok) {
      // 保存後の評価で、通知が作られることがある（ヘッダーの未読の件数を、すぐに読み直す）
      notifyUnreadChanged();
      if (entry === undefined) {
        writeRemembered({ equipmentId, category });
        clear();
      }
      props.onSaved(result.value);
    }
  }

  return (
    <form
      ref={formRef}
      className="entry-form"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="form-grid">
        <Field label={TEXT.equipment} name="equipmentId" error={errors.equipmentId} required>
          {(control) => (
            <select
              {...control}
              value={equipmentId}
              onChange={(event) => {
                setEquipmentId(event.target.value);
              }}
            >
              <option value="">{TEXT.selectPlaceholder}</option>
              {equipmentOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={TEXT.category} name="category" error={errors.category} required>
          {(control) => (
            <select
              {...control}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setValues({});
              }}
            >
              <option value="">{TEXT.selectPlaceholder}</option>
              {MANUAL_INPUT_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={TEXT.observedAt} name="observedAt" error={errors.observedAt} required>
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              value={observedAt}
              onChange={(event) => {
                setObservedAt(event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      {selectedCategory === undefined ? null : (
        <fieldset className="entry-items" data-testid="entry-items">
          <legend>
            {TEXT.items}（{CATEGORY_LABELS[selectedCategory]}）
          </legend>
          <p className="muted">
            {selectedCategory === 'SATISFACTION' ? TEXT.itemsHintSatisfaction : TEXT.itemsHint}
          </p>
          {errors.items === undefined ? null : (
            <div data-field="items">
              <p className="field-error">
                <Icon name="status-error" size={14} />
                {errors.items}
              </p>
            </div>
          )}
          <div className="form-grid">
            {items.map((item) =>
              selectedCategory === 'SATISFACTION' ? (
                // 満足度は、数値の文字入力ではなく、スターで選ぶ（D-18。9観点すべてが必須）
                <StarRating
                  key={item.itemKey}
                  label={item.label}
                  name={`items.${item.itemKey}`}
                  max={SATISFACTION_MAX_STARS}
                  value={starValue(values[item.itemKey])}
                  error={errors[`items.${item.itemKey}`]}
                  onChange={(stars) => {
                    setValues({ ...values, [item.itemKey]: String(stars) });
                  }}
                />
              ) : item.valueType === 'string' ? (
                <StatusCodeField
                  key={item.itemKey}
                  item={item}
                  value={values[item.itemKey] ?? ''}
                  error={errors[`items.${item.itemKey}`]}
                  onChange={(value) => {
                    setValues({ ...values, [item.itemKey]: value });
                  }}
                />
              ) : (
                <Field
                  key={item.itemKey}
                  label={item.unit === '' ? item.label : `${item.label}（${item.unit}）`}
                  name={`items.${item.itemKey}`}
                  error={errors[`items.${item.itemKey}`]}
                  hint={describeRange(item)}
                >
                  {(control) => (
                    <input
                      {...control}
                      inputMode="decimal"
                      autoComplete="off"
                      value={values[item.itemKey] ?? ''}
                      onChange={(event) => {
                        setValues({ ...values, [item.itemKey]: event.target.value });
                      }}
                    />
                  )}
                </Field>
              ),
            )}
          </div>
        </fieldset>
      )}

      <Field label={TEXT.note} name="note" error={errors.note}>
        {(control) => (
          <textarea
            {...control}
            rows={3}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>

      {/* 入力の検証に失敗したことを、スクリーンリーダーにも知らせる（フォーカスは、最初のエラーの項目へ移る。V-150） */}
      <FormError
        message={
          Object.keys(clientErrors).length > 0
            ? MESSAGES.form.errorSummary(Object.keys(clientErrors).length)
            : submit.formMessage
        }
      />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {submit.busy
            ? MESSAGES.form.saving
            : entry === undefined
              ? TEXT.save
              : MESSAGES.form.save}
        </button>
        {entry === undefined ? (
          <button type="button" className="button-secondary" onClick={clear}>
            {MESSAGES.form.clear}
          </button>
        ) : (
          <button type="button" className="button-secondary" onClick={props.onCancel}>
            {MESSAGES.form.cancel}
          </button>
        )}
      </div>
    </form>
  );
}
