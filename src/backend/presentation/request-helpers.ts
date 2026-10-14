/** ハンドラで共通に使う、リクエストの読み取りの補助（操作者・パスのパラメータ・対象の設備）。 */

import type { Context } from 'hono';
import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type { ApiDeps, AppEnv } from './api-deps.ts';

/** 操作者（ログイン中の利用者）。認証は、ルートの宣言（route-table.ts）に従って済んでいる。 */
export function actorOf(c: Context<AppEnv>): UserId {
  return c.get('user').userId;
}

/** パスのパラメータ。空・未指定は、リソースが見つからないものとして NOT_FOUND（メッセージは、対象に合わせて指定できる）。 */
export function pathParam(
  c: Context<AppEnv>,
  name: string,
  notFoundMessage = '指定されたリソースが見つかりません',
): string {
  const value = c.req.param(name);
  if (value === undefined || value === '') {
    throw new AppError('NOT_FOUND', notFoundMessage);
  }
  return value;
}

/** 設備の指定がなければ、最初のハウスを対象にする（ヘッダーで選択中の設備がない場合）。 */
export async function resolveEquipmentId(
  deps: Pick<ApiDeps, 'equipmentService'>,
  requested: EquipmentId | undefined,
): Promise<EquipmentId> {
  if (requested !== undefined) {
    return requested;
  }
  const firstFacility = (await deps.equipmentService.getTree()).facilities[0];
  if (firstFacility === undefined) {
    throw new AppError('NOT_FOUND', '設備が登録されていません');
  }
  return firstFacility.facility.equipmentId;
}
