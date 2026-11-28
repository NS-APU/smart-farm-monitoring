/**
 * 手動入力が、評価に使われるかの判定（D-26。純粋関数）の単体テスト。
 * 合計（累積）の項目は、評価の期間に自動取り込みの値が 1 件でもあれば、自動だけを使い、手動入力は使わない。
 * 保存の応答（項目ごとの「評価に使われるか」）と、計測データの「評価に使われていません」の印（#162）が使う。
 */

import { describe, expect, it } from 'vitest';
import {
  evaluationPeriods,
  judgeManualUsage,
  judgeManualUsageInEvaluationPeriods,
} from '../../../../src/backend/domain/evaluation/manual-usage.ts';
import { aggregateMeasures } from '../../../../src/backend/domain/evaluation/measures.ts';
import { toEquipmentId } from '../../../../src/shared/schemas/common.ts';
import type { Observation } from '../../../../src/shared/schemas/observation.ts';
import {
  observation,
  ROBOT_ID,
  SENSOR_ID,
  statusCodeMap,
  type ObservationOverrides,
} from '../../../support/builders.ts';

const NOW = new Date('2026-10-09T03:00:00Z');
const DAY_MS = 86_400_000;
const FROM = new Date(NOW.getTime() - 7 * DAY_MS);

const at = (hhmm: string, day = '09'): string => `2026-10-${day}T${hhmm}:00Z`;

function cumulative(
  source: 'AUTO_IMPORT' | 'MANUAL',
  value: number,
  hhmm: string,
  overrides: Partial<ObservationOverrides> = {},
): Observation {
  return observation({
    itemKey: 'harvestCount',
    value,
    source,
    observedAt: at(hhmm),
    ...overrides,
  });
}

function judge(observations: readonly Observation[], period = { from: FROM, to: NOW }) {
  return judgeManualUsage({ observations, ...period });
}

