/**
 * 手動入力と変更履歴の Repository（DynamoDB 実装）。
 *
 * - 手動入力: `ME` / `{計測日時}#{入力ID}`。入力 ID から引くためのポインタ `MEID#{入力ID}`（計測日時を変えた保存でも、1 件のまま）。
 *   件数は少ない前提で、日時の範囲で読み、絞り込み・並べ替えは、アプリ側（ローカルの実装と同じ規則）で行う
 * - 変更履歴: `AUDIT` / `{日時}#{変更ID}`。期間はキー条件、そのほかの絞り込みは、読んだ結果に適用する
 */

import { AuditLogEntrySchema } from '@smart-farm/shared/schemas/audit';
import { ManualEntrySchema, type ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type {
  AuditLogRepository,
  ManualEntryRepository,
} from '../../application/ports/repositories.ts';
import { compareManualEntries, matchesManualEntry } from '../common/manual-entry-rules.ts';
import { paginated } from '../common/pagination.ts';
import { instantKey, timedSortKey, upperBoundOf } from './keys.ts';
import { mainAggregate } from './main-table.ts';
import {
  getItem,
  queryItems,
  transactWrite,
  type Database,
  type TransactItem,
} from './operations.ts';
import { pageBySortKey } from './sort-key-page.ts';

const MANUAL_ENTRY = 'ME';
const AUDIT = 'AUDIT';

const pointerPartition = (entryId: string): string => `MEID#${entryId}`;

export function createManualEntryRepository(db: Database): ManualEntryRepository {
  const table = db.tables.main;
  const entries = mainAggregate(db, ManualEntrySchema);

  async function pointedSortKey(entryId: string): Promise<string | undefined> {
    const pointer = await getItem(db, table, { pk: pointerPartition(entryId), sk: 'P' });
    return pointer === undefined ? undefined : String(pointer.nsk);
  }

  return {
    async get(entryId) {
      const sortKey = await pointedSortKey(entryId);
      return sortKey === undefined ? undefined : entries.get(MANUAL_ENTRY, sortKey);
    },
    async save(entry) {
      const sortKey = timedSortKey(entry.observedAt, entry.entryId);
      const previous = await pointedSortKey(entry.entryId);
      const operations: TransactItem[] = [
        entries.putOperation(MANUAL_ENTRY, sortKey, entry),
        {
          Put: {
            TableName: table,
            Item: { pk: pointerPartition(entry.entryId), sk: 'P', nsk: sortKey },
          },
        },
      ];
      if (previous !== undefined && previous !== sortKey) {
        // 計測日時が変わったときは、古い位置の項目を消す
        operations.push({ Delete: { TableName: table, Key: { pk: MANUAL_ENTRY, sk: previous } } });
      }
      await transactWrite(db, operations);
    },
    async list(filter, page, sort = { key: 'observedAt', direction: 'desc' }) {
      const matched: ManualEntry[] = [];
      for await (const item of queryItems(db, {
        table,
        hashName: 'pk',
        hashValue: MANUAL_ENTRY,
        sortName: 'sk',
        lower: filter.from === undefined ? undefined : instantKey(filter.from.toISOString()),
        upper:
          filter.to === undefined ? undefined : upperBoundOf(instantKey(filter.to.toISOString())),
        forward: true,
        pageSize: 1000,
        consistent: true,
      })) {
        const entry = entries.parse(item);
        if (matchesManualEntry(entry, filter)) {
          matched.push(entry);
        }
      }
      return paginated(matched.sort(compareManualEntries(sort.key, sort.direction)), page);
    },
  };
}

export function createAuditLogRepository(db: Database): AuditLogRepository {
  const entries = mainAggregate(db, AuditLogEntrySchema);
  return {
    add: (entry) => entries.put(AUDIT, timedSortKey(entry.occurredAt, entry.auditId), entry),
    async list(filter, page) {
      const result = await pageBySortKey(db, {
        partitions: [AUDIT],
        forward: filter.direction === 'asc',
        limit: page.limit,
        cursor: page.cursor,
        lower: filter.from === undefined ? undefined : instantKey(filter.from.toISOString()),
        upper:
          filter.to === undefined ? undefined : upperBoundOf(instantKey(filter.to.toISOString())),
        accept(item) {
          const entry = entries.parse(item);
          return (
            (filter.operation === undefined || entry.operation === filter.operation) &&
            (filter.actor === undefined || entry.actor === filter.actor) &&
            (filter.targetType === undefined || entry.targetType === filter.targetType)
          );
        },
      });
      return { items: result.items.map(entries.parse), nextCursor: result.nextCursor };
    },
  };
}
