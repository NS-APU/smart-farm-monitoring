/**
 * 農業情報基盤との連携のユースケース（UC-11。JB-03。ADR-0004）。
 * 連携対象は連携キュー（アウトボックス）に積み、連携ジョブが非同期に送る。
 * 農業情報基盤の停止中は「保留」にし、他の機能は影響を受けない（FR-8.2, NFR-2.1）。
 * 結果（成功・失敗・保留）は記録する（FR-8.3）。再送の方針（復旧後の再送・遅延連携）は未確定（Q-005）のため、
 * 暫定として、復旧後は積んだ順にすべて送る（dev_spec.md 4章）。
 */

import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { ClockPort } from '../ports/clock-port.ts';
import { FederationUnavailableError, type FederationPort } from '../ports/federation-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { FederationRepository } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import { OperationTimeoutError, withTimeout } from '../with-timeout.ts';

export interface FederationRunSummary {
  readonly sent: number;
  readonly failed: number;
  readonly held: number;
}

export interface FederationService {
  enqueue(input: {
    targetType: FederationItem['targetType'];
    targetRef: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  /** 送信してよい項目を、まとめて送る（JB-03）。 */
  runPending(): Promise<FederationRunSummary>;
}

export interface FederationServiceDeps {
  readonly federation: FederationRepository;
  readonly port: FederationPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly settings: AppSettings['federation'];
  readonly logger: Logger;
}

export function createFederationService(deps: FederationServiceDeps): FederationService {
  const { federation, port, clock, ids, settings, logger } = deps;

  function nextAttemptAfter(now: Date, attempts: number): string {
    // 間隔を広げながら再試行する（停止が長い場合に負荷・ログを増やさない。architecture.md 5.3）
    const delayMinutes = Math.min(
      settings.retryMaxDelayMinutes,
      settings.retryBaseDelayMinutes * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(now.getTime() + delayMinutes * MS_PER_MINUTE).toISOString();
  }

  return {
    async enqueue(input) {
      const now = clock.now().toISOString();
      await federation.enqueue({
        federationItemId: ids.next(),
        targetType: input.targetType,
        targetRef: input.targetRef,
        payload: input.payload,
        status: 'PENDING',
        attempts: 0,
        enqueuedAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      });
    },

    async runPending() {
      const now = clock.now();
      const due = await federation.listDue(now, settings.batchSize);
      if (due.length === 0) {
        return { sent: 0, failed: 0, held: 0 };
      }

      const updatedAt = now.toISOString();
      let result: 'SENT' | 'FAILED' | 'HELD' = 'SENT';
      let message: string | undefined;
      try {
        await withTimeout(() => port.send(due), settings.ioTimeoutMs, '農業情報基盤への送信');
      } catch (error) {
        // 応答がない（タイムアウト）場合は、農業情報基盤が利用できないものとして、保留する
        if (error instanceof FederationUnavailableError || error instanceof OperationTimeoutError) {
          result = 'HELD';
          message = '農業情報基盤が利用できないため、連携を保留しました';
        } else {
          result = 'FAILED';
          message = '農業情報基盤への連携に失敗しました';
        }
        logger.warn(message, { itemCount: due.length, result });
      }

      for (const item of due) {
        const attempts = result === 'SENT' ? item.attempts : item.attempts + 1;
        const updated: FederationItem = {
          ...item,
          status: result,
          attempts,
          updatedAt,
          nextAttemptAt: result === 'SENT' ? item.nextAttemptAt : nextAttemptAfter(now, attempts),
          ...omitUndefined({ result: message }),
        };
        await federation.update(updated);
      }
      await federation.addLog({
        logId: ids.next(),
        occurredAt: updatedAt,
        result,
        itemCount: due.length,
        ...omitUndefined({ message }),
      });
      return {
        sent: result === 'SENT' ? due.length : 0,
        failed: result === 'FAILED' ? due.length : 0,
        held: result === 'HELD' ? due.length : 0,
      };
    },
  };
}
