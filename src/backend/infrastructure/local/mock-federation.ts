/**
 * 農業情報基盤のモック（FederationPort のダミー実装）。成功・停止・遅延・拒否を再現できる。
 * 受け取った項目を記録し、E2E・結合テストで、連携の内容と保留・再送を検証できる。
 */

import type { ClockPort } from '../../application/ports/clock-port.ts';
import {
  FederationRejectedError,
  FederationUnavailableError,
  type FederationPort,
} from '../../application/ports/federation-port.ts';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import type { FaultController } from './faults.ts';

export interface MockFederation extends FederationPort {
  /** 受け取った項目（古い順）。 */
  received(): readonly FederationItem[];
  reset(): void;
}

export function createMockFederation(options: {
  faults: FaultController;
  clock: ClockPort;
}): MockFederation {
  const received: FederationItem[] = [];
  return {
    async send(items) {
      const fault = options.faults.get();
      if (fault.mode === 'DOWN') {
        throw new FederationUnavailableError('農業情報基盤が停止しています');
      }
      if (fault.mode === 'SLOW') {
        await options.clock.sleep(fault.delayMs);
      }
      if (fault.mode === 'REJECT') {
        throw new FederationRejectedError('農業情報基盤がデータを受け付けませんでした');
      }
      received.push(...items);
    },
    received: () => received,
    reset() {
      received.length = 0;
    },
  };
}
