/**
 * 観測値の一覧（GET /observations。SC-09・SC-02 の元データ）の、期間の規則（ADR-0007 の判断。Issue #91）。
 * DynamoDB は、計測日時の順にしか、効率よく読めない。値・カテゴリの順の並べ替えと、キーワード検索と、「問題あり」（有効でない観測値）の絞り込みは、全期間を読む必要があるため、
 * 期間（from・to。31 日以内）の指定を必須にする。計測日時の順（既定）は、期間の指定が不要。
 * API の入力検証と、画面の案内で、同じ判定を使う（ローカルの実装・DynamoDB の実装で、挙動を変えない）。
 */

import type { ObservationSortKey } from './constants/sorting.ts';
import { MS_PER_DAY } from './time.ts';

/** 並べ替え（値・カテゴリ）・キーワード検索で指定できる期間の上限（日）。 */
export const MAX_LIST_PERIOD_DAYS = 31;

/** 期間の指定が必要なときの、画面の案内。 */
export const LIST_PERIOD_GUIDANCE = `並べ替え・検索は、期間（${String(MAX_LIST_PERIOD_DAYS)} 日以内）を指定してください`;

/** 「問題あり」の絞り込みで、期間の指定が必要なときの、画面の案内（SC-09-3。上限を超えたときは、期間を狭める）。 */
export const PROBLEM_LIST_PERIOD_GUIDANCE = `「問題あり」の絞り込みは、期間（${String(MAX_LIST_PERIOD_DAYS)} 日以内）を指定してください。多いときは、期間を狭めてください`;

/**
 * 期間の指定が必要な操作か（計測日時以外の並べ替え、または、キーワード（空白だけは除く）の指定、または、「問題あり」の絞り込みがある）。
 * 「問題あり」は、読んだ後に絞るため、絞っても読み取りの量が減らない（ADR-0007）。
 */
export function requiresListPeriod(params: {
  readonly sort: ObservationSortKey;
  readonly keyword?: string | undefined;
  readonly problemOnly?: boolean | undefined;
}): boolean {
  return (
    params.sort !== 'observedAt' ||
    (params.keyword?.trim() ?? '') !== '' ||
    params.problemOnly === true
  );
}

/** 期間の指定が必要なときの、画面・API の案内。「問題あり」の絞り込みを指定しているときは、その案内。 */
export function listPeriodGuidance(params: { readonly problemOnly?: boolean | undefined }): string {
  return params.problemOnly === true ? PROBLEM_LIST_PERIOD_GUIDANCE : LIST_PERIOD_GUIDANCE;
}

/** 期間の問題: MISSING = 開始・終了のどちらかがない／TOO_LONG = 終了 − 開始が上限（31 日）を超える。問題がなければ null。 */
export type ListPeriodProblem = 'MISSING' | 'TOO_LONG';

export function checkListPeriod(period: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): ListPeriodProblem | null {
  if (period.from === undefined || period.to === undefined) {
    return 'MISSING';
  }
  const length = Date.parse(period.to) - Date.parse(period.from);
  return length > MAX_LIST_PERIOD_DAYS * MS_PER_DAY ? 'TOO_LONG' : null;
}
