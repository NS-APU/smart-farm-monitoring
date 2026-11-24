/**
 * 未登録のコード値（SC-12-5。ADR-0017 の D-23。#158）の、純粋な規則。定義にないステータスコードは、不正（INVALID）の品質で保存される
 * （ADR-0016 の D-10）。その値を、コード値ごとに集計して記録する（件数・最終の日時）。記録には、上限を設ける（費用と肥大を抑える。ADR-0007）。
 */

import { STATUS_CODE_ITEM_KEY } from '@smart-farm/shared/constants/items';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import {
  STATUS_CODE_VALUE_MAX_LENGTH,
  StatusCodeValueSchema,
  type StatusCodeDefinition,
} from '@smart-farm/shared/schemas/status-code';

/** 1 回の取り込みで、新しく記録するコード値の種類の上限。超えた分は記録しない（すでにある値の件数の加算は、続ける）。 */
export const UNREGISTERED_CODES_MAX_NEW_PER_RUN = 20;

/** 記録するコード値の種類の、全体の上限。超えたら、新しい値は記録しない（すでにある値の件数の加算は、続ける）。 */
export const UNREGISTERED_CODES_MAX_TOTAL = 50;

/** 定義がない、または論理削除されたコード値か。 */
export function isUnregisteredStatusCode(
  code: string,
  statusCodes: ReadonlyMap<string, StatusCodeDefinition>,
): boolean {
  const definition = statusCodes.get(code);
  return definition === undefined || definition.isDeleted;
}

/** 記録するコード値にそろえる: 対になっていないサロゲートを置換文字にし（保存できない文字を残さない）、100 文字（文字単位）で切る。 */
export function truncateStatusCodeValue(value: string): string {
  const wellFormed = value.replace(/\p{Surrogate}/gu, '�');
  return Array.from(wellFormed).slice(0, STATUS_CODE_VALUE_MAX_LENGTH).join('');
}

/**
 * 保存した観測値のうち、不正の品質の、定義にないステータスコードの値だけを、コード値ごとに数える（100 文字で切った値）。
 * 空の値は、記録のキーにできないため、数えない。登録済みのコード値が不正になった観測値（計測日時が未来など）も、数えない。
 */
export function countUnregisteredStatusCodes(
  observations: readonly Pick<Observation, 'itemKey' | 'quality' | 'value'>[],
  statusCodes: ReadonlyMap<string, StatusCodeDefinition>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    if (
      observation.itemKey !== STATUS_CODE_ITEM_KEY ||
      observation.quality !== 'INVALID' ||
      typeof observation.value !== 'string' ||
      observation.value === '' ||
      !isUnregisteredStatusCode(observation.value, statusCodes)
    ) {
      continue;
    }
    const code = truncateStatusCodeValue(observation.value);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

export interface UnregisteredRecordingPlan {
  /** 件数を加える（なければ作る）コード値。新しい値は、件数の多い順（同じなら、コード値の順）。 */
  readonly increments: readonly { readonly code: string; readonly count: number }[];
  /** 上限のため、記録しなかった、新しい値の種類の数。 */
  readonly skippedKinds: number;
}

/** 集計から、記録する値を決める。すでに記録のある値は、常に加算する。新しい値は、上限（1 回に 20・全体で 50 種類）まで、件数の多い順に選ぶ。 */
export function planUnregisteredRecording(
  counts: ReadonlyMap<string, number>,
  recordedCodes: ReadonlySet<string>,
): UnregisteredRecordingPlan {
  const existing: { code: string; count: number }[] = [];
  const created: { code: string; count: number }[] = [];
  for (const [code, count] of counts) {
    (recordedCodes.has(code) ? existing : created).push({ code, count });
  }
  created.sort((left, right) => right.count - left.count || compareCodes(left.code, right.code));
  const room = Math.max(
    0,
    Math.min(UNREGISTERED_CODES_MAX_NEW_PER_RUN, UNREGISTERED_CODES_MAX_TOTAL - recordedCodes.size),
  );
  const accepted = created.slice(0, room);
  return {
    increments: [
      ...existing.sort((left, right) => compareCodes(left.code, right.code)),
      ...accepted,
    ],
    skippedKinds: created.length - accepted.length,
  };
}

/** コード値の順（ロケールに依存しない、文字コード順）。 */
function compareCodes(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** 登録できる形式か（英大文字で始まり、英大文字・数字・アンダースコア。100 文字以内）。 */
export function isRegistrableStatusCode(code: string): boolean {
  return StatusCodeValueSchema.safeParse(code).success;
}

/**
 * 登録ダイアログの、コード値の初期値の案。登録できる形式なら、そのまま。そうでなければ、前後の空白を除き、英大文字にし、
 * 空白・ハイフン・ピリオドの連なりを `_` 1 つにする。それでも登録できる形式にならなければ、なし（利用者が決める）。
 */
export function suggestStatusCode(code: string): string | undefined {
  if (isRegistrableStatusCode(code)) {
    return code;
  }
  const normalized = code
    .trim()
    .toUpperCase()
    .replace(/[\s\-.]+/g, '_');
  return isRegistrableStatusCode(normalized) ? normalized : undefined;
}
