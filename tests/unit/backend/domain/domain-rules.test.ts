import { describe, expect, it } from 'vitest';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { CriterionSchema } from '@smart-farm/shared/schemas/criteria';
import {
  getDefaultCriteria,
  DEFAULT_CRITERIA_VERSION,
} from '../../../../src/shared/constants/default-criteria.ts';
import {
  evaluateScope,
  SHORT_HORIZON_HOURS,
} from '../../../../src/backend/domain/evaluation/scope-evaluator.ts';
import { getViewpointDefinition } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';
import {
  DEFAULT_FUTURE_TOLERANCE_MINUTES,
  DEFAULT_LATE_AFTER_MINUTES,
  classifyValue,
} from '../../../../src/backend/domain/observation-quality.ts';
import {
  DEFAULT_SUPPRESSION_MINUTES,
  buildIngestionFailureDedupKey,
  buildIngestionFailureMessage,
  buildStatusChangeDedupKey,
  buildStatusChangeMessage,
  isWithinSuppression,
} from '../../../../src/backend/domain/notification-rules.ts';
import { describeRobotState } from '../../../../src/backend/domain/status-code.ts';
import { observation, observations, statusCodeMap } from '../../../support/builders.ts';

describe('判断基準の既定値', () => {
  it.each(VIEWPOINT_IDS)('%s: すべての条件が、閾値の大小関係の検証を通る', (viewpointId) => {
    const defaults = getDefaultCriteria(viewpointId);

    expect(defaults.isDefault).toBe(true);
    expect(defaults.version).toBe(DEFAULT_CRITERIA_VERSION);
    for (const criterion of defaults.criteria) {
      expect(CriterionSchema.safeParse(criterion).success).toBe(true);
    }
  });

  it.each(VIEWPOINT_IDS)('%s: 判定する指標すべてに、条件がある', (viewpointId) => {
    const definition = getViewpointDefinition(viewpointId);
    const indicators = getDefaultCriteria(viewpointId).criteria.map(
      (criterion) => criterion.indicator,
    );

    expect([...indicators].sort()).toEqual([...definition.judgedIndicators].sort());
  });

  it('既定値を書き換えても、次に取得する既定値には影響しない', () => {
    const first = getDefaultCriteria('safety');
    first.criteria.pop();

    expect(getDefaultCriteria('safety').criteria).toHaveLength(2);
  });
});

describe('評価の単位の全観点の評価', () => {
  const NOW = new Date('2026-10-09T03:00:00Z');

  function evaluate(viewpointIds: readonly (typeof VIEWPOINT_IDS)[number][]) {
    return evaluateScope({
      observations: observations(
        { temperatureCelsius: 20 },
        { observedAt: '2026-10-09T02:00:00Z' },
      ),
      now: NOW,
      viewpointIds,
      criteriaOf: getDefaultCriteria,
      statusCodes: statusCodeMap(),
      expectedStreams: { robot: true, sensor: true },
      coverageSlotMinutes: 15,
    });
  }

  it('短期評価を持つ観点は、短期1件と長期5件（当日・7・30・60・90日）を作る', () => {
    const drafts = evaluate(['environmentalAdaptability']);

    expect(drafts.map((draft) => [draft.horizon, draft.periodDays])).toEqual([
      ['SHORT', null],
      ['LONG', 1],
      ['LONG', 7],
      ['LONG', 30],
      ['LONG', 60],
      ['LONG', 90],
    ]);
  });

  it('短期評価を持たない観点は、長期のみ作る', () => {
    const drafts = evaluate(['satisfaction']);

    expect(drafts.map((draft) => draft.horizon)).toEqual(['LONG', 'LONG', 'LONG', 'LONG', 'LONG']);
  });

  it('評価の対象期間と、判断基準の版を結果に残す', () => {
    const [shortDraft, dayDraft] = evaluate(['environmentalAdaptability']);

    expect(shortDraft?.evaluatedTo).toEqual(NOW);
    expect(shortDraft?.evaluatedFrom.getTime()).toBe(
      NOW.getTime() - SHORT_HORIZON_HOURS * 3_600_000,
    );
    expect(dayDraft?.evaluatedFrom.getTime()).toBe(NOW.getTime() - 24 * 3_600_000);
    expect(shortDraft?.criteriaVersion).toBe(DEFAULT_CRITERIA_VERSION);
    expect(shortDraft?.isCustomCriteria).toBe(false);
    expect(shortDraft?.evaluation.status).toBe('NORMAL');
  });
});

