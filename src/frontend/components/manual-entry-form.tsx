/**
 * 手動入力のフォーム（SC-06 の入力、SC-07 の修正。FR-4.1、FR-4.2.2）。
 * 対象の設備・カテゴリ・計測日時（日本時間）を必須とし、カテゴリを選ぶと、そのカテゴリの項目だけを表示する。
 * 入力は、API と同じ検証（shared）で、保存の前に確認する（API が正）。保存後は、関連観点のステータスを返す。
 */

import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  CATEGORY_LABELS,
  MANUAL_INPUT_CATEGORIES,
  type Category,
} from '@smart-farm/shared/constants/items';
import {
  ManualEntryInputSchema,
  describeRange,
  manualItemsOfCategory,
  validateManualEntry,
  type ManualEntry,
  type ManualEntrySaveResponse,
} from '@smart-farm/shared/schemas/manual-entry';
import { createManualEntry, updateManualEntry } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { useAppState } from './app-state.tsx';
import { equipmentOptionLabel } from './equipment-options.ts';
import { Field, FormError } from './form-controls.tsx';
import { isoToJstDateTimeInput, jstDateTimeToIso } from './jst.ts';
import { normalizeNumberText } from './number-text.ts';
import { notifyUnreadChanged } from './unread-events.ts';
import { Icon } from './icon.tsx';

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

function categoryOf(value: string): Category | undefined {
  return MANUAL_INPUT_CATEGORIES.find((candidate) => candidate === value);
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
      if (items.some((item) => item.itemKey === itemKey) && text.trim() !== '') {
        // 全角の数字・記号も、数値として読む（日本語の入力環境で、入力しやすいため）
        const number = Number(normalizeNumberText(text));
        enteredItems[itemKey] = Number.isNaN(number) ? text : number;
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
          <p className="muted">{TEXT.itemsHint}</p>
          {errors.items === undefined ? null : (
            <div data-field="items">
              <p className="field-error">
                <Icon name="status-error" size={14} />
                {errors.items}
              </p>
            </div>
          )}
          <div className="form-grid">
            {items.map((item) => (
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
            ))}
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
