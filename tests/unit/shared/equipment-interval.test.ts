/**
 * 設備ごとの取得間隔（Issue #197。ADR-0016 の D-11）のスキーマ・既定値の単体テスト。
 * 選べる値は、1・5・10・15・30・60 分（ロボット・センサー共通）。6 時間・日次は、外した。未設定は、種別ごとの既定
 * （ロボット 1 分・センサー 5 分）。ハウスは持てない。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVAL_MINUTES_BY_TYPE,
  EQUIPMENT_INTERVAL_MINUTES_OPTIONS,
} from '../../../src/shared/constants/status.ts';
import {
  EquipmentCreateRequestSchema,
  EquipmentSchema,
  EquipmentUpdateRequestSchema,
  effectiveIntervalMinutes,
} from '../../../src/shared/schemas/equipment.ts';

const ROBOT = {
  equipmentId: 'ROBOT-1',
  equipmentType: 'ROBOT',
  name: 'ロボット 1',
  facilityId: 'HOUSE-1',
} as const;
const HOUSE = { equipmentId: 'HOUSE-1', equipmentType: 'FACILITY', name: 'ハウス 1' } as const;

describe('取得間隔の候補・既定値', () => {
  it('候補は、1・5・10・15・30・60 分。既定は、ロボット 1 分・センサー 5 分（すべて、候補に含まれる）', () => {
    expect(EQUIPMENT_INTERVAL_MINUTES_OPTIONS).toEqual([1, 5, 10, 15, 30, 60]);
    expect(DEFAULT_INTERVAL_MINUTES_BY_TYPE).toEqual({ ROBOT: 1, SENSOR: 5 });
    for (const minutes of Object.values(DEFAULT_INTERVAL_MINUTES_BY_TYPE)) {
      expect(EQUIPMENT_INTERVAL_MINUTES_OPTIONS).toContain(minutes);
    }
  });
});

describe('設備の取得間隔の、実際の値（既定を含む）', () => {
  it('指定があれば、その値。なければ、種別ごとの既定。ハウスは、持たない（undefined）', () => {
    expect(effectiveIntervalMinutes({ equipmentType: 'ROBOT' })).toBe(1);
    expect(effectiveIntervalMinutes({ equipmentType: 'SENSOR' })).toBe(5);
    expect(effectiveIntervalMinutes({ equipmentType: 'ROBOT', intervalMinutes: 30 })).toBe(30);
    expect(effectiveIntervalMinutes({ equipmentType: 'SENSOR', intervalMinutes: 1 })).toBe(1);
    expect(effectiveIntervalMinutes({ equipmentType: 'FACILITY' })).toBeUndefined();
  });
});

describe('設備の登録・修正・保存の、取得間隔', () => {
  it.each([1, 5, 10, 15, 30, 60])('%i 分は、有効（登録・修正・保存）', (minutes) => {
    expect(
      EquipmentCreateRequestSchema.safeParse({ ...ROBOT, intervalMinutes: minutes }).success,
    ).toBe(true);
    expect(
      EquipmentUpdateRequestSchema.safeParse({ name: 'ロボット', intervalMinutes: minutes })
        .success,
    ).toBe(true);
    expect(
      EquipmentSchema.safeParse({
        ...ROBOT,
        intervalMinutes: minutes,
        isDeleted: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it.each([0, 2, 3, 20, 45, 61, 120, 360, 1440, -1, 1.5, '5', null])(
    '%j は、無効（登録・修正）',
    (value) => {
      expect(
        EquipmentCreateRequestSchema.safeParse({ ...ROBOT, intervalMinutes: value }).success,
      ).toBe(false);
      expect(
        EquipmentUpdateRequestSchema.safeParse({ name: 'ロボット', intervalMinutes: value })
          .success,
      ).toBe(false);
    },
  );

  it('ハウスには、指定できない（登録・保存）。省略は、有効', () => {
    expect(EquipmentCreateRequestSchema.safeParse({ ...HOUSE, intervalMinutes: 5 }).success).toBe(
      false,
    );
    expect(
      EquipmentSchema.safeParse({
        ...HOUSE,
        intervalMinutes: 5,
        isDeleted: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(EquipmentCreateRequestSchema.safeParse(HOUSE).success).toBe(true);
    expect(EquipmentCreateRequestSchema.safeParse(ROBOT).success).toBe(true);
  });
});
