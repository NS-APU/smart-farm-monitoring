/**
 * 変更履歴（SC-08）の、変更前後の値の表示（UC-18）。手動入力は、項目と値（単位つき）と、計測日時・設備・カテゴリ・備考。
 * その他は、内容を開いて確認する。変更前後の両方があるとき（編集）は、**全項目を残したまま**、値が変わった項目に「変更」、
 * 追加された項目に「追加」、なくなった項目に「なし」の印（文字つきのタグ。太字・枠線は CSS。色だけに頼らない）を付ける
 * （Issue #190。SC-08-5。比べ方の規則は `lib/audit-diff.ts`）。登録（変更前なし）・削除（変更後なし）には、印を付けない。
 */

import type { ReactNode } from 'react';
import { CATEGORY_LABELS, findItemDefinition } from '@smart-farm/shared/constants/items';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { formatThreshold } from '@smart-farm/shared/criteria-text';
import {
  auditFieldsOf,
  diffFields,
  recordOf,
  type AuditField,
  type DiffMark,
  type FieldDiff,
  type FieldOptions,
} from '../lib/audit-diff.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { formatDateTimeJst } from './format.ts';

const TEXT = MESSAGES.history;

/** 手動入力の、項目の値以外の内容（計測日時・設備・カテゴリ・備考）。修正で、これらだけが変わった場合も、履歴で分かるようにする。 */
function entryMetaOf(record: Readonly<Record<string, unknown>>): AuditField[] {
  const { observedAt, equipmentId, category, note } = record;
  const meta: AuditField[] = [];
  if (typeof observedAt === 'string') {
    meta.push({
      key: 'meta:observedAt',
      label: TEXT.metaObservedAt,
      value: observedAt,
      text: formatDateTimeJst(observedAt),
    });
  }
  if (typeof equipmentId === 'string') {
    meta.push({
      key: 'meta:equipmentId',
      label: TEXT.metaEquipment,
      value: equipmentId,
      text: equipmentId,
    });
  }
  if (typeof category === 'string') {
    const labels: Readonly<Record<string, string>> = CATEGORY_LABELS;
    meta.push({
      key: 'meta:category',
      label: TEXT.metaCategory,
      value: category,
      text: labels[category] ?? category,
    });
  }
  // 空の備考は、表示しない（ないものとして、比べる）
  if (typeof note === 'string' && note !== '') {
    meta.push({ key: 'meta:note', label: TEXT.metaNote, value: note, text: note });
  }
  return meta;
}

/** 手動入力の、項目ごとの値（単位つき）。 */
function entryItemsOf(items: Readonly<Record<string, unknown>>): AuditField[] {
  return Object.entries(items).map(([itemKey, value]) => {
    const item = findItemDefinition(itemKey);
    return {
      key: `item:${itemKey}`,
      label: item?.label ?? itemKey,
      value,
      text: `${typeof value === 'number' ? formatThreshold(value) : String(value)}${item?.unit ?? ''}`,
    };
  });
}

/** 手動入力の内容（項目と、項目以外）。項目の値がなければ（記録の形が違う）、undefined。 */
function entryFieldsOf(
  value: unknown,
): { readonly items: AuditField[]; readonly meta: AuditField[] } | undefined {
  const record = recordOf(value);
  const items = recordOf(record?.items);
  return record === undefined || items === undefined
    ? undefined
    : { items: entryItemsOf(items), meta: entryMetaOf(record) };
}

/** 変更点の印を付けない項目（判断基準の版・既定値かどうか・更新日時・更新者。表示は残す）。 */
const IGNORED_FIELD_KEYS: Readonly<Record<string, readonly string[]>> = {
  criteria: ['version', 'isDefault', 'updatedAt', 'updatedBy'],
};

function fieldOptionsOf(targetType: string): FieldOptions {
  const labels: Readonly<Record<string, string>> = TEXT.fieldLabels;
  const sourceNames: Readonly<Record<string, string>> = MESSAGES.ingestion.sourceNames;
  return {
    ignoredKeys: IGNORED_FIELD_KEYS[targetType] ?? [],
    labelOf: (key) => labels[key] ?? key,
    elementLabelOf: (parentKey, id) =>
      parentKey === 'criteria' ? getMetricMeta(id).label : (sourceNames[id] ?? id),
  };
}

/** 変更点の印（文字つきのタグ。太字・枠線は CSS。色だけに頼らない）。 */
function DiffMarkTag(props: { readonly kind: DiffMark }): ReactNode {
  return <span className={`diff-mark diff-mark-${props.kind}`}>{TEXT.diffMarks[props.kind]}</span>;
}

