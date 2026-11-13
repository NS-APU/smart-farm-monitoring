/**
 * 農業情報基盤への連携の変換（純粋関数。ADR-0024。Issue #177）。
 * 連携キューの項目（観測値・評価結果）を、NGSI-LD のエンティティ（の断片）にする。
 * - 環境の項目（温度・湿度・照度・CO2）: スマートデータモデルの IndoorEnvironmentObserved（設備ごと）
 * - ほかの観測値: 独自の EquipmentObserved（設備ごと）
 * - 評価結果: 独自の ViewpointEvaluation（設備×観点ごと）
 * 送らないもの: 削除済み・値のない・不正の観測値、手動入力の備考・入力者（利用者のデータ。D-35 の範囲外）。
 * 値は、こちらの単位のまま送り、unitCode（UN/CEFACT）を付ける。
 */

import { findItemDefinition } from '@smart-farm/shared/constants/items';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import type { EquipmentType } from '@smart-farm/shared/constants/status';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import type { Observation } from '@smart-farm/shared/schemas/observation';

/** NGSI-LD のエンティティ（属性は、型ごとに違う。値は、JSON にできる内容）。 */
export interface NgsiLdEntity {
  readonly id: string;
  readonly type: string;
  readonly [attribute: string]: unknown;
}

/** エンティティの 1 時点の断片（同じエンティティの更新は、時刻ごとの断片にする）。 */
export interface NgsiLdFragment {
  /** 断片の時刻（計測日時・評価日時。ISO 8601 UTC）。 */
  readonly at: string;
  readonly entity: NgsiLdEntity;
}

/** 設備の種別を引く（分からなければ undefined）。 */
export type EquipmentTypeLookup = (equipmentId: string) => EquipmentType | undefined;

/** 設備のエンティティの型（独自）。 */
const EQUIPMENT_ENTITY_TYPES: Readonly<Record<EquipmentType, string>> = {
  FACILITY: 'Greenhouse',
  ROBOT: 'HarvestRobot',
  SENSOR: 'EnvironmentSensor',
};

/** エンティティの識別子: `urn:ngsi-ld:{型}:{部分}[:{部分}]`。URN で使えない文字は、パーセントエンコードする。 */
export function entityIdOf(type: string, ...parts: readonly string[]): string {
  return `urn:ngsi-ld:${type}:${parts.map((part) => encodeURIComponent(part)).join(':')}`;
}

/** 設備のエンティティの識別子（種別が分からなければ undefined）。 */
export function equipmentEntityIdOf(
  equipmentId: string,
  equipmentType: EquipmentType | undefined,
): string | undefined {
  return equipmentType === undefined
    ? undefined
    : entityIdOf(EQUIPMENT_ENTITY_TYPES[equipmentType], equipmentId);
}

/** 環境の項目の標準の属性名（スマートデータモデル IndoorEnvironmentObserved）。 */
const ENVIRONMENT_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  temperatureCelsius: 'temperature',
  humidityPercent: 'relativeHumidity',
  illuminanceLux: 'illuminance',
  co2Ppm: 'co2',
};