describe('評価の単位の評価: 累積の項目の期間の値（D-26）', () => {
  const NOW = new Date('2026-10-09T03:00:00Z');
  const DAY = 86_400_000;
  const operating = (value: number, msBefore: number) =>
    observation({
      itemKey: 'operatingHours',
      value,
      observedAt: new Date(NOW.getTime() - msBefore).toISOString(),
    });

  function operatingByPeriod(
    observationList: ReturnType<typeof operating>[],
    baselineObservations?: ReturnType<typeof operating>[],
  ): Record<string, number | null | undefined> {
    const drafts = evaluateScope({
      observations: observationList,
      ...(baselineObservations === undefined ? {} : { baselineObservations }),
      now: NOW,
      viewpointIds: ['durability'],
      criteriaOf: getDefaultCriteria,
      statusCodes: statusCodeMap(),
      expectedStreams: { robot: true, sensor: false },
      coverageSlotMinutes: 15,
    });
    return Object.fromEntries(
      drafts.map((draft) => [String(draft.periodDays), draft.evaluation.metrics.operatingHours]),
    );
  }

  it('各期間の値は、その期間の直前の値を基準にした、増分の合計にする（期間より前の値は、基準に使う）', () => {
    const periods = operatingByPeriod([
      operating(100, 10 * DAY),
      operating(130, 3 * DAY),
      operating(150, 3_600_000),
    ]);

    // 当日: 基準は 3 日前の 130 → 20。7 日: 基準は 10 日前の 100 → 30 + 20。30・60・90 日: 基準なし（0 から）→ 100 + 30 + 20
    expect(periods).toMatchObject({ '1': 20, '7': 50, '30': 150, '60': 150, '90': 150 });
  });

  it('期間ごとに、取得元を決める（当日は自動なし→手動、7 日以上は自動あり→自動）。手動の基準は、手動の値から選ぶ', () => {
    const at = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();
    const auto = (value: number, msBefore: number) =>
      observation({ itemKey: 'operatingHours', value, observedAt: at(msBefore) });
    const manual = (value: number, msBefore: number) =>
      observation({
        itemKey: 'operatingHours',
        value,
        source: 'MANUAL',
        observedAt: at(msBefore),
      });

    const periods = operatingByPeriod([
      auto(1000, 3 * DAY + 6 * 3_600_000),
      auto(1500, 3 * DAY),
      manual(300, 2 * 3_600_000),
      manual(450, 3_600_000),
    ]);

    // 当日: 自動なし → 手動だけ（基準なし）→ 450。7・30・60・90 日: 自動あり → 自動だけ → 1,500（手動は使わない）
    expect(periods).toMatchObject({ '1': 450, '7': 1500, '30': 1500, '60': 1500, '90': 1500 });
  });

  it('読んだ範囲より前の値（baselineObservations）も、期間の基準に使う', () => {
    const periods = operatingByPeriod(
      [operating(130, 3 * DAY), operating(150, 3_600_000)],
      [operating(100, 100 * DAY)],
    );

    expect(periods).toMatchObject({ '1': 20, '7': 50, '30': 50, '60': 50, '90': 50 });
  });
});

describe('ステータスコードの状態判定', () => {
  const codes = statusCodeMap();

  it.each([
    ['RUNNING', 'RUNNING', false, false],
    ['HARVESTING', 'RUNNING', false, false],
    ['STANDBY', 'STOPPED', false, false],
    ['STOPPED', 'STOPPED', false, false],
    ['RUNNING_ERROR', 'STOPPED', false, true],
    ['FALLEN', 'STOPPED', true, true],
  ] as const)(
    '%s は、走行・停止が %s、姿勢異常が %s、故障が %s',
    (code, motion, posture, fault) => {
      const state = describeRobotState(code, codes);

      expect(state).toMatchObject({
        isDefined: true,
        motion,
        isPostureError: posture,
        isFault: fault,
      });
    },
  );

  it('定義にないコード値と、削除済みのコード値は、不正な値として区別する', () => {
    const deleted = new Map(codes);
    const running = codes.get('RUNNING');
    if (running === undefined) {
      throw new Error('テストの前提: RUNNING が定義されている');
    }
    deleted.set('RUNNING', { ...running, isDeleted: true });

    expect(describeRobotState('NOT_DEFINED', codes)).toEqual({
      isDefined: false,
      code: 'NOT_DEFINED',
    });
    expect(describeRobotState('RUNNING', deleted)).toEqual({ isDefined: false, code: 'RUNNING' });
  });
});

