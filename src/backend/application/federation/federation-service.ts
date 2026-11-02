/**
 * 農業情報基盤との連携のユースケース（UC-11。JB-03。ADR-0004）。
 * 連携対象は連携キュー（アウトボックス）に積み、連携ジョブが非同期に送る。
 * 農業情報基盤の停止中は「保留」にし、他の機能は影響を受けない（FR-8.2, NFR-2.1）。
 * 結果（成功・失敗・保留）は記録する（FR-8.3）。復旧後は、送信に成功したら、溜まった保留・失敗の項目の
 * 次の試行を、すぐ（今）に戻して、積んだ順に送る（1 回の成功につき、最大でバッチの件数。ADR-0016 の D-06。dev_spec.md 4章）。
 * 積んでから破棄の期限（設定値。既定 30 日）を過ぎても送れていない項目は、送らずに破棄し（状態「期限切れ」）、
 * 連携のログに記録して、通知する（ADR-0016 の D-06）。期限は、次の試行の日時が来た項目を取り出したときに確かめる。
 */

import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { errorLogFields } from '../error-fields.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import { FederationUnavailableError, type FederationPort } from '../ports/federation-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { NotificationService } from '../notification/notification-service.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { FederationRepository } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import { OperationTimeoutError, withTimeout } from '../with-timeout.ts';

export interface FederationRunSummary {
  readonly sent: number;
  readonly failed: number;
  readonly held: number;
  /** 破棄の期限を過ぎて、破棄した項目の数。 */
  readonly expired: number;
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
  readonly notifications: Pick<NotificationService, 'notifyFederationExpired'>;
  readonly port: FederationPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly settings: AppSettings['federation'];
  readonly logger: Logger;
}

export function createFederationService(deps: FederationServiceDeps): FederationService {
  const { federation, notifications, port, clock, ids, settings, logger } = deps;

  function nextAttemptAfter(now: Date, attempts: number): string {
    // 間隔を広げながら再試行する（停止が長い場合に負荷・ログを増やさない。architecture.md 5.3）
    const delayMinutes = Math.min(
      settings.retryMaxDelayMinutes,
      settings.retryBaseDelayMinutes * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(now.getTime() + delayMinutes * MS_PER_MINUTE).toISOString();
  }

  /** 積んでから、破棄の期限を過ぎているか（ちょうど期限の日数は、過ぎていない）。 */
  function isExpired(item: FederationItem, now: Date): boolean {
    return now.getTime() - Date.parse(item.enqueuedAt) > settings.expiryDays * MS_PER_DAY;
  }

  /**
   * 期限を過ぎた項目を、破棄する（状態「期限切れ」。内容（payload）は消す）。連携のログに「期限切れ」で記録して、通知する。
   * 通知の失敗は、連携の処理に影響させない。破棄した件数を返す。
   */
  async function discardExpired(
    expiredItems: readonly FederationItem[],
    now: Date,
  ): Promise<number> {
    if (expiredItems.length === 0) {
      return 0;
    }
    const occurredAt = now.toISOString();
    const message = `連携の期限（${String(settings.expiryDays)} 日）を過ぎた項目を、破棄しました`;
    for (const item of expiredItems) {
      await federation.update({
        ...item,
        status: 'EXPIRED',
        payload: {},
        updatedAt: occurredAt,
        result: message,
      });
    }
    await federation.addLog({
      logId: ids.next(),
      occurredAt,
      result: 'EXPIRED',
      itemCount: expiredItems.length,
      message,
    });
    logger.warn(message, { itemCount: expiredItems.length, result: 'EXPIRED' });
    try {
      await notifications.notifyFederationExpired({ expiryDays: settings.expiryDays });
    } catch (error) {
      logger.warn('連携の期限切れの通知を作れませんでした', { ...errorLogFields(error) });
    }
    return expiredItems.length;
  }

  /** 送信に成功したら、溜まった保留・失敗の項目の次の試行を、今に戻す（古い順に、バッチの件数まで。試行の回数は変えない）。 */
  async function releaseWaiting(now: Date): Promise<void> {
    const waiting = await federation.listWaiting(now, settings.batchSize);
    const nextAttemptAt = now.toISOString();
    for (const item of waiting) {
      await federation.update({ ...item, nextAttemptAt });
    }
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
      const listed = await federation.listDue(now, settings.batchSize);
      const expired = await discardExpired(
        listed.filter((item) => isExpired(item, now)),
        now,
      );
      const due = listed.filter((item) => !isExpired(item, now));
      if (due.length === 0) {
        return { sent: 0, failed: 0, held: 0, expired };
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
      if (result === 'SENT') {
        await releaseWaiting(now);
      }
      return {
        sent: result === 'SENT' ? due.length : 0,
        failed: result === 'FAILED' ? due.length : 0,
        held: result === 'HELD' ? due.length : 0,
        expired,
      };
    },
  };
}
