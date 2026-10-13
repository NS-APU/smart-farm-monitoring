/**
 * 手動入力のスキーマと検証（FR-4.1、FR-4.2、functional-specification.md 3.5〜3.7）。
 * 検証は画面と API で共有する（画面は即時のフィードバック、API が正）。
 * 手動入力は、1回の入力（設備・カテゴリ・計測日時・項目の値・備考）を1件として保持し、
 * 項目ごとの観測値（取得元＝手動入力、入力者）としても保存する。
 */

import { z } from 'zod';
import type { FieldError } from '../errors.ts';
import {
  CATEGORY_LABELS,
  MANUAL_INPUT_CATEGORIES,
  findItemDefinition,
  isValidItemValue,
  itemsOfCategory,
  type Category,
  type ItemDefinition,
} from '../constants/items.ts';
import { FUTURE_TOLERANCE_MINUTES, MAX_NOTE_LENGTH } from '../constants/limits.ts';
import { EVALUATION_STATUSES } from '../constants/status.ts';
import { MS_PER_MINUTE } from '../time.ts';
import {
  CategorySchema,
  EquipmentIdSchema,
  IsoDateTimeSchema,
  UserIdSchema,
  ViewpointIdSchema,
} from './common.ts';

/** カテゴリごとに、手動入力できる項目（取得元に手動入力を含むもの）。 */
export function manualItemsOfCategory(category: Category): readonly ItemDefinition[] {
  return itemsOfCategory(category).filter((item) => item.origins.includes('MANUAL'));
}

export const ManualEntryItemsSchema = z.record(z.string(), z.number('値は数値で指定してください'));

/** POST・PUT /manual-entries の入力。 */
export const ManualEntryInputSchema = z.object({
  equipmentId: EquipmentIdSchema,
  category: CategorySchema,
  observedAt: IsoDateTimeSchema,
  /** 項目の識別子 → 値（カテゴリに属する項目のみ）。 */
  items: ManualEntryItemsSchema,
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
});
export type ManualEntryInput = z.infer<typeof ManualEntryInputSchema>;

/** 保持している手動入力（1回の入力）。 */
export const ManualEntrySchema = ManualEntryInputSchema.extend({
  entryId: z.string().min(1),
  enteredBy: UserIdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  isDeleted: z.boolean(),
});
export type ManualEntry = z.infer<typeof ManualEntrySchema>;

export const ManualEntryListResponseSchema = z.object({
  items: z.array(ManualEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ManualEntryListResponse = z.infer<typeof ManualEntryListResponseSchema>;

/** 保存後の、関連する観点のステータス（FR-4.1.5）。 */
export const ManualEntryViewpointStatusSchema = z.object({
  viewpointId: ViewpointIdSchema,
  name: z.string(),
  status: z.enum(EVALUATION_STATUSES),
});
export type ManualEntryViewpointStatus = z.infer<typeof ManualEntryViewpointStatusSchema>;

export const ManualEntrySaveResponseSchema = z.object({
  entry: ManualEntrySchema,
  viewpointStatuses: z.array(ManualEntryViewpointStatusSchema),
});
export type ManualEntrySaveResponse = z.infer<typeof ManualEntrySaveResponseSchema>;

export interface ManualEntryDraft {
  readonly equipmentId: string;
  readonly category: string;
  /** ISO 8601（UTC）。入力がなければ空の文字列。 */
  readonly observedAt: string;
  /** 項目の識別子 → 値。未入力の項目は含めない。 */
  readonly items: Readonly<Record<string, unknown>>;
  readonly note: string;
}

/** 項目の入力できる値の説明（例: 「0以上の整数」「1以上5以下の整数」）。 */
export function describeRange(item: ItemDefinition): string {
  const type = item.valueType === 'integer' ? '整数' : '数値';
  const range =
    item.min !== undefined && item.max !== undefined
      ? `${String(item.min)}以上${String(item.max)}以下の`
      : item.min !== undefined
        ? `${String(item.min)}以上の`
        : '';
  return `${range}${type}`;
}

/** 手動入力の項目の値が不正な場合の理由を返す。正しければ null。 */
export function findItemValueViolation(item: ItemDefinition, value: unknown): string | null {
  return isValidItemValue(item, value)
    ? null
    : `${item.label}は${describeRange(item)}で指定してください`;
}

/**
 * 手動入力の入力内容を検証し、項目ごとのエラーを返す（空配列なら有効）。
 * - 必須: 設備・カテゴリ・計測日時（FR-4.1.1）。1つ以上の項目の値
 * - 手動入力できるカテゴリ、カテゴリに属する項目のみ
 * - 値の型・範囲（FR-4.1.3）。計測日時は、未来（許容 5 分）を許さない
 */
export function validateManualEntry(draft: ManualEntryDraft, now: Date): FieldError[] {
  const errors: FieldError[] = [];
  if (draft.equipmentId.trim() === '') {
    errors.push({ name: 'equipmentId', message: '対象の設備を選択してください' });
  }

  const category = MANUAL_INPUT_CATEGORIES.find((candidate) => candidate === draft.category);
  if (draft.category === '') {
    errors.push({ name: 'category', message: 'カテゴリを選択してください' });
  } else if (category === undefined) {
    errors.push({ name: 'category', message: 'このカテゴリは手動で入力できません' });
  }

  if (draft.observedAt === '') {
    errors.push({ name: 'observedAt', message: '計測日時を入力してください' });
  } else {
    const observedMs = Date.parse(draft.observedAt);
    if (Number.isNaN(observedMs)) {
      errors.push({ name: 'observedAt', message: '計測日時の形式が正しくありません' });
    } else if (observedMs > now.getTime() + FUTURE_TOLERANCE_MINUTES * MS_PER_MINUTE) {
      errors.push({ name: 'observedAt', message: '計測日時に未来の日時は指定できません' });
    }
  }

  const entries = Object.entries(draft.items);
  if (entries.length === 0) {
    errors.push({ name: 'items', message: '1つ以上の項目を入力してください' });
  }
  const allowed = category === undefined ? undefined : manualItemsOfCategory(category);
  for (const [itemKey, value] of entries) {
    const item = findItemDefinition(itemKey);
    if (
      item === undefined ||
      allowed?.some((candidate) => candidate.itemKey === itemKey) !== true
    ) {
      errors.push({
        name: `items.${itemKey}`,
        message:
          category === undefined
            ? '項目を指定できません'
            : `この項目は「${CATEGORY_LABELS[category]}」に含まれません`,
      });
      continue;
    }
    const violation = findItemValueViolation(item, value);
    if (violation !== null) {
      errors.push({ name: `items.${itemKey}`, message: violation });
    }
  }

  if (draft.note.length > MAX_NOTE_LENGTH) {
    errors.push({
      name: 'note',
      message: `備考は${String(MAX_NOTE_LENGTH)}文字以内で入力してください`,
    });
  }
  return errors;
}
