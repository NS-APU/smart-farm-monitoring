/** 取り込みでの、未登録のコード値の記録（SC-12-5。#158）。1 回の取り込みの集計を、コード値ごとに 1 回ずつ更新する。上限は、domain 側。 */

import { errorLogFields } from '../error-fields.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { UnregisteredStatusCodeRepository } from '../ports/repositories.ts';
import { planUnregisteredRecording } from '../../domain/unregistered-status-code.ts';

export interface UnregisteredRecorderDeps {
  readonly repository: UnregisteredStatusCodeRepository;
  readonly clock: ClockPort;
  readonly logger: Logger;
}

/**
 * 集計（コード値 → 件数。複数のファイルの分を合わせたもの）を、記録する。**失敗しても、取り込みは失敗にしない**
 * （記録は、確認のための参考の情報で、観測値が、元のデータ。評価・通知の失敗と同じ扱い）。ログには、値を出さず
 * （秘密・個人情報が含まれうるため）、件数・種類数だけを出す。
 */
export async function recordUnregisteredStatusCodes(
  deps: UnregisteredRecorderDeps,
  sourceId: string,
  counts: ReadonlyMap<string, number>,
): Promise<void> {
  if (counts.size === 0) {
    return;
  }
  const { repository, clock, logger } = deps;
  try {
    const recorded = new Set((await repository.list()).map((item) => item.code));
    const plan = planUnregisteredRecording(counts, recorded);
    const seenAt = clock.now();
    for (const { code, count } of plan.increments) {
      await repository.record(code, count, seenAt);
    }
    if (plan.increments.length > 0) {
      logger.info('未登録のステータスコードを記録しました', {
        sourceId,
        kinds: plan.increments.length,
        observations: plan.increments.reduce((total, entry) => total + entry.count, 0),
      });
    }
    if (plan.skippedKinds > 0) {
      logger.warn('未登録のステータスコードの記録が上限に達したため、一部を記録しませんでした', {
        sourceId,
        skippedKinds: plan.skippedKinds,
      });
    }
  } catch (error) {
    logger.error('未登録のステータスコードの記録に失敗しました', {
      sourceId,
      ...errorLogFields(error),
    });
  }
}
