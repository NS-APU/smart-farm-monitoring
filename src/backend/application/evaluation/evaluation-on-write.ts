/**
 * 手動入力の保存・修正・削除の応答の前に、評価の再計算を行うか（Issue #123。ADR-0014）。
 *
 * - `sync`: 応答の前に、影響する設備とハウスの評価を、同期して再計算する（既定。ローカル・E2E・負荷テスト）。
 *   応答の「関連する観点のステータス」は、最新の評価の値。
 * - `deferred`: 応答の前に、評価しない（AWS の Lambda）。評価は、定期の評価（JB-02）が更新する。応答の「関連する観点のステータス」は、
 *   前回の評価の値。評価は、直近 90 日の観測値を読むため、データが増えると、保存・削除の応答が遅くなる（Issue #79 の実測）。
 */

export const EVALUATION_ON_WRITE_MODES = ['sync', 'deferred'] as const;
export type EvaluationOnWrite = (typeof EVALUATION_ON_WRITE_MODES)[number];