/** 閉じた状態でも見える、変わった項目名の 1 行（変更後の側）。 */
function changeSummaryOf(diff: FieldDiff): string {
  const parts = [
    diff.changedLabels.length > 0 ? TEXT.summaryChanged(diff.changedLabels) : '',
    diff.addedLabels.length > 0 ? TEXT.summaryAdded(diff.addedLabels) : '',
    diff.vanishedLabels.length > 0 ? TEXT.summaryRemoved(diff.vanishedLabels) : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? TEXT.noChanges : parts.join(TEXT.summarySeparator);
}

type Side = 'before' | 'after';

export interface AuditValueProps {
  readonly targetType: string;
  readonly value: unknown;
  /** 反対側（変更前の側なら変更後、変更後の側なら変更前）の値。両方があるときだけ、変更点の印を付ける。 */
  readonly counterpart?: unknown;
  readonly side?: Side;
}

function ManualEntryValue(props: {
  readonly own: NonNullable<ReturnType<typeof entryFieldsOf>>;
  readonly other: ReturnType<typeof entryFieldsOf>;
  readonly side: Side;
}): ReactNode {
  const { own, other, side } = props;
  const diff =
    other === undefined
      ? undefined
      : diffFields(side, [...own.items, ...own.meta], [...other.items, ...other.meta]);
  const markOf = (field: AuditField): ReactNode => {
    const kind = diff?.marks.get(field.key);
    return kind === undefined ? null : <DiffMarkTag kind={kind} />;
  };
  const vanishedOf = (prefix: string): AuditField[] =>
    (diff?.vanished ?? []).filter((field) => field.key.startsWith(prefix));
  const meta = [...own.meta, ...vanishedOf('meta:')];
  return (
    <div>
      <ul className="entry-values">
        {own.items.map((field) => (
          <li key={field.key}>
            {field.label}: <strong>{field.text}</strong>
            {markOf(field)}
          </li>
        ))}
        {vanishedOf('item:').map((field) => (
          <li key={field.key}>
            {field.label}: <DiffMarkTag kind="removed" />
          </li>
        ))}
      </ul>
      {meta.length === 0 ? null : (
        <dl className="audit-meta">
          {meta.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd className={field.key === 'meta:note' ? 'entry-note' : undefined}>
                {diff?.vanished.includes(field) === true ? (
                  <DiffMarkTag kind="removed" />
                ) : (
                  <>
                    {field.text}
                    {markOf(field)}
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function FieldDetails(props: {
  readonly fields: readonly AuditField[];
  readonly diff: FieldDiff;
  readonly side: Side;
}): ReactNode {
  const { fields, diff, side } = props;
  return (
    <div>
      {side === 'after' ? <p className="audit-changes">{changeSummaryOf(diff)}</p> : null}
      <details>
        <summary>{TEXT.showDetail}</summary>
        {fields.map((field) => {
          const kind = diff.marks.get(field.key);
          return (
            <div key={field.key} className="audit-field">
              {kind === undefined ? null : (
                <p className="audit-field-head">
                  {field.label}
                  <DiffMarkTag kind={kind} />
                </p>
              )}
              <pre className="audit-json">{field.text}</pre>
            </div>
          );
        })}
        {diff.vanished.map((field) => (
          <div key={field.key} className="audit-field">
            <p className="audit-field-head">
              {field.label}
              <DiffMarkTag kind="removed" />
            </p>
          </div>
        ))}
      </details>
    </div>
  );
}

/** 変更前後の値の表示。手動入力は、項目と値（単位つき）。その他は、内容を開いて確認できる。 */
export function AuditValue(props: AuditValueProps): ReactNode {
  if (props.value === undefined) {
    return <span className="muted">{MESSAGES.common.missingValue}</span>;
  }
  const { side } = props;
  const compare = side !== undefined && props.counterpart !== undefined;
  if (props.targetType === 'manual-entry') {
    const own = entryFieldsOf(props.value);
    if (own !== undefined) {
      return (
        <ManualEntryValue
          own={own}
          other={compare ? entryFieldsOf(props.counterpart) : undefined}
          side={side ?? 'after'}
        />
      );
    }
  } else if (compare) {
    const options = fieldOptionsOf(props.targetType);
    const own = auditFieldsOf(props.value, options);
    const other = auditFieldsOf(props.counterpart, options);
    if (own !== undefined && other !== undefined) {
      return <FieldDetails fields={own} diff={diffFields(side, own, other)} side={side} />;
    }
  }
  return (
    <details>
      <summary>{TEXT.showDetail}</summary>
      <pre className="audit-json">{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}
