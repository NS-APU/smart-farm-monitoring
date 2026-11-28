/**
 * 手動入力の「評価に使われるか」の文言（D-26。Issue #162）。保存・修正の結果（SC-06・SC-07）と、計測データの一覧の印（SC-09-4）で、同じ言い方にする。
 * 合計（累積）の項目は、評価の期間に自動取り込みの値があれば、自動だけを使い、手動入力は使われない。
 */

import type { EvaluationUsage } from '@smart-farm/shared/schemas/observation';
import { MESSAGES } from '../i18n/messages.ts';

/** 自動取り込みの値を使うため、使われない評価の期間の呼び方（短期視点、長期視点〔当日・直近 N 日〕）。 */
export function usagePeriodLabel(period: EvaluationUsage['autoPriorityPeriods'][number]): string {
  return period.periodDays === null
    ? MESSAGES.entry.usageShort
    : MESSAGES.entry.usageLong(MESSAGES.dashboard.periodDays[period.periodDays]);
}

/**
 * 評価に使われない旨の説明。評価に使われる期間がなければ、「この期間は…使われません」。
 * 一部の期間だけ（取得元が期間によって変わる）なら、自動取り込みの値を使う期間を示す。
 */
export function usageReasonText(usage: EvaluationUsage): string {
  return usage.used
    ? MESSAGES.entry.usagePartial(usage.autoPriorityPeriods.map(usagePeriodLabel).join('・'))
    : MESSAGES.entry.usageNotUsed;
}
