/** ハンドラで共通に使う、リクエストの読み取りの補助（操作者・パスのパラメータ・対象の設備）。 */

import type { Context } from 'hono';
import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import {
  canViewEquipment,
  filterEquipmentTree,
  type EquipmentScope,
} from '../application/access/facility-scope.ts';
import { EQUIPMENT_NOT_FOUND_MESSAGE } from '../application/equipment/require-active-equipment.ts';
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

/** 操作者（ログイン中の利用者）の閲覧範囲（Issue #330）。管理者は全設備、一般は割り当てたハウスと配下の設備。 */
export function scopeOfRequest(
  c: Context<AppEnv>,
  deps: Pick<ApiDeps, 'facilityScope'>,
): Promise<EquipmentScope> {
  return deps.facilityScope.scopeOf(c.get('user'));
}

/**
 * 設備の指定がなければ、閲覧できる最初のハウスを対象にする（ヘッダーで選択中の設備がない場合）。
 * 閲覧範囲外の設備の指定は、存在しないもの（NOT_FOUND）として扱う（設備の有無を、漏らさない）。
 */
export async function resolveEquipmentId(
  deps: Pick<ApiDeps, 'equipmentService'>,
  requested: EquipmentId | undefined,
  scope: EquipmentScope,
): Promise<EquipmentId> {
  if (requested !== undefined) {
    if (!canViewEquipment(scope, requested)) {
      throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
    }
    return requested;
  }
  const firstFacility = filterEquipmentTree(scope, await deps.equipmentService.getTree())
    .facilities[0];
  if (firstFacility === undefined) {
    throw new AppError(
      'NOT_FOUND',
      scope.kind === 'all' ? '設備が登録されていません' : '閲覧できる設備がありません',
    );
  }
  return firstFacility.facility.equipmentId;
}
