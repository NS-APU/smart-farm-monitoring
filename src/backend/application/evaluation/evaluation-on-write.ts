/**
 * 保存・変更の応答の前に、評価の再計算を行うか（Issue #123・#404。ADR-0014）。手動入力の保存・修正・削除と、
 * 設備・ステータスコード・判断基準の登録・修正・削除で、同じ設定（`EVALUATION_ON_WRITE`）を使う。
 *
 * - `sync`: 応答の前に、評価を同期して再計算する（既定。ローカル・E2E・負荷テスト）。手動入力は、影響する設備とハウスだけ。
 *   設備・ステータスコード・判断基準は、全設備。応答の評価の状態は `DONE`（手動入力の「関連する観点のステータス」は、最新の評価の値）。
 * - `deferred`: 応答の前に、評価しない（AWS の Lambda）。評価は、定期の評価（JB-02）が更新する。応答の評価の状態は `DEFERRED`
 *   （手動入力の「関連する観点のステータス」は、前回の評価の値）。評価は、直近 90 日の観測値を読むため、設備・データが増えると、
 *   応答が遅くなる（Issue #79 の実測。設備・ステータスコード・判断基準は、全設備を評価するため、さらに遅い）。
 */

import type { EvaluationWriteState } from '@smart-farm/shared/schemas/common';

export const EVALUATION_ON_WRITE_MODES = ['sync', 'deferred'] as const;
export type EvaluationOnWrite = (typeof EVALUATION_ON_WRITE_MODES)[number];

/** 応答の評価の状態（`sync` は `DONE`、`deferred` は `DEFERRED`）。 */
export function evaluationWriteStateOf(mode: EvaluationOnWrite): EvaluationWriteState {
  return mode === 'sync' ? 'DONE' : 'DEFERRED';
}
