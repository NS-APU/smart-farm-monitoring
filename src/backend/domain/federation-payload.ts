/**
 * 連携キューの項目の内容の分割（純粋関数。ADR-0016 の D-06。Issue #205）。
 * 連携キューの 1 項目は、データベース（DynamoDB）の 1 項目で、上限は約 400 KB。1 つのファイル分の観測値を、そのまま 1 項目に入れると、
 * 観測値が多いファイルで、上限を超えて、積めない。観測値が上限の件数を超える場合は、複数の項目に分ける。
 */

/**
 * 1 項目に入れる観測値の件数の上限。観測値 1 件は、約 300 バイト（JSON）で、1,000 件で約 300 KB（上限の約 400 KB の 3/4）。
 * DynamoDB Local での実測: 同じ形の観測値は、1,500 件（約 460 KB）まで保存でき、2,000 件で上限を超えた。
 */
export const MAX_OBSERVATIONS_PER_FEDERATION_ITEM = 1000;

export interface FederationItemPart {
  readonly targetRef: string;
  readonly payload: Record<string, unknown>;
}

/**
 * 観測値の配列（payload.observations）が上限を超えるときは、上限の件数ごとの複数の項目に分ける。順序は保つ。
 * 分けた項目は、参照に連番（\`{元の参照}#part-{番号}-of-{総数}\`）を付け、内容に何番目か（part: { index, total }）を持たせる。
 * 受け手は、観測値の一意キー（設備・項目・計測日時）で、重複・順序の入れ替わりを吸収する（D-06）。
 * 上限以下・観測値の配列を持たない内容は、そのまま 1 項目にする。
 */
export function splitObservationPayload(
  targetRef: string,
  payload: Record<string, unknown>,
): FederationItemPart[] {
  const { observations } = payload;
  if (!Array.isArray(observations) || observations.length <= MAX_OBSERVATIONS_PER_FEDERATION_ITEM) {
    return [{ targetRef, payload }];
  }
  const total = Math.ceil(observations.length / MAX_OBSERVATIONS_PER_FEDERATION_ITEM);
  return Array.from({ length: total }, (_, index) => ({
    targetRef: `${targetRef}#part-${String(index + 1)}-of-${String(total)}`,
    payload: {
      ...payload,
      observations: observations.slice(
        index * MAX_OBSERVATIONS_PER_FEDERATION_ITEM,
        (index + 1) * MAX_OBSERVATIONS_PER_FEDERATION_ITEM,
      ),
      part: { index: index + 1, total },
    },
  }));
}

/**
 * 連携の内容（payload）の、送るデータの設備（Issue #332）。評価の項目は `equipmentId`、観測値の項目は `observations[].equipmentId`。
 * 重複は除く。設備を特定できない内容は、空。
 */
export function equipmentIdsOfPayload(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (typeof payload.equipmentId === 'string') {
    ids.add(payload.equipmentId);
  }
  if (Array.isArray(payload.observations)) {
    for (const observation of payload.observations as unknown[]) {
      const equipmentId =
        typeof observation === 'object' && observation !== null
          ? (observation as { equipmentId?: unknown }).equipmentId
          : undefined;
      if (typeof equipmentId === 'string') {
        ids.add(equipmentId);
      }
    }
  }
  return [...ids];
}
