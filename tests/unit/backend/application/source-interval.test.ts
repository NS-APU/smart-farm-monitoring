/**
 * 取り込み元の代表の取得間隔（Issue #197）の単体テスト。取得間隔は、設備ごとの設定のため、
 * 「データが古い」の判定・停止の通知の基準（#198 まで）には、その種別の設備の最長の取得間隔を使う。
 */

import { describe, expect, it } from 'vitest';
import { representativeIntervalMinutes } from '../../../../src/backend/application/ingestion/source-interval.ts';

describe('取り込み元の代表の取得間隔', () => {
  it('その種別の設備の、最長の取得間隔（指定のない設備は、種別の既定）', () => {
    const equipment = [
      { equipmentType: 'ROBOT', intervalMinutes: 10 },
      { equipmentType: 'ROBOT', intervalMinutes: 30 },
      { equipmentType: 'ROBOT' },
      { equipmentType: 'SENSOR', intervalMinutes: 1 },
    ] as const;

    expect(representativeIntervalMinutes('ROBOT', equipment)).toBe(30);
    expect(representativeIntervalMinutes('SENSOR', equipment)).toBe(1);
  });

  it('ほかの種別・ハウスは、数えない', () => {
    const equipment = [
      { equipmentType: 'FACILITY' },
      { equipmentType: 'SENSOR', intervalMinutes: 60 },
    ] as const;

    expect(representativeIntervalMinutes('ROBOT', equipment)).toBe(1);
  });

  it('設備が 1 つもなければ、種別ごとの既定（ロボット 1 分・センサー 5 分）', () => {
    expect(representativeIntervalMinutes('ROBOT', [])).toBe(1);
    expect(representativeIntervalMinutes('SENSOR', [])).toBe(5);
  });
});
