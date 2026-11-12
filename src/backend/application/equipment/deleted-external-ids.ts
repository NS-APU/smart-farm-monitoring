/**
 * 削除した設備の、データ上の識別子（`externalId`）の一覧（Issue #231。ADR-0018 の D-28）。
 * 取り込みファイルに残る、削除した設備のレコードを、「削除済みの設備」として、棄却数と別に数えるために使う。
 * 設備を削除すると、設備の記録が消える（#229）ため、設備の記録とは別に、設定の 1 項目として残す。
 * 同じ識別子で設備を登録し直せば、登録中の設備が優先される（取り込み側の判定。D-28: 再登録を許す）。
 */

import { z } from 'zod';
import { IsoDateTimeSchema } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { SettingsRepository } from '../ports/repositories.ts';

export const DELETED_EXTERNAL_IDS_KEY = 'equipment.deletedExternalIds';

const DeletedExternalIdSchema = z.object({
  externalId: z.string().min(1),
  /** 設備の種別（取り込み元の種別と同じ。ロボット・センサーだけが、データ上の識別子を持つ）。 */
  equipmentType: z.enum(['ROBOT', 'SENSOR']),
  deletedAt: IsoDateTimeSchema,
});
export type DeletedExternalId = z.infer<typeof DeletedExternalIdSchema>;

/** 削除済みの設備の識別子の一覧。保存がなければ、空。 */
export async function listDeletedExternalIds(
  settings: SettingsRepository,
): Promise<DeletedExternalId[]> {
  const stored = await settings.get(DELETED_EXTERNAL_IDS_KEY);
  return stored === undefined ? [] : z.array(DeletedExternalIdSchema).parse(stored);
}

/** 削除した設備の識別子を、一覧に加える（同じ種別・同じ識別子は、新しい削除日時にする）。識別子のない設備（ハウスなど）は、加えない。 */
export async function recordDeletedExternalIds(
  settings: SettingsRepository,
  deleted: readonly Equipment[],
  deletedAt: Date,
): Promise<void> {
  const additions = deleted.flatMap((equipment) =>
    equipment.externalId === undefined ||
    (equipment.equipmentType !== 'ROBOT' && equipment.equipmentType !== 'SENSOR')
      ? []
      : [
          {
            externalId: equipment.externalId,
            equipmentType: equipment.equipmentType,
            deletedAt: deletedAt.toISOString(),
          },
        ],
  );
  if (additions.length === 0) {
    return;
  }
  const merged = new Map<string, DeletedExternalId>();
  for (const entry of [...(await listDeletedExternalIds(settings)), ...additions]) {
    merged.set(`${entry.equipmentType}|${entry.externalId}`, entry);
  }
  await settings.set(DELETED_EXTERNAL_IDS_KEY, [...merged.values()]);
}