/** 英数字以外で区切って、ローワーキャメルにする（`satisfaction.harvestAccuracy` → `satisfactionHarvestAccuracy`）。 */
function toCamelCase(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  return words
    .map((word, index) => (index === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join('');
}

/** 項目の識別子から、属性名にする（環境の 4 項目は標準の名前。「.」などは、ローワーキャメルにする）。 */
export function attributeNameOf(itemKey: string): string {
  return ENVIRONMENT_ATTRIBUTE_NAMES[itemKey] ?? toCamelCase(itemKey);
}

const UNIT_CODES: Readonly<Record<string, string>> = {
  '℃': 'CEL',
  '%': 'P1',
  lx: 'LUX',
  ppm: '59',
  時間: 'HUR',
  分: 'MIN',
  秒: 'SEC',
  '秒/果実': 'SEC',
  個: 'C62',
  回: 'C62',
  件: 'C62',
};

/** こちらの単位から、unitCode（UN/CEFACT）にする（円・スターなど、対応がないものは、なし）。 */
export function unitCodeOf(unit: string): string | undefined {
  return UNIT_CODES[unit];
}

function property(
  value: number | string,
  observedAt: string,
  unitCode: string | undefined,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'Property',
    value,
    ...(unitCode === undefined ? {} : { unitCode }),
    observedAt,
    ...extra,
  };
}

function relationship(object: string | undefined): Record<string, unknown> {
  return object === undefined ? {} : { type: 'Relationship', object };
}

/** 送る観測値か（削除済み・値のない・不正・カタログにない項目は、送らない）。 */
function isSendable(observation: Observation): boolean {
  return (
    !observation.isDeleted &&
    observation.value !== null &&
    (observation.quality === 'VALID' || observation.quality === 'LATE') &&
    findItemDefinition(observation.itemKey) !== undefined
  );
}

/** 観測値の断片: 設備・領域（環境／それ以外）・計測日時ごとに、1 つ。 */
function fragmentsOfObservations(
  observations: readonly Observation[],
  typeOf: EquipmentTypeLookup,
): NgsiLdFragment[] {
  const groups = new Map<string, { entity: Record<string, unknown>; at: string }>();
  for (const observation of observations.filter(isSendable)) {
    const item = findItemDefinition(observation.itemKey);
    const value = observation.value;
    if (item === undefined || value === null) {
      continue;
    }
    const isEnvironment = item.category === 'ENVIRONMENT';
    const entityType = isEnvironment ? 'IndoorEnvironmentObserved' : 'EquipmentObserved';
    const key = `${entityType}#${observation.equipmentId}#${observation.observedAt}`;
    let group = groups.get(key);
    if (group === undefined) {
      const equipmentType = typeOf(observation.equipmentId);
      group = {
        at: observation.observedAt,
        entity: {
          id: entityIdOf(entityType, observation.equipmentId),
          type: entityType,
          ...(isEnvironment
            ? {
                dateObserved: {
                  type: 'Property',
                  value: { '@type': 'DateTime', '@value': observation.observedAt },
                },
                // センサーのときだけ、refDevice（センサーのエンティティ）を付ける
                ...(equipmentType === 'SENSOR'
                  ? {
                      refDevice: relationship(
                        equipmentEntityIdOf(observation.equipmentId, equipmentType),
                      ),
                    }
                  : {}),
              }
            : {
                ...(equipmentType === undefined
                  ? {}
                  : {
                      refEquipment: relationship(
                        equipmentEntityIdOf(observation.equipmentId, equipmentType),
                      ),
                    }),
              }),
        },
      };
      groups.set(key, group);
    }
    group.entity[attributeNameOf(observation.itemKey)] = property(
      value,
      observation.observedAt,
      unitCodeOf(item.unit),
      { source: { type: 'Property', value: observation.source } },
    );
  }
  // 計測日時の古い順に並べる
  return [...groups.values()]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map(({ entity, at }) => ({ at, entity: entity as unknown as NgsiLdEntity }));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 評価結果の断片（内容が正しくなければ、なし）。指標は、数値の属性（`metric` + 指標の識別子）に平らにする。 */
function fragmentsOfEvaluation(
  payload: Record<string, unknown>,
  typeOf: EquipmentTypeLookup,
): NgsiLdFragment[] {
  const { equipmentId, viewpointId, status, metrics, diagnosticMessage, recommendedAction } =
    payload;
  const evaluatedAt = payload.evaluatedAt;
  if (
    !isNonEmptyString(equipmentId) ||
    !isNonEmptyString(viewpointId) ||
    !isNonEmptyString(status) ||
    !isNonEmptyString(evaluatedAt) ||
    typeof metrics !== 'object' ||
    metrics === null
  ) {
    return [];
  }
  const entity: Record<string, unknown> = {
    id: entityIdOf('ViewpointEvaluation', equipmentId, viewpointId),
    type: 'ViewpointEvaluation',
    ...(typeOf(equipmentId) === undefined
      ? {}
      : { refEquipment: relationship(equipmentEntityIdOf(equipmentId, typeOf(equipmentId))) }),
    status: property(status, evaluatedAt, undefined),
  };
  if (typeof diagnosticMessage === 'string') {
    entity.diagnosticMessage = property(diagnosticMessage, evaluatedAt, undefined);
  }
  if (typeof recommendedAction === 'string') {
    entity.recommendedAction = property(recommendedAction, evaluatedAt, undefined);
  }
  for (const [metricId, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const name = toCamelCase(`metric ${metricId}`);
      entity[name] = property(value, evaluatedAt, unitCodeOf(getMetricMeta(metricId).unit));
    }
  }
  return [{ at: evaluatedAt, entity: entity as unknown as NgsiLdEntity }];
}

/** 連携キューの項目を、エンティティの断片にする（送るものがなければ、空）。 */
export function fragmentsOfItem(
  item: FederationItem,
  typeOf: EquipmentTypeLookup,
): NgsiLdFragment[] {
  if (item.targetType === 'EVALUATION') {
    return fragmentsOfEvaluation(item.payload, typeOf);
  }
  const observations = item.payload.observations;
  return Array.isArray(observations)
    ? fragmentsOfObservations(observations as Observation[], typeOf)
    : [];
}

/**
 * 断片を、upsert の要求（エンティティの配列）に分ける。
 * - 1 回の要求に、同じエンティティは 1 つだけ（同じエンティティの複数の時刻は、古い順に、別の要求にする）
 * - 1 回の要求のエンティティは、`maxPerRequest` まで
 * 返す配列は、送る順（古い順）。
 */
export function requestsOf(
  fragments: readonly NgsiLdFragment[],
  maxPerRequest: number,
): NgsiLdEntity[][] {
  const sorted = [...fragments].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const layers: NgsiLdEntity[][] = [];
  const layerOfEntity = new Map<string, number>();
  for (const { entity } of sorted) {
    const layer = layerOfEntity.get(entity.id) ?? 0;
    layerOfEntity.set(entity.id, layer + 1);
    (layers[layer] ??= []).push(entity);
  }
  return layers.flatMap((entities) => {
    const requests: NgsiLdEntity[][] = [];
    for (let start = 0; start < entities.length; start += maxPerRequest) {
      requests.push(entities.slice(start, start + maxPerRequest));
    }
    return requests;
  });
}