describe('通知の規則', () => {
  it('重複抑制のキーは、観点・対象・ステータスから作る', () => {
    expect(buildStatusChangeDedupKey('safety', 'ROBOT-1', 'ERROR')).toBe(
      'STATUS_CHANGE#safety#ROBOT-1#ERROR',
    );
    expect(buildIngestionFailureDedupKey('robot')).toBe('INGESTION_FAILURE#robot');
  });

  it('抑制の期間内は重複とみなし、期間が過ぎたら通知する', () => {
    const now = new Date('2026-10-09T03:00:00Z');

    expect(isWithinSuppression(null, now, DEFAULT_SUPPRESSION_MINUTES)).toBe(false);
    expect(isWithinSuppression(new Date('2026-10-09T02:01:00Z'), now, 60)).toBe(true);
    expect(isWithinSuppression(new Date('2026-10-09T02:00:00Z'), now, 60)).toBe(false);
  });

  it('通知には、ステータス・観点名・対象の設備・診断メッセージを含める', () => {
    const message = buildStatusChangeMessage({
      viewpointName: '安全性',
      equipmentName: '収穫ロボット1',
      status: 'ERROR',
      diagnosticMessage: '安全性: 異常。',
    });

    expect(message).toBe('【異常】安全性（収穫ロボット1）: 安全性: 異常。');
    expect(buildIngestionFailureMessage('robot', '接続できません')).toBe(
      '【データ取得失敗】robot: 接続できません',
    );
  });
});