describe('手動入力が評価に使われるかの判定（1 つの評価の期間）', () => {
  it('合計（累積）の項目で、期間に自動があれば、手動入力は使われない（理由: 自動を優先）', () => {
    const manual = cumulative('MANUAL', 1700, '01:00');

    const [result, ...rest] = judge([cumulative('AUTO_IMPORT', 1800, '00:00'), manual]);

    expect(rest).toEqual([]);
    expect(result).toEqual({ observation: manual, used: false, reason: 'AUTO_PRIORITY' });
  });

  it('合計（累積）の項目でも、期間に自動がなければ、手動入力は使われる', () => {
    const manual = cumulative('MANUAL', 1700, '01:00');

    expect(judge([manual])).toEqual([{ observation: manual, used: true, reason: 'USED' }]);
  });

  it('自動が期間の外にしかなければ、手動入力は使われる（自動の有無は、評価の期間ごとに判定する）', () => {
    const manual = cumulative('MANUAL', 1700, '01:00');
    const outsideAuto = cumulative('AUTO_IMPORT', 1800, '00:00', { observedAt: at('00:00', '01') });

    expect(judge([outsideAuto, manual])[0]?.used).toBe(true);
  });

  it('使えない自動（論理削除・欠損・不正・評価時刻より後に受信）は、自動として数えない', () => {
    const manual = cumulative('MANUAL', 1700, '01:00');
    const unusable: Partial<ObservationOverrides>[] = [
      { isDeleted: true },
      { value: null, quality: 'MISSING' },
      { quality: 'INVALID' },
      { receivedAt: '2026-10-09T05:00:00Z' },
    ];

    for (const override of unusable) {
      const results = judge([cumulative('AUTO_IMPORT', 1800, '00:00', override), manual]);

      expect(results[0]?.used, JSON.stringify(override)).toBe(true);
    }
  });

  it('自動の有無は、設備・項目ごとに判定する', () => {
    const otherRobot = toEquipmentId('ROBOT-T2');
    const sameItemOtherEquipment = cumulative('MANUAL', 10, '01:00', { equipmentId: otherRobot });
    const otherItem = observation({
      itemKey: 'operatingHours',
      value: 2,
      source: 'MANUAL',
      observedAt: at('01:00'),
    });
    const sameItem = cumulative('MANUAL', 1700, '01:00');

    const results = judge([
      cumulative('AUTO_IMPORT', 1800, '00:00'),
      sameItemOtherEquipment,
      otherItem,
      sameItem,
    ]);

    expect(results.map(({ used, reason }) => ({ used, reason }))).toEqual([
      { used: true, reason: 'USED' },
      { used: true, reason: 'USED' },
      { used: false, reason: 'AUTO_PRIORITY' },
    ]);
  });

  it('状態値（温度など）・ステータスコード・手動専用の件数の項目は、自動があっても、手動入力が使われる', () => {
    const manuals = [
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 30,
        source: 'MANUAL',
        observedAt: at('02:00'),
      }),
      observation({
        itemKey: 'statusCode',
        value: 'STOPPED',
        source: 'MANUAL',
        observedAt: at('02:00'),
      }),
      observation({
        itemKey: 'damagedFruitCount',
        value: 3,
        source: 'MANUAL',
        observedAt: at('02:00'),
      }),
    ];
    const autos = [
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 20,
        observedAt: at('01:00'),
      }),
      observation({ itemKey: 'statusCode', value: 'RUNNING', observedAt: at('01:00') }),
      observation({ itemKey: 'damagedFruitCount', value: 1, observedAt: at('01:00') }),
    ];

    const results = judge([...autos, ...manuals]);

    expect(results.map(({ observation: item }) => item)).toEqual(manuals);
    expect(results.every(({ used, reason }) => used && reason === 'USED')).toBe(true);
  });

  it('期間の外の手動入力は、使われない（理由: 期間の外）。自動の有無によらない', () => {
    const early = cumulative('MANUAL', 100, '01:00', { observedAt: at('01:00', '01') });
    const late = cumulative('MANUAL', 300, '04:00', { receivedAt: at('00:00') });

    const results = judge([early, late]);

    expect(results.map(({ used, reason }) => ({ used, reason }))).toEqual([
      { used: false, reason: 'OUT_OF_PERIOD' },
      { used: false, reason: 'OUT_OF_PERIOD' },
    ]);
  });

  it('論理削除・欠損・不正・評価時刻より後に受信した手動入力は、使われない（理由: 使えない値）', () => {
    const unusable: Partial<ObservationOverrides>[] = [
      { isDeleted: true },
      { value: null, quality: 'MISSING' },
      { quality: 'INVALID' },
      { receivedAt: '2026-10-09T05:00:00Z' },
    ];

    for (const override of unusable) {
      const [result] = judge([cumulative('MANUAL', 1700, '01:00', override)]);

      expect(result, JSON.stringify(override)).toMatchObject({ used: false, reason: 'UNUSABLE' });
    }
  });

  it('評価時刻までの受信の指定（knownAt）で、その時点の判定にできる', () => {
    const manual = cumulative('MANUAL', 1700, '01:00');
    const lateAuto = cumulative('AUTO_IMPORT', 1800, '00:00', {
      receivedAt: '2026-10-09T02:30:00Z',
    });

    const before = judgeManualUsage({
      observations: [lateAuto, manual],
      from: FROM,
      to: NOW,
      knownAt: new Date('2026-10-09T02:00:00Z'),
    });
    const after = judge([lateAuto, manual]);

    // 遅れて受信した自動（02:30 に受信）は、02:00 の時点では、まだ取り込まれていない
    expect(after[0]?.reason).toBe('AUTO_PRIORITY');
    expect(before[0]?.used).toBe(true);
  });

  it('設備・項目で絞り込める（結果は、その設備・項目の手動入力だけ）', () => {
    const robotHarvest = cumulative('MANUAL', 1700, '01:00');
    const robotOperating = observation({
      itemKey: 'operatingHours',
      value: 2,
      source: 'MANUAL',
      observedAt: at('01:00'),
    });
    const sensorTemperature = observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 20,
      source: 'MANUAL',
      observedAt: at('01:00'),
    });
    const observations = [robotHarvest, robotOperating, sensorTemperature];

    expect(
      judgeManualUsage({ observations, from: FROM, to: NOW, equipmentId: ROBOT_ID }).map(
        (result) => result.observation,
      ),
    ).toEqual([robotHarvest, robotOperating]);
    expect(
      judgeManualUsage({
        observations,
        from: FROM,
        to: NOW,
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
      }).map((result) => result.observation),
    ).toEqual([robotHarvest]);
  });

  it('自動取り込みの観測値は、結果に含めない（手動入力だけを返す）', () => {
    expect(judge([cumulative('AUTO_IMPORT', 1800, '00:00')])).toEqual([]);
  });

  it('集計（aggregateMeasures）の取得元の選択と一致する（使われる手動入力だけが、集計の値に入る）', () => {
    const observations = [
      cumulative('AUTO_IMPORT', 1800, '00:00'),
      cumulative('MANUAL', 1700, '01:00'),
      cumulative('AUTO_IMPORT', 2400, '02:00'),
    ];

    const measures = aggregateMeasures({
      observations,
      horizon: 'LONG',
      from: FROM,
      to: NOW,
      statusCodes: statusCodeMap(),
      expectedStreams: { robot: true, sensor: false },
      coverageSlotMinutes: 15,
    });

    expect(judge(observations)[0]?.used).toBe(false);
    // 手動の 1,700 を使うと、4,200（0 → 1,800 → 1,700〔リセット〕→ 2,400）になる
    expect(measures.values.harvestCount).toBe(2400);
  });
});

