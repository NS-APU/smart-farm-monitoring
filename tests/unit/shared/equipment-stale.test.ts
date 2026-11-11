/**
 * 設備ごとの「データが古い」の基準（Issue #198。ADR-0016 の D-12）の単体テスト。
 * 基準は、その設備の取得間隔 × 倍数（既定 3）、ただし最低 3 分。ハウスは、基準を持たない（配下の設備で判定する）。
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_STALE_THRESHOLD_MINUTES,
  EQUIPMENT_INTERVAL_MINUTES_OPTIONS,
} from '../../../src/shared/constants/status.ts';
import { staleThresholdMinutesOf } from '../../../src/shared/schemas/equipment.ts';

describe('設備ごとの「古い」の基準', () => {
  it('最低 3 分（ADR-0016 の D-12）', () => {
    expect(MIN_STALE_THRESHOLD_MINUTES).toBe(3);
  });

  it.each([
    [1, 3],
    [5, 15],
    [10, 30],
    [15, 45],
    [30, 90],
    [60, 180],
  ])('取得間隔 %i 分 → %i 分（倍数 3。D-12 の表のとおり）', (interval, expected) => {
    expect(staleThresholdMinutesOf({ equipmentType: 'ROBOT', intervalMinutes: interval }, 3)).toBe(
      expected,
    );
    expect(EQUIPMENT_INTERVAL_MINUTES_OPTIONS).toContain(interval);
  });

  it('倍数が小さく、積が 3 分に満たなければ、最低 3 分（1 分 × 2 → 3 分）', () => {
    expect(staleThresholdMinutesOf({ equipmentType: 'ROBOT', intervalMinutes: 1 }, 2)).toBe(3);
  });

  it('取得間隔が未設定なら、種別ごとの既定（ロボット 1 分 → 3 分、センサー 5 分 → 15 分）', () => {
    expect(staleThresholdMinutesOf({ equipmentType: 'ROBOT' }, 3)).toBe(3);
    expect(staleThresholdMinutesOf({ equipmentType: 'SENSOR' }, 3)).toBe(15);
  });

  it('ハウスは、基準を持たない', () => {
    expect(staleThresholdMinutesOf({ equipmentType: 'FACILITY' }, 3)).toBeUndefined();
  });
});
