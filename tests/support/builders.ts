/** テストデータの生成（合成データ）。実データは使わない。 */

import { toEquipmentId } from '../../src/shared/schemas/common.ts';
import type { EquipmentId, UserId } from '../../src/shared/schemas/common.ts';
import type { Equipment } from '../../src/shared/schemas/equipment.ts';
import type { Observation } from '../../src/shared/schemas/observation.ts';
import type { StatusCodeDefinition } from '../../src/shared/schemas/status-code.ts';
import { itemsOfCategory } from '../../src/shared/constants/items.ts';

export const FACILITY_ID = toEquipmentId('HOUSE-T1');
export const ROBOT_ID = toEquipmentId('ROBOT-T1');
export const SENSOR_ID = toEquipmentId('SENSOR-T1');
export const ROBOT_EXTERNAL_ID = 'ROBOT-SAMPLE-01';
export const SENSOR_EXTERNAL_ID = 'SENSOR-SAMPLE-01';

export function equipmentSet(createdAt = '2026-10-01T00:00:00.000Z'): Equipment[] {
  return [
    {
      equipmentId: FACILITY_ID,
      equipmentType: 'FACILITY',
      name: 'テストハウス',
      isDeleted: false,
      createdAt,
    },
    {
      equipmentId: ROBOT_ID,
      equipmentType: 'ROBOT',
      name: 'テストロボット',
      facilityId: FACILITY_ID,
      externalId: ROBOT_EXTERNAL_ID,
      isDeleted: false,
      createdAt,
    },
    {
      equipmentId: SENSOR_ID,
      equipmentType: 'SENSOR',
      name: 'テストセンサー',
      facilityId: FACILITY_ID,
      externalId: SENSOR_EXTERNAL_ID,
      isDeleted: false,
      createdAt,
    },
  ];
}

/** 2 つ目のハウス（ハウス・ロボット・センサー）。閲覧の割り当て（ハウスごと）のテストで、範囲外の設備に使う。 */
export const FACILITY_2_ID = toEquipmentId('HOUSE-T2');
export const ROBOT_2_ID = toEquipmentId('ROBOT-T2');
export const SENSOR_2_ID = toEquipmentId('SENSOR-T2');

export function secondHouseSet(createdAt = '2026-10-02T00:00:00.000Z'): Equipment[] {
  return [
    {
      equipmentId: FACILITY_2_ID,
      equipmentType: 'FACILITY',
      name: 'テストハウス2',
      isDeleted: false,
      createdAt,
    },
    {
      equipmentId: ROBOT_2_ID,
      equipmentType: 'ROBOT',
      name: 'テストロボット2',
      facilityId: FACILITY_2_ID,
      externalId: 'ROBOT-SAMPLE-02',
      isDeleted: false,
      createdAt,
    },
    {
      equipmentId: SENSOR_2_ID,
      equipmentType: 'SENSOR',
      name: 'テストセンサー2',
      facilityId: FACILITY_2_ID,
      externalId: 'SENSOR-SAMPLE-02',
      isDeleted: false,
      createdAt,
    },
  ];
}

/**
 * ステータスコードの定義（合成データ）。ドメインの単体テストが、アプリケーション層の初期データ
 * （application/seed/initial-data.ts）に依存しないよう、テスト側で持つ。値は、初期データと同じ内容にしている。
 */
export const STATUS_CODE_FIXTURES: readonly StatusCodeDefinition[] = [
  { code: 'STANDBY', name: '待機中', category: 'NORMAL', isDeleted: false },
  { code: 'RUNNING', name: '走行中', category: 'NORMAL', isDeleted: false },
  { code: 'HARVESTING', name: '収穫中', category: 'NORMAL', isDeleted: false },
  { code: 'STOPPED', name: '停止中', category: 'CAUTION', isDeleted: false },
  { code: 'LOW_BATTERY', name: 'バッテリー不足', category: 'CAUTION', isDeleted: false },
  { code: 'RUNNING_ERROR', name: '走行異常', category: 'ERROR', isDeleted: false },
  { code: 'HARVEST_ERROR', name: '収穫異常', category: 'ERROR', isDeleted: false },
  { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR', isDeleted: false },
];

export function statusCodeMap(): Map<string, StatusCodeDefinition> {
  return new Map(STATUS_CODE_FIXTURES.map((definition) => [definition.code, definition]));
}

export interface ObservationOverrides {
  readonly equipmentId?: EquipmentId;
  readonly itemKey: string;
  readonly value: number | string | null;
  readonly observedAt?: string;
  readonly receivedAt?: string;
  readonly source?: Observation['source'];
  readonly quality?: Observation['quality'];
  readonly isDeleted?: boolean;
  /** 入力者（手動入力）。 */
  readonly enteredBy?: UserId;
}

/** 観測値を作る。カテゴリは、項目カタログから決める（ステータスコードは STATUS）。 */
export function observation(overrides: ObservationOverrides): Observation {
  const observedAt = overrides.observedAt ?? '2026-10-09T02:00:00.000Z';
  const category =
    overrides.itemKey === 'statusCode'
      ? 'STATUS'
      : (
          [
            'HARVEST',
            'OPERATION',
            'ENVIRONMENT',
            'OPERABILITY',
            'SAFETY',
            'COST',
            'FAILURE',
            'SATISFACTION',
          ] as const
        ).find((candidate) =>
          itemsOfCategory(candidate).some((item) => item.itemKey === overrides.itemKey),
        );
  if (category === undefined) {
    throw new Error(`カタログにない項目です: ${overrides.itemKey}`);
  }
  return {
    equipmentId: overrides.equipmentId ?? ROBOT_ID,
    category,
    itemKey: overrides.itemKey,
    observedAt,
    value: overrides.value,
    source: overrides.source ?? 'AUTO_IMPORT',
    quality: overrides.quality ?? 'VALID',
    receivedAt: overrides.receivedAt ?? observedAt,
    ...(overrides.enteredBy === undefined ? {} : { enteredBy: overrides.enteredBy }),
    isDeleted: overrides.isDeleted ?? false,
  };
}

/** 項目の値の組から、同じ時刻の観測値を作る。 */
export function observations(
  values: Readonly<Record<string, number | string>>,
  options: Omit<ObservationOverrides, 'itemKey' | 'value'> = {},
): Observation[] {
  return Object.entries(values).map(([itemKey, value]) =>
    observation({ ...options, itemKey, value }),
  );
}

/** テストの前提となる値を取り出す。なければ、前提が崩れているため、テストを失敗させる。 */
export function must<Value>(
  value: Value | undefined,
  message = 'テストの前提が成り立っていません',
): Value {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}
