/**
 * モックの外部サービス（ファイルサーバー・農業情報基盤・Web Push）の、停止（DOWN）・遅延（SLOW）・拒否（REJECT）の再現。
 * E2E・負荷テストで、外部の停止が本システムを止めないこと（NFR-2.1, NFR-4.4）を検証するために使う。
 */

export const FAULT_MODES = ['UP', 'DOWN', 'SLOW', 'REJECT'] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface Fault {
  readonly mode: FaultMode;
  /** SLOW のときの応答の遅延（ミリ秒）。 */
  readonly delayMs: number;
}

export interface FaultController {
  get(): Fault;
  set(fault: Partial<Fault>): Fault;
  /** 初期の状態（停止していない）へ戻す。 */
  reset(): void;
}

/** 初期の状態: 停止も遅延もない。 */
const NORMAL_FAULT: Fault = { mode: 'UP', delayMs: 0 };

export function createFaultController(initial: Fault = NORMAL_FAULT): FaultController {
  let current = initial;
  return {
    get: () => current,
    set(fault) {
      current = { ...current, ...fault };
      return current;
    },
    reset() {
      current = NORMAL_FAULT;
    },
  };
}
