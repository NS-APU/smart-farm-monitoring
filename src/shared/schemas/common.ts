/**
 * 共通のスキーマ（識別子・日時・列挙値）。
 * スキーマと型は1つの定義から導出する（coding-standards.md「型とデータ」）。
 */

import { z } from 'zod';
import {
  EQUIPMENT_TYPES,
  EVALUATION_STATUSES,
  HORIZONS,
  JUDGED_STATUSES,
  NOTIFICATION_KINDS,
  OBSERVATION_QUALITIES,
  OBSERVATION_SOURCES,
  PERIOD_DAYS_OPTIONS,
  READ_STATES,
} from '../constants/status.ts';
import { CATEGORIES } from '../constants/items.ts';
import { VIEWPOINT_IDS } from '../constants/viewpoints.ts';

/** 時刻は UTC の ISO 8601（末尾 Z）で保存・受け渡しする（data-dictionary.md 1章）。 */
export const IsoDateTimeSchema = z.iso.datetime({
  message: '日時は ISO 8601（UTC）で指定してください',
});
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const IDENTIFIER_MESSAGE = '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）';

/** 種類ごとに型で区別する識別子（ブランド型）。 */
export const EquipmentIdSchema = z
  .string()
  .min(1, '設備IDは必須です')
  .max(100, '設備IDは100文字以内で指定してください')
  .regex(IDENTIFIER_PATTERN, IDENTIFIER_MESSAGE)
  .brand<'EquipmentId'>();
export type EquipmentId = z.infer<typeof EquipmentIdSchema>;

export const UserIdSchema = z
  .string()
  .min(1, 'ユーザーIDは必須です')
  .max(100, 'ユーザーIDは100文字以内で指定してください')
  .regex(IDENTIFIER_PATTERN, IDENTIFIER_MESSAGE)
  .brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

export const NotificationIdSchema = z.string().min(1).max(100).brand<'NotificationId'>();
export type NotificationId = z.infer<typeof NotificationIdSchema>;

export const ViewpointIdSchema = z.enum(VIEWPOINT_IDS);
export const EvaluationStatusSchema = z.enum(EVALUATION_STATUSES);
export const JudgedStatusSchema = z.enum(JUDGED_STATUSES);
export const HorizonSchema = z.enum(HORIZONS);
/** 長期視点の期間（日）。PERIOD_DAYS_OPTIONS から導出する。 */
export const PeriodDaysSchema = z.union(PERIOD_DAYS_OPTIONS.map((days) => z.literal(days)));
export const EquipmentTypeSchema = z.enum(EQUIPMENT_TYPES);
export const CategorySchema = z.enum(CATEGORIES);
export const ObservationSourceSchema = z.enum(OBSERVATION_SOURCES);
export const ObservationQualitySchema = z.enum(OBSERVATION_QUALITIES);
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export const ReadStateSchema = z.enum(READ_STATES);

/** 境界（API・ファイル・環境変数）で受けた未検証の値から、識別子の型を作る。 */
export function toEquipmentId(value: string): EquipmentId {
  return EquipmentIdSchema.parse(value);
}

export function toUserId(value: string): UserId {
  return UserIdSchema.parse(value);
}