describe('手動入力が評価に使われるかの判定（評価のすべての期間: 短期 24 時間・長期 当日〜90 日）', () => {
  it('評価の期間は、短期（24 時間）と、長期の各期間（当日・7・30・60・90 日）', () => {
    const periods = evaluationPeriods(NOW);

    expect(periods.map(({ horizon, periodDays }) => [horizon, periodDays])).toEqual([
      ['SHORT', null],
      ['LONG', 1],
      ['LONG', 7],
      ['LONG', 30],
      ['LONG', 60],
      ['LONG', 90],
    ]);
    expect(periods.every(({ to }) => to.getTime() === NOW.getTime())).toBe(true);
    expect(periods[0]?.from.getTime()).toBe(NOW.getTime() - DAY_MS);
    expect(periods[2]?.from.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it('期間によって、手動入力が使われるかが違う（24 時間は自動なし→手動、7 日は自動あり→自動）', () => {
    const manual = cumulative('MANUAL', 450, '02:00');
    // 自動は 3 日前（短期・当日の外、7 日以上の中）
    const auto = cumulative('AUTO_IMPORT', 1500, '06:00', { observedAt: at('06:00', '06') });

    const [result, ...rest] = judgeManualUsageInEvaluationPeriods([auto, manual], NOW);

    expect(rest).toEqual([]);
    expect(result?.observation).toEqual(manual);
    expect(
      result?.periods.map(({ horizon, periodDays, used, reason }) => [
        horizon,
        periodDays,
        used,
        reason,
      ]),
    ).toEqual([
      ['SHORT', null, true, 'USED'],
      ['LONG', 1, true, 'USED'],
      ['LONG', 7, false, 'AUTO_PRIORITY'],
      ['LONG', 30, false, 'AUTO_PRIORITY'],
      ['LONG', 60, false, 'AUTO_PRIORITY'],
      ['LONG', 90, false, 'AUTO_PRIORITY'],
    ]);
    // どれかの期間で使われる
    expect(result?.usedInAnyPeriod).toBe(true);
  });

  it('どの期間でも使われないとき（自動が、すべての期間にある）は、usedInAnyPeriod が false', () => {
    const manual = cumulative('MANUAL', 450, '02:00');
    const auto = cumulative('AUTO_IMPORT', 1500, '01:00');

    const [result] = judgeManualUsageInEvaluationPeriods([auto, manual], NOW);

    expect(result?.usedInAnyPeriod).toBe(false);
    expect(result?.periods.every(({ reason }) => reason === 'AUTO_PRIORITY')).toBe(true);
  });

  it('期間の外の期間では、期間の外（OUT_OF_PERIOD）。手動入力が 3 日前なら、短期・当日では使われない', () => {
    const manual = cumulative('MANUAL', 450, '02:00', { observedAt: at('02:00', '06') });

    const [result] = judgeManualUsageInEvaluationPeriods([manual], NOW);

    expect(result?.periods.map(({ reason }) => reason)).toEqual([
      'OUT_OF_PERIOD',
      'OUT_OF_PERIOD',
      'USED',
      'USED',
      'USED',
      'USED',
    ]);
    expect(result?.usedInAnyPeriod).toBe(true);
  });
});
