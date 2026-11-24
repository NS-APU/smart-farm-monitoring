/**
 * ステータスコード管理のユースケース（UC-17。FR-3）。ロボットのステータスコードの定義（コード値・名称・説明・カテゴリ）。
 * 登録・編集・削除（論理削除）は、変更履歴に記録し、評価に反映する（収穫速度・メンテナンス性・耐久性の判定に使うため）。
 * 削除済みのコード値を、もう一度登録した場合は、削除を取り消して、定義を更新する（暫定）。
 * 未登録のコード値の一覧（SC-12-5。#158）: 取り込みが記録した、定義にないコード値から、登録済みのものを除いて返す。
 */

import { AppError, conflictError } from '@smart-farm/shared/errors';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  StatusCodeCreateRequest,
  StatusCodeDefinition,
  StatusCodeListResponse,
  StatusCodeUpdateRequest,
  UnregisteredStatusCodeListResponse,
} from '@smart-farm/shared/schemas/status-code';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import { compareIsoInstants } from '@smart-farm/shared/time';
import type { AuditService } from '../audit/audit-service.ts';
import type { EvaluationService } from '../evaluation/evaluation-service.ts';
import { reevaluateSafely } from '../evaluation/reevaluate-safely.ts';
import {
  isRegistrableStatusCode,
  suggestStatusCode,
} from '../../domain/unregistered-status-code.ts';
import type { Logger } from '../ports/logger-port.ts';
import type {
  StatusCodeRepository,
  UnregisteredStatusCodeRepository,
} from '../ports/repositories.ts';

const STATUS_CODE_TARGET_TYPE = 'status-code' satisfies AuditTargetType;

export interface StatusCodeService {
  list(): Promise<StatusCodeListResponse>;
  /**
   * 未登録のコード値の一覧。登録済み（論理削除でない）のコード値は、読むときに除く（記録は消さない。あとで、そのコードを
   * 削除すると、一覧に戻る）。件数の多い順（同じなら、最終の日時の新しい順、コード値の順）。
   */
  listUnregistered(): Promise<UnregisteredStatusCodeListResponse>;
  create(input: StatusCodeCreateRequest, actor: UserId): Promise<StatusCodeDefinition>;
  update(
    code: string,
    input: StatusCodeUpdateRequest,
    actor: UserId,
  ): Promise<StatusCodeDefinition>;
  /** 論理削除する。存在しない（削除済みを含む）場合は NOT_FOUND。 */
  delete(code: string, actor: UserId): Promise<void>;
}

export interface StatusCodeServiceDeps {
  readonly statusCodes: StatusCodeRepository;
  readonly unregisteredStatusCodes: UnregisteredStatusCodeRepository;
  readonly audit: AuditService;
  readonly evaluation: EvaluationService;
  readonly logger: Logger;
}

/** コード値の順（ロケールに依存しない、文字コード順）。 */
function compareCodes(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function withoutDescriptionWhenEmpty(input: { description?: string | undefined }): {
  description?: string;
} {
  return input.description === undefined || input.description === ''
    ? {}
    : { description: input.description };
}

export function createStatusCodeService(deps: StatusCodeServiceDeps): StatusCodeService {
  const { statusCodes, unregisteredStatusCodes, audit, evaluation, logger } = deps;

  async function findActive(code: string): Promise<StatusCodeDefinition> {
    const found = await statusCodes.get(code);
    if (found === undefined || found.isDeleted) {
      throw new AppError('NOT_FOUND', 'ステータスコードが見つかりません');
    }
    return found;
  }

  /** 評価の更新。失敗しても、定義の保存の結果には影響させない。 */
  const reevaluate = (): Promise<void> =>
    reevaluateSafely(
      evaluation,
      logger,
      'STATUS_CODE_CHANGE',
      'ステータスコードの変更後の評価に失敗しました',
    );

  return {
    async list() {
      const items = await statusCodes.list();
      return { items: items.sort((left, right) => compareCodes(left.code, right.code)) };
    },

    async listUnregistered() {
      const registered = new Set((await statusCodes.list()).map((definition) => definition.code));
      const items = (await unregisteredStatusCodes.list())
        .filter((record) => !registered.has(record.code))
        .sort(
          (left, right) =>
            right.count - left.count ||
            compareIsoInstants(right.lastSeenAt, left.lastSeenAt) ||
            compareCodes(left.code, right.code),
        )
        .map((record) => {
          const suggestedCode = suggestStatusCode(record.code);
          return {
            ...record,
            isRegistrable: isRegistrableStatusCode(record.code),
            ...omitUndefined({ suggestedCode }),
          };
        });
      return { items };
    },

    async create(input, actor) {
      const existing = await statusCodes.get(input.code);
      if (existing !== undefined && !existing.isDeleted) {
        throw conflictError('code', '同じコード値がすでに登録されています');
      }
      const created: StatusCodeDefinition = {
        code: input.code,
        name: input.name,
        category: input.category,
        ...withoutDescriptionWhenEmpty(input),
        isDeleted: false,
      };
      await statusCodes.save(created);
      await audit.record({
        operation: 'CREATE',
        targetType: STATUS_CODE_TARGET_TYPE,
        targetId: created.code,
        actor,
        after: created,
      });
      await reevaluate();
      return created;
    },

    async update(code, input, actor) {
      const before = await findActive(code);
      const updated: StatusCodeDefinition = {
        code,
        name: input.name,
        category: input.category,
        ...withoutDescriptionWhenEmpty(input),
        isDeleted: false,
      };
      await statusCodes.save(updated);
      await audit.record({
        operation: 'UPDATE',
        targetType: STATUS_CODE_TARGET_TYPE,
        targetId: code,
        actor,
        before,
        after: updated,
      });
      await reevaluate();
      return updated;
    },

    async delete(code, actor) {
      const before = await findActive(code);
      await statusCodes.save({ ...before, isDeleted: true });
      await audit.record({
        operation: 'DELETE',
        targetType: STATUS_CODE_TARGET_TYPE,
        targetId: code,
        actor,
        before,
      });
      await reevaluate();
    },
  };
}
