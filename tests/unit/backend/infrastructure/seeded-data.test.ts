/** 開発用 API・E2E のデータ投入のための観測値の生成（buildSeededObservation、expandSeededSeries）の単体テスト。 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toEquipmentId } from '../../../../src/shared/schemas/common.ts';
import {
  MAX_EXPANDED_OBSERVATIONS,
  buildSeededObservation,
  expandSeededSeries,
} from '../../../../src/backend/infrastructure/local/synthetic-data.ts';
import {
  observationMatchesKeyword,
  type ObservationNames,
} from '../../../../src/backend/application/query/observation-query.ts';
import { observation, ROBOT_ID } from '../../../support/builders.ts';

const AT = new Date('2026-10-09T01:00:00.000Z');

describe('buildSeededObservation', () => {
  it('カテゴリを項目カタログから決め、受信日時は計測日時（遅延なし）。自動取り込みはファイルの情報を持つ', () => {
    const result = buildSeededObservation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      observedAt: AT,
      value: 10,
      source: 'AUTO_IMPORT',
      quality: 'VALID',
    });

    expect(result).toEqual({
      equipmentId: ROBOT_ID,
      category: 'HARVEST',
      itemKey: 'harvestCount',
      observedAt: AT.toISOString(),
      value: 10,
      source: 'AUTO_IMPORT',
      quality: 'VALID',
      receivedAt: AT.toISOString(),
      sourceFileId: 'seeded',
      formatProfileVersion: 'seeded@0',
      isDeleted: false,
    });
  });

  it('手動入力は、ファイルの情報を持たない。受信日時を指定できる', () => {
    const receivedAt = new Date('2026-10-09T02:00:00.000Z');

    const result = buildSeededObservation({
      equipmentId: ROBOT_ID,
      itemKey: 'damagedFruitCount',
      observedAt: AT,
      value: 2,
      source: 'MANUAL',
      quality: 'LATE',
      receivedAt,
    });

    expect(result).not.toHaveProperty('sourceFileId');
    expect(result.receivedAt).toBe(receivedAt.toISOString());
    expect(result.quality).toBe('LATE');
  });

  it('項目カタログにない項目は、入力不正', () => {
    expect(() =>
      buildSeededObservation({
        equipmentId: ROBOT_ID,
        itemKey: 'noSuchItem',
        observedAt: AT,
        value: 1,
        source: 'MANUAL',
        quality: 'VALID',
      }),
    ).toThrow(AppError);
  });
});

describe('expandSeededSeries', () => {
  const series = {
    equipmentId: ROBOT_ID,
    itemKey: 'operatingHours',
    source: 'AUTO_IMPORT' as const,
    quality: 'VALID' as const,
    value: 0.25,
    intervalMinutes: 15,
  };

  it('from 以上 to 以下を、一定の間隔で並べる（両端を含む）', () => {
    const result = expandSeededSeries({
      ...series,
      from: AT,
      to: new Date(AT.getTime() + 60 * 60_000),
    });

    expect(result.map((item) => item.observedAt)).toEqual([
      '2026-10-09T01:00:00.000Z',
      '2026-10-09T01:15:00.000Z',
      '2026-10-09T01:30:00.000Z',
      '2026-10-09T01:45:00.000Z',
      '2026-10-09T02:00:00.000Z',
    ]);
    expect(result.every((item) => item.value === 0.25)).toBe(true);
  });

  it('from と to が同じなら1件。to が from より前なら、空', () => {
    expect(expandSeededSeries({ ...series, from: AT, to: AT })).toHaveLength(1);
    expect(
      expandSeededSeries({ ...series, from: AT, to: new Date(AT.getTime() - 60_000) }),
    ).toEqual([]);
  });

  it('展開すると上限を超える指定は、入力不正', () => {
    expect(() =>
      expandSeededSeries({
        ...series,
        intervalMinutes: 1,
        from: AT,
        to: new Date(AT.getTime() + (MAX_EXPANDED_OBSERVATIONS + 1) * 60_000),
      }),
    ).toThrow(AppError);
  });
});

describe('observationMatchesKeyword', () => {
  const names: ObservationNames = {
    equipment: new Map([[ROBOT_ID, 'テストロボット']]),
    statusCodes: new Map([['HARVESTING', '収穫中']]),
  };

  it('空のキーワード（空白のみを含む）は、すべてに一致する', () => {
    const item = observation({ itemKey: 'harvestCount', value: 1 });

    expect(observationMatchesKeyword(item, '', names)).toBe(true);
    expect(observationMatchesKeyword(item, '   ', names)).toBe(true);
  });

  it('値が欠損（null）の観測値は、値では一致せず、他の表示名では一致する', () => {
    const item = observation({ itemKey: 'harvestCount', value: null, quality: 'MISSING' });

    expect(observationMatchesKeyword(item, '収穫数', names)).toBe(true);
    expect(observationMatchesKeyword(item, '欠損', names)).toBe(true);
    expect(observationMatchesKeyword(item, 'null', names)).toBe(false);
  });

  it('登録のない設備・ステータスコードでも、一致しないだけで、エラーにならない', () => {
    const item = observation({
      equipmentId: toEquipmentId('UNKNOWN-EQUIPMENT'),
      itemKey: 'statusCode',
      value: 'UNKNOWN_CODE',
    });

    expect(observationMatchesKeyword(item, 'ロボット', names)).toBe(false);
    expect(observationMatchesKeyword(item, 'unknown_code', names)).toBe(true);
  });
});
