/**
 * 計測データの一覧の、手動入力の行ごとの「評価に使われるか」（D-26。Issue #162 の SC-09-4。クエリ `includeUsage=true` のとき）。
 * 判定は、保存・修正の応答（`judgeEntryUsage`）と同じ規則（ドメインの `judgeManualUsageInEvaluationPeriods`）で、評価の結果ではなく、観測値で行う。
 *
 * - 対象: 合計（累積）の項目の手動入力の行のうち、計測日時が、評価の期間（最長 90 日）の中のもの。状態値・ステータスコード・手動専用の件数の項目、
 *   自動取り込みの行、90 日より前の行は、対象外（常に、使われる、または、どの期間にも入らないため。`usage` を付けない）
 * - 読み取り: 一覧の読み取りのほかに、対象の行の設備・項目の組ごとに、自動取り込みの観測値を、新しい順に 1 件（組ごとに 1 回の問い合わせ）。
 *   行の数・ページの数には、比例しない（同じ組の行は、1 回で足りる。評価の期間に自動の値があるかは、最も新しい、使える自動の値の計測日時で決まる）
 */

import { isCumulativeItem } from '@smart-farm/shared/constants/items';
import type { EvaluationUsage, Observation } from '@smart-farm/shared/schemas/observation';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import { judgeManualUsageInEvaluationPeriods } from '../../domain/evaluation/manual-usage.ts';
import { LONGEST_PERIOD_DAYS, latestUsableAuto } from '../manual-entry/manual-entry-usage.ts';
import type { ObservationRepository } from '../ports/repositories.ts';

/**
 * 観測値のうち、評価に使われるかを示す対象（合計の項目の手動入力）の、それぞれの「評価に使われるか」を返す（対象外は、含まない）。
 * 評価時刻は、現在（計測日時が、許容の範囲で未来の行があれば、その計測日時。保存の応答と同じ）。
 */
export async function judgeObservationUsage(
  observations: ObservationRepository,
  rows: readonly Observation[],
  now: Date,
): Promise<Map<Observation, EvaluationUsage>> {
  const manualRows = rows.filter((row) => row.source === 'MANUAL' && isCumulativeItem(row.itemKey));
  const evaluatedAt = new Date(
    Math.max(now.getTime(), ...manualRows.map((row) => Date.parse(row.observedAt))),
  );
  const oldest = evaluatedAt.getTime() - LONGEST_PERIOD_DAYS * MS_PER_DAY;
  const candidates = manualRows.filter((row) => Date.parse(row.observedAt) >= oldest);
  const usages = new Map<Observation, EvaluationUsage>();
  if (candidates.length === 0) {
    return usages;
  }

  const pairs = new Map<string, Pick<Observation, 'equipmentId' | 'itemKey'>>();
  for (const { equipmentId, itemKey } of candidates) {
    pairs.set(`${equipmentId}#${itemKey}`, { equipmentId, itemKey });
  }
  const autoSamples = await Promise.all(
    [...pairs.values()].map(({ equipmentId, itemKey }) =>
      latestUsableAuto(observations, equipmentId, itemKey, evaluatedAt),
    ),
  );
  const judged = judgeManualUsageInEvaluationPeriods(
    [...autoSamples.filter((sample) => sample !== undefined), ...candidates],
    evaluatedAt,
  );
  for (const { observation, usedInAnyPeriod, periods } of judged) {
    usages.set(observation, {
      used: usedInAnyPeriod,
      autoPriorityPeriods: periods
        .filter(({ reason }) => reason === 'AUTO_PRIORITY')
        .map(({ horizon, periodDays }) => ({ horizon, periodDays })),
    });
  }
  return usages;
}
