import { describe, expect, it } from 'vitest';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import {
  aggregateWorstResults,
  type MemberResults,
} from '../../../../src/backend/domain/evaluation/worst-result.ts';

const HOUSE = toEquipmentId('HOUSE-W');
const NOW = new Date('2026-10-09T03:00:00Z');

function result(
  equipmentId: string,
  status: EvaluationStatus,
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    equipmentId: toEquipmentId(equipmentId),
    viewpointId: 'harvestAccuracy',
    horizon: 'SHORT',
    periodDays: null,
    status,
    metrics: { marketableFruitRatePercent: status === 'ERROR' ? 70 : 95 },
    indicatorStatuses: { marketableFruitRatePercent: status },
    statusDetail: null,
    diagnosticMessage: `収穫精度: ${status}（${equipmentId}）`,
    recommendedAction: `行動（${equipmentId}）`,
    criteriaVersion: 'DEFAULT',
    isCustomCriteria: false,
    evaluatedFrom: '2026-10-08T03:00:00.000Z',
    evaluatedTo: '2026-10-09T03:00:00.000Z',
    evaluatedAt: '2026-10-09T02:59:00.000Z',
    ...overrides,
  };
}

function member(name: string, results: EvaluationResult[]): MemberResults {
  return { equipmentName: name, results };
}

function aggregate(members: MemberResults[]) {
  return aggregateWorstResults({ equipmentId: HOUSE, members, evaluatedAt: NOW });
}

describe('ハウスの結果: 配下の設備の最も悪い結果（D-19）', () => {
  it('最も悪い設備の結果を採り、どの設備かを診断メッセージの先頭に示す。メトリクス・推奨アクションも、その設備のもの', () => {
    const [house] = aggregate([
      member('収穫ロボット1', [result('R1', 'NORMAL')]),
      member('収穫ロボット2', [result('R2', 'ERROR')]),
    ]);

    expect(house).toMatchObject({
      equipmentId: HOUSE,
      viewpointId: 'harvestAccuracy',
      horizon: 'SHORT',
      status: 'ERROR',
      metrics: { marketableFruitRatePercent: 70 },
      recommendedAction: '行動（R2）',
      evaluatedAt: NOW.toISOString(),
    });
    expect(house?.diagnosticMessage).toBe('（収穫ロボット2）収穫精度: ERROR（R2）');
  });

  it('異常 > 注意 > 正常の順に、悪い方を採る', () => {
    const [house] = aggregate([
      member('A', [result('A', 'NORMAL')]),
      member('B', [result('B', 'CAUTION')]),
      member('C', [result('C', 'NORMAL')]),
    ]);

    expect(house?.status).toBe('CAUTION');
    expect(house?.diagnosticMessage).toContain('（B）');
  });

  it('「不明」は除いて、最も悪い判定を採る（不明の設備があっても、判定できた設備の悪化を見逃さない）', () => {
    const [house] = aggregate([
      member('A', [result('A', 'UNKNOWN')]),
      member('B', [result('B', 'NORMAL')]),
    ]);

    expect(house?.status).toBe('NORMAL');
    expect(house?.diagnosticMessage).toContain('（B）');
  });

  it('すべて「不明」なら「不明」。設備名は付けない（悪い設備がない）', () => {
    const [house] = aggregate([
      member('A', [result('A', 'UNKNOWN')]),
      member('B', [result('B', 'UNKNOWN')]),
    ]);

    expect(house?.status).toBe('UNKNOWN');
    expect(house?.diagnosticMessage).toBe('収穫精度: UNKNOWN（A）');
  });

  it('同じ悪さの設備が複数あるときは、登録順で先頭の設備を採る', () => {
    const [house] = aggregate([
      member('A', [result('A', 'ERROR')]),
      member('B', [result('B', 'ERROR')]),
    ]);

    expect(house?.recommendedAction).toBe('行動（A）');
    expect(house?.diagnosticMessage).toContain('（A）');
  });

  it('設備が 1 つだけ（1:1:1）なら、その設備の結果と同じ。診断メッセージに設備名を付けない', () => {
    const only = result('R1', 'ERROR');

    const [house] = aggregate([member('収穫ロボット1', [only])]);

    expect(house).toEqual({ ...only, equipmentId: HOUSE, evaluatedAt: NOW.toISOString() });
  });

  it('観点・視点・期間ごとに、別々に最悪を採る（短期はロボット 2、長期の 7 日はロボット 1 が最悪）', () => {
    const results = aggregate([
      member('A', [
        result('A', 'NORMAL'),
        result('A', 'ERROR', { horizon: 'LONG', periodDays: 7 }),
      ]),
      member('B', [
        result('B', 'ERROR'),
        result('B', 'NORMAL', { horizon: 'LONG', periodDays: 7 }),
      ]),
    ]);

    const short = results.find((item) => item.horizon === 'SHORT');
    const long = results.find((item) => item.horizon === 'LONG');
    expect(results).toHaveLength(2);
    expect(short?.diagnosticMessage).toContain('（B）');
    expect(long?.periodDays).toBe(7);
    expect(long?.diagnosticMessage).toContain('（A）');
  });

  it('観点ごとに、その観点の結果を持つ設備だけから採る（センサーは環境適応性だけ）', () => {
    const results = aggregate([
      member('ロボット', [result('R', 'ERROR')]),
      member('センサー', [result('S', 'CAUTION', { viewpointId: 'environmentalAdaptability' })]),
    ]);

    expect(results.map((item) => item.viewpointId).sort()).toEqual([
      'environmentalAdaptability',
      'harvestAccuracy',
    ]);
    // 観点ごとに、その観点の結果を持つ設備が 1 つだけなので、設備名は付けない
    expect(results.find((item) => item.viewpointId === 'harvestAccuracy')?.diagnosticMessage).toBe(
      '収穫精度: ERROR（R）',
    );
  });

  it('配下の設備に結果がなければ、結果を返さない', () => {
    expect(aggregate([])).toEqual([]);
    expect(aggregate([member('A', [])])).toEqual([]);
  });
});