describe('取り込んだ値の品質の判定', () => {
  const observedAt = new Date('2026-10-09T02:00:00Z');
  const context = {
    observedAt,
    receivedAt: new Date('2026-10-09T02:05:00Z'),
    lateAfterMinutes: DEFAULT_LATE_AFTER_MINUTES,
    futureToleranceMinutes: DEFAULT_FUTURE_TOLERANCE_MINUTES,
    statusCodes: statusCodeMap(),
  };

  it('範囲内の値は有効にする', () => {
    expect(classifyValue('humidityPercent', 55, context)).toEqual({ quality: 'VALID' });
    expect(classifyValue('humidityPercent', 0, context)).toEqual({ quality: 'VALID' });
    expect(classifyValue('humidityPercent', 100, context)).toEqual({ quality: 'VALID' });
    expect(classifyValue('statusCode', 'RUNNING', context)).toEqual({ quality: 'VALID' });
  });

  it('1 果実あたりの収穫時間は、データとしては 3,600 秒まで有効（手動入力の上限 300 秒より広い。#192）', () => {
    expect(classifyValue('harvestSecondsPerFruit', 301, context)).toEqual({ quality: 'VALID' });
    expect(classifyValue('harvestSecondsPerFruit', 3600, context)).toEqual({ quality: 'VALID' });
  });

  it.each([
    ['温度の下限', 'temperatureCelsius', -50],
    ['温度の上限', 'temperatureCelsius', 100],
    ['照度の下限', 'illuminanceLux', 0],
    ['照度の上限', 'illuminanceLux', 200_000],
    ['CO2 濃度の下限', 'co2Ppm', 0],
    ['CO2 濃度の上限', 'co2Ppm', 10_000],
    ['1 果実あたりの収穫時間の下限', 'harvestSecondsPerFruit', 0],
    ['1 果実あたりの収穫時間の上限', 'harvestSecondsPerFruit', 3600],
  ] as const)('範囲の境界値（%s）は有効にする（D-10）', (_name, itemKey, value) => {
    expect(classifyValue(itemKey, value, context)).toEqual({ quality: 'VALID' });
  });

  it('値がなければ欠損にする（0 で代用しない）', () => {
    expect(classifyValue('humidityPercent', null, context)).toEqual({ quality: 'MISSING' });
    expect(classifyValue('humidityPercent', undefined, context)).toEqual({ quality: 'MISSING' });
  });

  it.each([
    ['湿度が範囲外（100超）', 'humidityPercent', 100.1],
    ['湿度が範囲外（0未満）', 'humidityPercent', -0.1],
    ['整数の項目に小数', 'harvestCount', 1.5],
    ['数値の項目に文字列', 'temperatureCelsius', 'abc'],
    ['数値の項目に無限大', 'temperatureCelsius', Number.POSITIVE_INFINITY],
    ['ステータスコードに数値', 'statusCode', 5],
    ['定義にないステータスコード', 'statusCode', 'NOT_DEFINED'],
    ['温度が範囲外（−50 未満）', 'temperatureCelsius', -50.1],
    ['温度が範囲外（100 超）', 'temperatureCelsius', 100.1],
    ['照度が範囲外（0 未満）', 'illuminanceLux', -1],
    ['照度が範囲外（200,000 超）', 'illuminanceLux', 200_001],
    ['CO2 濃度が範囲外（0 未満）', 'co2Ppm', -1],
    ['CO2 濃度が範囲外（10,000 超）', 'co2Ppm', 10_001],
    ['1 果実あたりの収穫時間が範囲外（0 未満）', 'harvestSecondsPerFruit', -0.1],
    ['1 果実あたりの収穫時間が範囲外（3,600 秒超）', 'harvestSecondsPerFruit', 3600.1],
  ] as const)('%s は不正にする', (_name, itemKey, value) => {
    expect(classifyValue(itemKey, value, context).quality).toBe('INVALID');
  });

  it('カタログにない項目は不正にして、理由を返す', () => {
    expect(classifyValue('unknownItem', 1, context)).toMatchObject({
      quality: 'INVALID',
      reason: expect.stringContaining('unknownItem'),
    });
  });

  it('計測日時が受信日時より未来（時計のずれの許容を超える）なら不正にする', () => {
    const future = { ...context, observedAt: new Date('2026-10-09T02:30:00Z') };
    const slightlyFuture = { ...context, observedAt: new Date('2026-10-09T02:08:00Z') };

    expect(classifyValue('humidityPercent', 50, future)).toMatchObject({ quality: 'INVALID' });
    expect(classifyValue('humidityPercent', 50, slightlyFuture).quality).toBe('VALID');
  });

  it('未来の許容は、設定値で変えられる（既定 5 分。ちょうどは許容。D-13）', () => {
    const fiveMinutesAhead = { ...context, observedAt: new Date('2026-10-09T02:10:00Z') };
    const sixMinutesAhead = { ...context, observedAt: new Date('2026-10-09T02:11:00Z') };

    expect(classifyValue('humidityPercent', 50, fiveMinutesAhead).quality).toBe('VALID');
    expect(classifyValue('humidityPercent', 50, sixMinutesAhead).quality).toBe('INVALID');
    expect(
      classifyValue('humidityPercent', 50, { ...sixMinutesAhead, futureToleranceMinutes: 10 })
        .quality,
    ).toBe('VALID');
    expect(
      classifyValue('humidityPercent', 50, { ...fiveMinutesAhead, futureToleranceMinutes: 0 })
        .quality,
    ).toBe('INVALID');
  });

  it('受信が計測から基準の時間より遅れたら遅延にする（ちょうどは遅延ではない）', () => {
    const justOnTime = { ...context, receivedAt: new Date(observedAt.getTime() + 60 * 60_000) };
    const late = { ...context, receivedAt: new Date(observedAt.getTime() + 60 * 60_000 + 1000) };

    expect(classifyValue('humidityPercent', 50, justOnTime).quality).toBe('VALID');
    expect(classifyValue('humidityPercent', 50, late).quality).toBe('LATE');
  });

  it('観測値のテスト用の生成関数は、カタログにない項目を拒否する', () => {
    expect(() => observation({ itemKey: 'notInCatalog', value: 1 })).toThrow('カタログにない項目');
  });
});
