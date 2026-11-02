/** 複数のハンドラで共通に使う、クエリ・本文のスキーマ（検証内容・既定値・エラーの形式を1か所に置く）。 */

import { z } from 'zod';
import { SORT_DIRECTIONS } from '@smart-farm/shared/constants/sorting';
import { PushEndpointSchema } from '@smart-farm/shared/schemas/notification';
import {
  EquipmentIdSchema,
  HorizonSchema,
  NotificationKindSchema,
  PeriodDaysSchema,
  ReadStateSchema,
} from '@smart-farm/shared/schemas/common';

/**
 * ダッシュボード・観点の詳細のクエリ: 設備（省略時は最初のハウス）、視点（短期・長期）、長期の期間。
 * 期間を省略すると、観点ごとの既定の期間（満足度は 30 日、ほかは 7 日。defaultPeriodDays）で評価した結果を返す。
 */
export const HorizonQuerySchema = z.object({
  equipmentId: EquipmentIdSchema.optional(),
  horizon: HorizonSchema.default('LONG'),
  periodDays: z.coerce.number().pipe(PeriodDaysSchema).optional(),
});

/** 通知の絞り込み（一覧のクエリと、一括既読の本文で共通）。 */
export const NotificationFilterSchema = z.object({
  kind: NotificationKindSchema.optional(),
  readState: ReadStateSchema.optional(),
});

/** Web Push の端末（endpoint）の指定。購読の状況の問い合わせと、解除の本文で共通。 */
export const EndpointOnlySchema = z.object({ endpoint: PushEndpointSchema.optional() });

/** 並び順の向き（既定は新しい順）。 */
export const SortDirectionSchema = z.enum(SORT_DIRECTIONS).default('desc');

/** 日時（ISO 8601 の文字列）を Date にする。省略は undefined のまま。 */
export function toOptionalDate(iso: string | undefined): Date | undefined {
  return iso === undefined ? undefined : new Date(iso);
}
