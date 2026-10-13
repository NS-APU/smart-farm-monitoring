/**
 * 農業情報基盤への連携のポート（FederationPort。ADR-0004、architecture.md 5.3）。
 * 連携方式（API・データモデル・頻度）は未確定（Q-005）。方式ごとの実装はアダプタとして追加する。
 * 農業情報基盤の停止は、アプリケーションの異常とみなさず、他の機能に影響させない（NFR-2.1）。
 */

import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import { namedErrorClass } from '../named-error.ts';

/** 連携先が停止している・応答がない（保留の対象）。 */
export class FederationUnavailableError extends namedErrorClass('FederationUnavailableError') {}

/** 連携先がデータを受け付けなかった（失敗の対象。再試行しても同じ結果の可能性がある）。 */
export class FederationRejectedError extends namedErrorClass('FederationRejectedError') {}

export interface FederationPort {
  /** 連携キューの項目を送る。停止中は FederationUnavailableError、拒否は FederationRejectedError。 */
  send(items: readonly FederationItem[]): Promise<void>;
}
