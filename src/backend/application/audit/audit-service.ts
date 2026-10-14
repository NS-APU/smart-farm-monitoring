/**
 * 変更履歴（FR-4.2.3、NFR-5.7）。入力・変更・削除の操作を記録し、操作種別・変更者・期間で絞り込んで参照する。
 * 記録する対象: 手動入力、判断基準、設備、ステータスコード、ユーザー、取り込み設定。
 */

import type { SortDirection } from '@smart-farm/shared/constants/sorting';
import type {
  AuditLogEntry,
  AuditLogListResponse,
  AuditTargetType,
} from '@smart-farm/shared/schemas/audit';
import type { UserId } from '@smart-farm/shared/schemas/common';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { ClockPort } from '../ports/clock-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { AuditLogRepository } from '../ports/repositories.ts';

export interface AuditRecordInput {
  readonly operation: AuditLogEntry['operation'];
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly actor: UserId;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AuditListQuery {
  readonly operation?: AuditLogEntry['operation'] | undefined;
  readonly actor?: UserId | undefined;
  readonly targetType?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly direction?: SortDirection | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface AuditService {
  record(input: AuditRecordInput): Promise<void>;
  list(query: AuditListQuery): Promise<AuditLogListResponse>;
}

export function createAuditService(deps: {
  auditLogs: AuditLogRepository;
  clock: ClockPort;
  ids: IdGeneratorPort;
}): AuditService {
  return {
    async record(input) {
      await deps.auditLogs.add({
        auditId: deps.ids.next(),
        occurredAt: deps.clock.now().toISOString(),
        operation: input.operation,
        targetType: input.targetType,
        targetId: input.targetId,
        actor: input.actor,
        ...omitUndefined({
          before: input.before,
          after: input.after,
        }),
      });
    },

    async list(query) {
      const page = await deps.auditLogs.list(
        omitUndefined({
          operation: query.operation,
          actor: query.actor,
          targetType: query.targetType,
          from: query.from,
          to: query.to,
          direction: query.direction,
        }),
        { limit: query.limit, cursor: query.cursor },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}
