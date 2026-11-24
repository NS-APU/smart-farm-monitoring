/**
 * 保存・修正の応答の、入力した項目ごとの「評価に使われるか」（D-26。Issue #162 の SC-06-5）。
 * 判定は、ドメインの `judgeManualUsageInEvaluationPeriods`（評価の集計と同じ規則）を使う。入力は、評価の結果ではなく観測値のため、
 * 評価を実行しない構成（`deferred`〔AWS〕）でも、保存の時点で判定できる。
 *
 * 読み取り: 合計（累積）の項目だけ、同じ設備・項目の自動取り込みの観測値を、新しい順に 1 件（項目ごとに 1 回の問い合わせ）。
 * 評価の期間に自動の値があるかは、期間の終わりまでの最も新しい、使える自動の値の計測日時で決まるため、最新の 1 件で足りる
 * （評価と同じく、90 日分の観測値を読まない。ADR-0014 の保存の応答時間を守る）。
 */

import { isCumulativeItem } from '@smart-farm/shared/constants/items';
import { PERIOD_DAYS_OPTIONS } from '@smart-farm/shared/constants/status';
import type { ManualEntry, ManualEntryItemUsage } from '@smart-farm/shared/schemas/manual-entry';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import { usableObservedMs } from '../../domain/evaluation/measures.ts';
import { judgeManualUsageInEvaluationPeriods } from '../../domain/evaluation/manual-usage.ts';
import type { ObservationRepository } from '../ports/repositories.ts';

const LONGEST_PERIOD_DAYS = Math.max(...PERIOD_DAYS_OPTIONS);

/** 評価の期間の終わりまでの、最も新しい、使える自動取り込みの観測値（なければ undefined）。 */
async function latestUsableAuto(
  observations: ObservationRepository,
  equipmentId: ManualEntry['equipmentId'],
  itemKey: string,
  to: Date,
): Promise<Observation | undefined> {
  const page = await observations.query(
    {
      equipmentIds: [equipmentId],
      itemKey,
      source: 'AUTO_IMPORT',
      from: new Date(to.getTime() - LONGEST_PERIOD_DAYS * MS_PER_DAY),
      to,
      matches: (observation) =>
        typeof observation.value === 'number' &&
        usableObservedMs(observation, to.getTime()) !== undefined,
    },
    { limit: 1 },
    { key: 'observedAt', direction: 'desc' },
  );
  return page.items[0];
}

/**
 * 入力（保存した手動入力の観測値）の項目ごとに、評価に使われるかを返す（入力の項目の順）。
 * 評価時刻は、現在（計測日時が、許容の範囲で未来なら、その計測日時。未来の計測日時が、期間の外になって、判定されなくなるのを防ぐ）。
 */
export async function judgeEntryUsage(
  observations: ObservationRepository,
  entry: ManualEntry,
  entryObservations: readonly Observation[],
  now: Date,
): Promise<ManualEntryItemUsage[]> {
  const evaluatedAt = new Date(
    Math.max(now.getTime(), ...entryObservations.map((item) => Date.parse(item.observedAt))),
  );
  const autoSamples = await Promise.all(
    Object.keys(entry.items)
      .filter(isCumulativeItem)
      .map((itemKey) => latestUsableAuto(observations, entry.equipmentId, itemKey, evaluatedAt)),
  );
  const judged = judgeManualUsageInEvaluationPeriods(
    [...autoSamples.filter((sample) => sample !== undefined), ...entryObservations],
    evaluatedAt,
  );
  return entryObservations.flatMap((observation) => {
    const result = judged.find((item) => item.observation === observation);
    return result === undefined
      ? []
      : [
          {
            itemKey: observation.itemKey,
            used: result.usedInAnyPeriod,
            autoPriorityPeriods: result.periods
              .filter(({ reason }) => reason === 'AUTO_PRIORITY')
              .map(({ horizon, periodDays }) => ({ horizon, periodDays })),
          },
        ];
  });
}
