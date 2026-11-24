/**
 * 手動入力が、評価に使われるかの判定（純粋関数。D-26）。
 * 合計（累積）の項目（収穫数・稼働時間など）は、評価の期間に、同じ設備・項目の自動取り込みの値（使える数値）が 1 件でもあれば、
 * 自動だけを使い、手動入力は使わない（集計 `aggregateMeasures` と同じ規則・同じ関数で判定する）。保存の応答（項目ごとの「評価に使われるか」）と、
 * 計測データの「評価に使われていません」の印が使う。
 *
 * - 判定は、評価の期間ごと（短期 24 時間・長期の各期間）。期間によって、結果が違いうる
 *   （例: 24 時間は自動なし→手動を使う、7 日は自動あり→手動を使わない）
 * - 入力の観測値は、評価が読む範囲（最長の期間）の、設備の全取得元の観測値（自動の有無を判定するため）。評価が読む観測値だけで判定でき、
 *   追加の読み取りは要らない
 * - 状態値（温度など）・ステータスコード・手動専用の件数の項目は、自動があっても、手動入力が使われる
 */

import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import { autoCumulativeKeysIn, isManualOverriddenByAuto, usableObservedMs } from './measures.ts';
import { evaluationWindows } from './scope-evaluator.ts';

/**
 * 評価に使われるか・使われない理由。
 * - USED: 評価に使われる
 * - AUTO_PRIORITY: 合計（累積）の項目で、評価の期間に自動取り込みの値があるため、使われない（D-26）
 * - OUT_OF_PERIOD: 計測日時が、評価の期間の外
 * - UNUSABLE: 論理削除・欠損・不正な値・評価時刻より後に受信、のいずれか（評価に使えない値）
 */
export type ManualUsageReason = 'USED' | 'AUTO_PRIORITY' | 'OUT_OF_PERIOD' | 'UNUSABLE';

export interface ManualUsage {
  readonly observation: Observation;
  readonly used: boolean;
  readonly reason: ManualUsageReason;
}

export interface ManualUsageInput {
  /** 評価の期間の判定に使う観測値（手動入力と自動取り込みの両方。ほかの設備・項目を含んでよい）。 */
  readonly observations: readonly Observation[];
  /** 評価の期間の開始・終了（終了は評価時刻）。 */
  readonly from: Date;
  readonly to: Date;
  /** この時刻までに受信済みの値のみ使う（既定は to）。 */
  readonly knownAt?: Date;
  /** 結果を、この設備・項目の手動入力に絞る（省略すると、すべて）。自動の有無の判定は、絞り込みに依らない。 */
  readonly equipmentId?: EquipmentId;
  readonly itemKey?: string;
}

/** 1 つの評価の期間で、手動入力のそれぞれが、評価に使われるかを返す（入力の順）。自動取り込みの観測値は、結果に含めない。 */
export function judgeManualUsage(input: ManualUsageInput): ManualUsage[] {
  const knownAt = input.knownAt ?? input.to;
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  const autoKeys = autoCumulativeKeysIn(input.observations, input.from, input.to, knownAt);

  const results: ManualUsage[] = [];
  for (const observation of input.observations) {
    if (
      observation.source !== 'MANUAL' ||
      (input.equipmentId !== undefined && observation.equipmentId !== input.equipmentId) ||
      (input.itemKey !== undefined && observation.itemKey !== input.itemKey)
    ) {
      continue;
    }
    const observedMs = usableObservedMs(observation, knownAt.getTime());
    if (observedMs === undefined) {
      results.push({ observation, used: false, reason: 'UNUSABLE' });
    } else if (observedMs < fromMs || observedMs > toMs) {
      results.push({ observation, used: false, reason: 'OUT_OF_PERIOD' });
    } else if (isManualOverriddenByAuto(observation, autoKeys)) {
      results.push({ observation, used: false, reason: 'AUTO_PRIORITY' });
    } else {
      results.push({ observation, used: true, reason: 'USED' });
    }
  }
  return results;
}

/** 評価の期間（短期 24 時間・長期の当日〜90 日。終了は評価時刻）。 */
export interface EvaluationPeriod {
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays | null;
  readonly from: Date;
  readonly to: Date;
}

/** 評価の期間の一覧（短期、長期の各期間の順）。短期の評価を持たない観点でも、短期を含める。 */
export function evaluationPeriods(now: Date): EvaluationPeriod[] {
  return evaluationWindows(true).map(({ horizon, periodDays, hours }) => ({
    horizon,
    periodDays,
    from: new Date(now.getTime() - hours * MS_PER_HOUR),
    to: now,
  }));
}

export interface ManualUsageInPeriod {
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays | null;
  readonly used: boolean;
  readonly reason: ManualUsageReason;
}

export interface ManualUsageAcrossPeriods {
  readonly observation: Observation;
  /** 評価の期間ごとの判定（短期、長期の各期間の順）。 */
  readonly periods: ManualUsageInPeriod[];
  /** いずれかの評価の期間で、評価に使われるか。 */
  readonly usedInAnyPeriod: boolean;
}

/** すべての評価の期間（短期・長期）で、手動入力のそれぞれが、評価に使われるかを返す（入力の順）。 */
export function judgeManualUsageInEvaluationPeriods(
  observations: readonly Observation[],
  now: Date,
  filter: Pick<ManualUsageInput, 'equipmentId' | 'itemKey'> = {},
): ManualUsageAcrossPeriods[] {
  const byObservation = new Map<Observation, ManualUsageInPeriod[]>();
  for (const { horizon, periodDays, from, to } of evaluationPeriods(now)) {
    for (const { observation, used, reason } of judgeManualUsage({
      observations,
      from,
      to,
      ...filter,
    })) {
      const entry: ManualUsageInPeriod = { horizon, periodDays, used, reason };
      const entries = byObservation.get(observation);
      if (entries === undefined) {
        byObservation.set(observation, [entry]);
      } else {
        entries.push(entry);
      }
    }
  }
  return [...byObservation].map(([observation, periods]) => ({
    observation,
    periods,
    usedInAnyPeriod: periods.some(({ used }) => used),
  }));
}
