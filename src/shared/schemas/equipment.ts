/** 設備（ハウス・ロボット・センサー）のスキーマ。data-dictionary.md 2章。 */

import { z } from 'zod';
import {
  DEFAULT_INTERVAL_MINUTES_BY_TYPE,
  MIN_STALE_THRESHOLD_MINUTES,
  EQUIPMENT_INTERVAL_MINUTES_OPTIONS,
  type EquipmentType,
} from '../constants/status.ts';
import {
  EquipmentIdSchema,
  EquipmentTypeSchema,
  IsoDateTimeSchema,
  type EquipmentId,
} from './common.ts';
import { FilePathSchema } from './file-path.ts';

/** 設備の名称。 */
const EquipmentNameSchema = z
  .string()
  .trim()
  .min(1, '名称は必須です')
  .max(200, '名称は200文字以内で指定してください');

/** ファイルサーバーのデータ上の識別子（機体ID・センサーID）。仮（Q-001, Q-004）。 */
const ExternalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200, 'データ上の識別子は200文字以内で指定してください');

/** ファイルパスは、ロボット・センサーだけが持つ（ハウスは持てない）。 */
function hasValidSourceFilePath(equipment: {
  readonly equipmentType: EquipmentType;
  readonly sourceFilePath?: string | undefined;
}): boolean {
  return equipment.equipmentType !== 'FACILITY' || equipment.sourceFilePath === undefined;
}
const SOURCE_FILE_PATH_RULE_ISSUE = {
  message: 'ファイルパスは、ロボット・センサーだけに指定できます',
  path: ['sourceFilePath'],
};

/** 取得間隔（分）。候補は EQUIPMENT_INTERVAL_MINUTES_OPTIONS（Issue #197。D-11）。 */
export const EquipmentIntervalSchema = z.union(
  EQUIPMENT_INTERVAL_MINUTES_OPTIONS.map((minutes) => z.literal(minutes)),
  { error: '取得間隔は、1・5・10・15・30・60 分から選んでください' },
);

/** 取得間隔は、ロボット・センサーだけが持つ（ハウスは持てない）。 */
function hasValidInterval(equipment: {
  readonly equipmentType: EquipmentType;
  readonly intervalMinutes?: number | undefined;
}): boolean {
  return equipment.equipmentType !== 'FACILITY' || equipment.intervalMinutes === undefined;
}
const INTERVAL_RULE_ISSUE = {
  message: '取得間隔は、ロボット・センサーだけに指定できます',
  path: ['intervalMinutes'],
};

/** 親のハウス（facilityId）は、ロボット・センサーは必須、ハウス自身は持たない。 */
function hasConsistentParent(equipment: {
  readonly equipmentType: EquipmentType;
  readonly facilityId?: EquipmentId | undefined;
}): boolean {
  return (equipment.equipmentType === 'FACILITY') === (equipment.facilityId === undefined);
}
const PARENT_RULE_ISSUE = {
  message: 'ロボット・センサーは親のハウスが必須で、ハウスは親を持てません',
  path: ['facilityId'],
};

export const EquipmentSchema = z
  .object({
    equipmentId: EquipmentIdSchema,
    equipmentType: EquipmentTypeSchema,
    name: EquipmentNameSchema,
    /** 親のハウス。ロボット・センサーは必須、ハウス自身は持たない。 */
    facilityId: EquipmentIdSchema.optional(),
    /** ファイルサーバーのデータ上の識別子との対応。 */
    externalId: ExternalIdSchema.optional(),
    /** ファイルサーバー（HTTP）の、取得するファイルのパス（ロボット・センサーだけ。Issue #119。ADR-0023）。 */
    sourceFilePath: FilePathSchema.optional(),
    /** 取り込みの取得間隔（分。ロボット・センサーだけ。Issue #197。ADR-0016 の D-11）。省略は、種別ごとの既定（DEFAULT_INTERVAL_MINUTES_BY_TYPE）。 */
    intervalMinutes: EquipmentIntervalSchema.optional(),
    isDeleted: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .refine(hasConsistentParent, PARENT_RULE_ISSUE)
  .refine(hasValidSourceFilePath, SOURCE_FILE_PATH_RULE_ISSUE)
  .refine(hasValidInterval, INTERVAL_RULE_ISSUE);
export type Equipment = z.infer<typeof EquipmentSchema>;

/** 設備の取得間隔の、実際の値（分）。指定がなければ、種別ごとの既定。ハウスは、持たない（undefined）。 */
export function effectiveIntervalMinutes(equipment: {
  readonly equipmentType: EquipmentType;
  readonly intervalMinutes?: number | undefined;
}): number | undefined {
  if (equipment.equipmentType === 'FACILITY') {
    return undefined;
  }
  return equipment.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES_BY_TYPE[equipment.equipmentType];
}

/**
 * 設備の「データが古い」の基準（分）。その設備の取得間隔 × 倍数（既定 3）、ただし最低 `MIN_STALE_THRESHOLD_MINUTES`（3 分）。
 * ハウスは、基準を持たない（配下の設備で判定する）（undefined）。Issue #198。ADR-0016 の D-12。
 */
export function staleThresholdMinutesOf(
  equipment: {
    readonly equipmentType: EquipmentType;
    readonly intervalMinutes?: number | undefined;
  },
  multiplier: number,
): number | undefined {
  const interval = effectiveIntervalMinutes(equipment);
  return interval === undefined
    ? undefined
    : Math.max(MIN_STALE_THRESHOLD_MINUTES, interval * multiplier);
}

/** GET /equipment の応答。ハウス → ロボット／センサーの階層（FR-2.2）。 */
export const EquipmentTreeResponseSchema = z.object({
  facilities: z.array(
    z.object({
      facility: EquipmentSchema,
      children: z.array(EquipmentSchema),
    }),
  ),
});
export type EquipmentTreeResponse = z.infer<typeof EquipmentTreeResponseSchema>;

/** POST /equipment の入力（FR-2.1、2.2）。ロボット・センサーは、親のハウス（facilityId）が必須。 */
export const EquipmentCreateRequestSchema = z
  .object({
    equipmentId: EquipmentIdSchema,
    equipmentType: EquipmentTypeSchema,
    name: EquipmentNameSchema,
    facilityId: EquipmentIdSchema.optional(),
    externalId: ExternalIdSchema.optional(),
    sourceFilePath: FilePathSchema.optional(),
    intervalMinutes: EquipmentIntervalSchema.optional(),
  })
  .refine(hasConsistentParent, PARENT_RULE_ISSUE)
  .refine(hasValidSourceFilePath, SOURCE_FILE_PATH_RULE_ISSUE)
  .refine(hasValidInterval, INTERVAL_RULE_ISSUE);
export type EquipmentCreateRequest = z.infer<typeof EquipmentCreateRequestSchema>;

/** PUT /equipment/{id} の入力。設備IDと種別は変更できない。 */
export const EquipmentUpdateRequestSchema = z.object({
  name: EquipmentNameSchema,
  facilityId: EquipmentIdSchema.optional(),
  externalId: ExternalIdSchema.optional(),
  /** 省略は、ファイルパスを持たない状態にする（データ上の識別子と同じ）。ハウスは、サービスで拒否する。 */
  sourceFilePath: FilePathSchema.optional(),
  /** 省略は、既定（種別ごと）に戻す。ハウスは、サービスで拒否する。 */
  intervalMinutes: EquipmentIntervalSchema.optional(),
});
export type EquipmentUpdateRequest = z.infer<typeof EquipmentUpdateRequestSchema>;
