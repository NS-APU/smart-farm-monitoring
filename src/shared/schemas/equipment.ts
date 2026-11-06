/** 設備（ハウス・ロボット・センサー）のスキーマ。data-dictionary.md 2章。 */

import { z } from 'zod';
import type { EquipmentType } from '../constants/status.ts';
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
    isDeleted: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .refine(hasConsistentParent, PARENT_RULE_ISSUE)
  .refine(hasValidSourceFilePath, SOURCE_FILE_PATH_RULE_ISSUE);
export type Equipment = z.infer<typeof EquipmentSchema>;

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
  })
  .refine(hasConsistentParent, PARENT_RULE_ISSUE)
  .refine(hasValidSourceFilePath, SOURCE_FILE_PATH_RULE_ISSUE);
export type EquipmentCreateRequest = z.infer<typeof EquipmentCreateRequestSchema>;

/** PUT /equipment/{id} の入力。設備IDと種別は変更できない。 */
export const EquipmentUpdateRequestSchema = z.object({
  name: EquipmentNameSchema,
  facilityId: EquipmentIdSchema.optional(),
  externalId: ExternalIdSchema.optional(),
  /** 省略は、ファイルパスを持たない状態にする（データ上の識別子と同じ）。ハウスは、サービスで拒否する。 */
  sourceFilePath: FilePathSchema.optional(),
});
export type EquipmentUpdateRequest = z.infer<typeof EquipmentUpdateRequestSchema>;
