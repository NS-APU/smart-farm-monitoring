import { describe, expect, it } from 'vitest';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import {
  SATISFACTION_TARGET_VIEWPOINT_IDS,
  VIEWPOINT_IDS,
  type ViewpointId,
} from '@smart-farm/shared/constants/viewpoints';
import type { StatusDetail } from '@smart-farm/shared/schemas/evaluation';
import { getDefaultCriteria } from '../../../../src/backend/domain/evaluation/default-criteria.ts';
import { evaluateHorizon } from '../../../../src/backend/domain/evaluation/engine.ts';
import {
  CUSTOM_CRITERIA_NOTE,
  UNKNOWN_ACTION,
} from '../../../../src/backend/domain/evaluation/messages.ts';
import {
  getViewpointDefinition,
  VIEWPOINT_DEFINITIONS,
} from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';

const NORMAL_STATUS: StatusDetail = { code: 'HARVESTING', name: '収穫中', category: 'NORMAL' };
const CAUTION_STATUS: StatusDetail = { code: 'STOPPED', name: '停止中', category: 'CAUTION' };
const ERROR_STATUS: StatusDetail = { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR' };

function evaluate(
  viewpointId: ViewpointId,
  values: Record<string, number>,
  status: StatusDetail | null = null,
) {
  return evaluateHorizon({
    definition: getViewpointDefinition(viewpointId),
    measures: { values, status },
    criteria: getDefaultCriteria(viewpointId),
  });
}

interface Case {
  readonly name: string;
  readonly viewpointId: ViewpointId;
  readonly values: Readonly<Record<string, number | undefined>>;
  readonly status?: StatusDetail | null;
  readonly expected: EvaluationStatus;
}

const ACCURACY_BASE = {
  harvestCount: 100,
  damagedFruitCount: 5,
  wrongHarvestCount: 5,
  missedFruitCount: 5,
};
const SPEED_BASE = { harvestOperatingHours: 1, travelStoppedHours: 0.04, harvestCount: 100 };
const OPERABILITY_BASE = { operationMinutes: 9, operationStepCount: 4, operationErrorCount: 0 };
const MAINTAINABILITY_BASE = { failureCount: 2, recoveryMinutes: 0 };
const COST_BASE = {
  harvestCount: 120,
  harvestOperatingHours: 1,
  operatingHours: 2,
  failureCount: 0,
  recoveryMinutes: 0,
  damagedFruitCount: 0,
  wrongHarvestCount: 0,
  robotCostYenPerHour: 25,
  laborCostYenPerHour: 25,
  maintenanceCostYen: 0,
  electricityCostYen: 0,
};
const SAFETY_BASE = { emergencyStopCount: 0, nearMissCount: 0, operatingHours: 100 };
const DURABILITY_BASE = { operatingHours: 1000, failureCount: 1, recoveryMinutes: 60 };
const SATISFACTION_BASE = Object.fromEntries(
  SATISFACTION_TARGET_VIEWPOINT_IDS.map((id) => [satisfactionItemKey(id), 4]),
);

const CASES: readonly Case[] = [
  // 収穫精度（可販果率・認識精度のうち悪い方）
  {
    name: '収穫精度: 可販果率が90%ちょうどなら正常',
    viewpointId: 'harvestAccuracy',
    values: ACCURACY_BASE,
    expected: 'NORMAL',
  },
  {
    name: '収穫精度: 可販果率が90%未満なら注意',
    viewpointId: 'harvestAccuracy',
    values: { ...ACCURACY_BASE, damagedFruitCount: 6 },
    expected: 'CAUTION',
  },
  {
    name: '収穫精度: 可販果率が80%ちょうどなら注意',
    viewpointId: 'harvestAccuracy',
    values: { ...ACCURACY_BASE, damagedFruitCount: 10, wrongHarvestCount: 10 },
    expected: 'CAUTION',
  },
  {
    name: '収穫精度: 可販果率が80%未満なら異常',
    viewpointId: 'harvestAccuracy',
    values: { ...ACCURACY_BASE, damagedFruitCount: 15, wrongHarvestCount: 6 },
    expected: 'ERROR',
  },
  {
    name: '収穫精度: 認識精度が悪ければ、可販果率が正常でも注意',
    viewpointId: 'harvestAccuracy',
    values: { ...ACCURACY_BASE, missedFruitCount: 20 },
    expected: 'CAUTION',
  },
  {
    name: '収穫精度: 取り残し数が未取得なら不明',
    viewpointId: 'harvestAccuracy',
    values: { harvestCount: 100, damagedFruitCount: 0, wrongHarvestCount: 0 },
    expected: 'UNKNOWN',
  },
  {
    name: '収穫精度: 収穫数が0なら不明',
    viewpointId: 'harvestAccuracy',
    values: { ...ACCURACY_BASE, harvestCount: 0 },
    expected: 'UNKNOWN',
  },
  // 収穫速度（走行停止率・平均処理時間・ステータスのうち最も悪いもの）
  {
    name: '収穫速度: すべて正常なら正常',
    viewpointId: 'harvestSpeed',
    values: SPEED_BASE,
    status: NORMAL_STATUS,
    expected: 'NORMAL',
  },
  {
    name: '収穫速度: 走行停止率が5%ちょうどなら注意',
    viewpointId: 'harvestSpeed',
    values: { ...SPEED_BASE, travelStoppedHours: 0.05 },
    status: NORMAL_STATUS,
    expected: 'CAUTION',
  },
  {
    name: '収穫速度: 走行停止率が10%以上なら異常',
    viewpointId: 'harvestSpeed',
    values: { ...SPEED_BASE, travelStoppedHours: 0.1 },
    status: NORMAL_STATUS,
    expected: 'ERROR',
  },
  {
    name: '収穫速度: 平均処理時間が60秒ちょうどなら注意',
    viewpointId: 'harvestSpeed',
    values: { ...SPEED_BASE, harvestCount: 60 },
    status: NORMAL_STATUS,
    expected: 'CAUTION',
  },
  {
    name: '収穫速度: 平均処理時間が120秒以上なら異常',
    viewpointId: 'harvestSpeed',
    values: { ...SPEED_BASE, harvestCount: 30 },
    status: NORMAL_STATUS,
    expected: 'ERROR',
  },
  {
    name: '収穫速度: ステータスが注意なら、メトリクスが正常でも注意',
    viewpointId: 'harvestSpeed',
    values: SPEED_BASE,
    status: CAUTION_STATUS,
    expected: 'CAUTION',
  },
  {
    name: '収穫速度: ステータスが異常なら、メトリクスが正常でも異常',
    viewpointId: 'harvestSpeed',
    values: SPEED_BASE,
    status: ERROR_STATUS,
    expected: 'ERROR',
  },
  {
    name: '収穫速度: ステータスが未取得なら不明',
    viewpointId: 'harvestSpeed',
    values: SPEED_BASE,
    status: null,
    expected: 'UNKNOWN',
  },
  {
    name: '収穫速度: 収穫稼働時間が0なら不明',
    viewpointId: 'harvestSpeed',
    values: { ...SPEED_BASE, harvestOperatingHours: 0 },
    status: NORMAL_STATUS,
    expected: 'UNKNOWN',
  },
  // 環境適応性（取得できた指標だけで判定）
  {
    name: '環境適応性: 4指標がすべて正常範囲なら正常',
    viewpointId: 'environmentalAdaptability',
    values: { temperatureCelsius: 20, humidityPercent: 60, illuminanceLux: 30000, co2Ppm: 900 },
    expected: 'NORMAL',
  },
  {
    name: '環境適応性: 温度1指標だけで判定する',
    viewpointId: 'environmentalAdaptability',
    values: { temperatureCelsius: 20 },
    expected: 'NORMAL',
  },
  {
    name: '環境適応性: 温度が25℃ちょうどなら注意',
    viewpointId: 'environmentalAdaptability',
    values: { temperatureCelsius: 25 },
    expected: 'CAUTION',
  },
  {
    name: '環境適応性: 湿度が90%以上なら異常',
    viewpointId: 'environmentalAdaptability',
    values: { temperatureCelsius: 20, humidityPercent: 90 },
    expected: 'ERROR',
  },
  {
    name: '環境適応性: CO2濃度が800ppm未満なら注意',
    viewpointId: 'environmentalAdaptability',
    values: { co2Ppm: 799 },
    expected: 'CAUTION',
  },
  {
    name: '環境適応性: 4指標すべて未取得なら不明',
    viewpointId: 'environmentalAdaptability',
    values: {},
    expected: 'UNKNOWN',
  },
  // 操作性
  {
    name: '操作性: すべて正常なら正常',
    viewpointId: 'operability',
    values: OPERABILITY_BASE,
    expected: 'NORMAL',
  },
  {
    name: '操作性: 操作ステップ数が0のとき、操作エラー率は0%で正常',
    viewpointId: 'operability',
    values: { operationMinutes: 0, operationStepCount: 0, operationErrorCount: 0 },
    expected: 'NORMAL',
  },
  {
    name: '操作性: 操作ステップ数が5回ちょうどなら注意',
    viewpointId: 'operability',
    values: { ...OPERABILITY_BASE, operationStepCount: 5 },
    expected: 'CAUTION',
  },
  {
    name: '操作性: 操作時間が10分ちょうどなら注意',
    viewpointId: 'operability',
    values: { ...OPERABILITY_BASE, operationMinutes: 10 },
    expected: 'CAUTION',
  },
  {
    name: '操作性: 操作エラー率が30%以上なら異常',
    viewpointId: 'operability',
    values: { operationMinutes: 1, operationStepCount: 9, operationErrorCount: 3 },
    expected: 'ERROR',
  },
  {
    name: '操作性: 操作時間が未取得なら不明',
    viewpointId: 'operability',
    values: { operationStepCount: 1, operationErrorCount: 0 },
    expected: 'UNKNOWN',
  },
  // メンテナンス性（MTTR は分から時間へ換算）
  {
    name: 'メンテナンス性: 故障回数が0ならMTTRは0で正常',
    viewpointId: 'maintainability',
    values: { failureCount: 0, recoveryMinutes: 0 },
    status: NORMAL_STATUS,
    expected: 'NORMAL',
  },
  {
    name: 'メンテナンス性: MTTRが4時間未満なら正常',
    viewpointId: 'maintainability',
    values: { ...MAINTAINABILITY_BASE, recoveryMinutes: 479 },
    status: NORMAL_STATUS,
    expected: 'NORMAL',
  },
  {
    name: 'メンテナンス性: MTTRが4時間ちょうどなら注意',
    viewpointId: 'maintainability',
    values: { ...MAINTAINABILITY_BASE, recoveryMinutes: 480 },
    status: NORMAL_STATUS,
    expected: 'CAUTION',
  },
  {
    name: 'メンテナンス性: MTTRが8時間以上なら異常',
    viewpointId: 'maintainability',
    values: { ...MAINTAINABILITY_BASE, recoveryMinutes: 960 },
    status: NORMAL_STATUS,
    expected: 'ERROR',
  },
  {
    name: 'メンテナンス性: ステータスが異常なら異常',
    viewpointId: 'maintainability',
    values: MAINTAINABILITY_BASE,
    status: ERROR_STATUS,
    expected: 'ERROR',
  },
  {
    name: 'メンテナンス性: 故障回数が未取得なら不明',
    viewpointId: 'maintainability',
    values: { recoveryMinutes: 0 },
    status: NORMAL_STATUS,
    expected: 'UNKNOWN',
  },
  // コスト効率
  {
    name: 'コスト効率: EconomicProductivityが1.2ちょうどなら正常',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, robotCostYenPerHour: 25, laborCostYenPerHour: 25 },
    expected: 'NORMAL',
  },
  {
    name: 'コスト効率: EconomicProductivityが1.0ちょうどなら注意',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, robotCostYenPerHour: 30, laborCostYenPerHour: 30 },
    expected: 'CAUTION',
  },
  {
    name: 'コスト効率: EconomicProductivityが1.0未満なら異常',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, robotCostYenPerHour: 31, laborCostYenPerHour: 30 },
    expected: 'ERROR',
  },
  {
    name: 'コスト効率: 稼働率が低ければ異常',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, failureCount: 1, recoveryMinutes: 60 },
    expected: 'ERROR',
  },
  {
    name: 'コスト効率: 稼働時間が0なら不明',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, operatingHours: 0 },
    expected: 'UNKNOWN',
  },
  {
    name: 'コスト効率: 運用コストの合計が0なら不明',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, robotCostYenPerHour: 0, laborCostYenPerHour: 0 },
    expected: 'UNKNOWN',
  },
  {
    name: 'コスト効率: 入力が1つでも未取得なら不明',
    viewpointId: 'costEfficiency',
    values: { ...COST_BASE, electricityCostYen: undefined },
    expected: 'UNKNOWN',
  },
  // 安全性
  {
    name: '安全性: 緊急停止もヒヤリハットもなければ正常',
    viewpointId: 'safety',
    values: SAFETY_BASE,
    expected: 'NORMAL',
  },
  {
    name: '安全性: 緊急停止頻度が0.01回/時間ちょうどなら注意',
    viewpointId: 'safety',
    values: { ...SAFETY_BASE, emergencyStopCount: 1 },
    expected: 'CAUTION',
  },
  {
    name: '安全性: 緊急停止頻度が0.05回/時間以上なら異常',
    viewpointId: 'safety',
    values: { ...SAFETY_BASE, emergencyStopCount: 5 },
    expected: 'ERROR',
  },
  {
    name: '安全性: ヒヤリハット頻度が0.05回/時間ちょうどなら注意',
    viewpointId: 'safety',
    values: { ...SAFETY_BASE, nearMissCount: 5 },
    expected: 'CAUTION',
  },
  {
    name: '安全性: ヒヤリハット頻度が0.20回/時間以上なら異常',
    viewpointId: 'safety',
    values: { ...SAFETY_BASE, nearMissCount: 20 },
    expected: 'ERROR',
  },
  {
    name: '安全性: 稼働時間が0なら不明',
    viewpointId: 'safety',
    values: { ...SAFETY_BASE, operatingHours: 0 },
    expected: 'UNKNOWN',
  },
  // データ活用度合い
  {
    name: 'データ活用度合い: データ連携率が90%ちょうどなら正常',
    viewpointId: 'dataUtilization',
    values: { robotDataCount: 90, sensorDataCount: 90, manualDataCount: 0, totalDataCount: 200 },
    expected: 'NORMAL',
  },
  {
    name: 'データ活用度合い: データ連携率が90%未満なら注意',
    viewpointId: 'dataUtilization',
    values: { robotDataCount: 90, sensorDataCount: 89, manualDataCount: 0, totalDataCount: 200 },
    expected: 'CAUTION',
  },
  {
    name: 'データ活用度合い: データ連携率が70%ちょうどなら注意',
    viewpointId: 'dataUtilization',
    values: { robotDataCount: 70, sensorDataCount: 70, manualDataCount: 0, totalDataCount: 200 },
    expected: 'CAUTION',
  },
  {
    name: 'データ活用度合い: データ連携率が70%未満なら異常',
    viewpointId: 'dataUtilization',
    values: { robotDataCount: 70, sensorDataCount: 69, manualDataCount: 0, totalDataCount: 200 },
    expected: 'ERROR',
  },
  {
    name: 'データ活用度合い: 全データ数が0なら不明',
    viewpointId: 'dataUtilization',
    values: { robotDataCount: 0, sensorDataCount: 0, manualDataCount: 0, totalDataCount: 0 },
    expected: 'UNKNOWN',
  },
  {
    name: 'データ活用度合い: 全データ数が未取得なら不明',
    viewpointId: 'dataUtilization',
    values: {},
    expected: 'UNKNOWN',
  },
  // 耐久性
  {
    name: '耐久性: MTBFが500時間以上・稼働率95%以上・ステータス正常なら正常',
    viewpointId: 'durability',
    values: DURABILITY_BASE,
    status: NORMAL_STATUS,
    expected: 'NORMAL',
  },
  {
    name: '耐久性: 故障回数が0ならMTBFは稼働時間（500時間ちょうどで正常）',
    viewpointId: 'durability',
    values: { operatingHours: 500, failureCount: 0, recoveryMinutes: 0 },
    status: NORMAL_STATUS,
    expected: 'NORMAL',
  },
  {
    name: '耐久性: MTBFが500時間未満なら注意',
    viewpointId: 'durability',
    values: { ...DURABILITY_BASE, operatingHours: 499 },
    status: NORMAL_STATUS,
    expected: 'CAUTION',
  },
  {
    name: '耐久性: MTBFが100時間未満なら異常',
    viewpointId: 'durability',
    values: { ...DURABILITY_BASE, operatingHours: 99 },
    status: NORMAL_STATUS,
    expected: 'ERROR',
  },
  {
    name: '耐久性: ステータスが注意なら注意',
    viewpointId: 'durability',
    values: DURABILITY_BASE,
    status: CAUTION_STATUS,
    expected: 'CAUTION',
  },
  {
    name: '耐久性: 稼働時間も故障回数も0なら稼働率を算出できず不明',
    viewpointId: 'durability',
    values: { operatingHours: 0, failureCount: 0, recoveryMinutes: 0 },
    status: NORMAL_STATUS,
    expected: 'UNKNOWN',
  },
  // 満足度（総合満足度は小数第1位に丸める）
  {
    name: '満足度: 総合満足度が4.0なら正常',
    viewpointId: 'satisfaction',
    values: SATISFACTION_BASE,
    expected: 'NORMAL',
  },
  {
    name: '満足度: 総合満足度が3.9なら注意',
    viewpointId: 'satisfaction',
    values: { ...SATISFACTION_BASE, [satisfactionItemKey('safety')]: 3 },
    expected: 'CAUTION',
  },
  {
    name: '満足度: 総合満足度が3.0ちょうどなら注意',
    viewpointId: 'satisfaction',
    values: Object.fromEntries(Object.keys(SATISFACTION_BASE).map((key) => [key, 3])),
    expected: 'CAUTION',
  },
  {
    name: '満足度: 総合満足度が3.0未満なら異常',
    viewpointId: 'satisfaction',
    values: {
      ...Object.fromEntries(Object.keys(SATISFACTION_BASE).map((key) => [key, 3])),
      [satisfactionItemKey('safety')]: 1,
    },
    expected: 'ERROR',
  },
  {
    name: '満足度: 9観点のいずれかが未入力なら不明',
    viewpointId: 'satisfaction',
    values: { ...SATISFACTION_BASE, [satisfactionItemKey('safety')]: undefined },
    expected: 'UNKNOWN',
  },
];

describe('観点ごとの評価（viewpoint/ の判断基準）', () => {
  it.each(CASES)('$name', ({ viewpointId, values, status, expected }) => {
    // 未取得を表す undefined は、キーごと取り除く（取得できていない項目は、キーを持たない）
    const present: Record<string, number> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        present[key] = value;
      }
    }

    const result = evaluate(viewpointId, present, status ?? null);

    expect(result.status).toBe(expected);
  });

  it('10観点すべてに評価の定義がある', () => {
    expect(VIEWPOINT_DEFINITIONS.map((definition) => definition.id)).toEqual([...VIEWPOINT_IDS]);
  });

  it('短期評価を持たない観点は、MTBF・稼働率・連携率・満足度に基づく4観点（暫定）', () => {
    const withoutShort = VIEWPOINT_DEFINITIONS.filter(
      (definition) => !definition.hasShortHorizon,
    ).map((definition) => definition.id);

    expect(withoutShort).toEqual([
      'costEfficiency',
      'dataUtilization',
      'durability',
      'satisfaction',
    ]);
  });
});

describe('メトリクスの算出', () => {
  it('収穫精度のメトリクスを、viewpoint/ の算出式どおりに算出する', () => {
    const result = evaluate('harvestAccuracy', {
      harvestCount: 100,
      damagedFruitCount: 4,
      wrongHarvestCount: 6,
      missedFruitCount: 25,
    });

    expect(result.metrics).toMatchObject({
      marketableFruitRatePercent: 90,
      missedFruitRatePercent: 20,
      recognitionAccuracyPercent: 80,
      damagedFruitRatePercent: 4,
    });
  });

  it('ステータスコードを判定に使わない観点は、ステータスを結果に含めない', () => {
    const accuracy = evaluate('harvestAccuracy', ACCURACY_BASE, NORMAL_STATUS);
    const unknown = evaluate('harvestAccuracy', {}, NORMAL_STATUS);

    expect(accuracy.statusDetail).toBeNull();
    expect(unknown.statusDetail).toBeNull();
  });

  it('収穫速度の平均処理時間と走行停止率を算出する', () => {
    const result = evaluate(
      'harvestSpeed',
      { harvestOperatingHours: 2, travelStoppedHours: 0.1, harvestCount: 120 },
      NORMAL_STATUS,
    );

    expect(result.metrics).toMatchObject({
      averageSecondsPerFruit: 60,
      travelStoppedRatePercent: 5,
    });
    expect(result.statusDetail).toEqual(NORMAL_STATUS);
  });

  it('コスト効率のMTBF・MTTR・稼働率・運用コストを算出する', () => {
    const result = evaluate('costEfficiency', {
      ...COST_BASE,
      failureCount: 2,
      recoveryMinutes: 240,
      operatingHours: 10,
      maintenanceCostYen: 100,
      electricityCostYen: 50,
    });

    expect(result.metrics).toMatchObject({
      mtbfHours: 5,
      mttrHours: 2,
      availabilityPercent: 71.428571,
      operatingCostYen: 650,
      harvestRatePerHour: 120,
    });
  });

  it('満足度の総合は、9観点の平均を小数第1位に丸める', () => {
    const values = {
      ...SATISFACTION_BASE,
      [satisfactionItemKey('safety')]: 5,
      [satisfactionItemKey('durability')]: 3,
    };

    const result = evaluate('satisfaction', values);

    expect(result.metrics.overallSatisfaction).toBe(4);
    expect(result.metrics[satisfactionItemKey('safety')]).toBe(5);
  });

  it('未取得の項目から作るメトリクスは、0 ではなく null にする', () => {
    const result = evaluate('safety', { emergencyStopCount: 1 });

    expect(result.metrics.emergencyStopPerHour).toBeNull();
    expect(result.metrics.emergencyStopCount).toBe(1);
  });
});

describe('診断メッセージと推奨アクション', () => {
  it('不明のときは、データ不足の旨・未取得の項目・取得または入力を確認する推奨アクションを示す', () => {
    const result = evaluate('safety', { emergencyStopCount: 1 });

    expect(result.status).toBe('UNKNOWN');
    expect(result.diagnosticMessage).toContain('データ不足のため評価できません');
    expect(result.diagnosticMessage).toContain('ヒヤリハット件数');
    expect(result.recommendedAction).toBe(UNKNOWN_ACTION);
  });

  it('不明の理由が算出不能（分母が0）のときは、その指標名を示す', () => {
    const result = evaluate('safety', { ...SAFETY_BASE, operatingHours: 0 });

    expect(result.diagnosticMessage).toContain('算出できない指標');
    expect(result.diagnosticMessage).toContain('緊急停止頻度');
  });

  it('正常のときも、診断メッセージと推奨アクションを付ける', () => {
    const result = evaluate('safety', SAFETY_BASE);

    expect(result.diagnosticMessage).toContain('安全性: 正常');
    expect(result.diagnosticMessage).toContain('緊急停止頻度 0.000回/時間（正常）');
    expect(result.recommendedAction).toContain('維持');
  });

  it('注意・異常のときは、観点ごとの推奨アクションを付ける', () => {
    const caution = evaluate('safety', { ...SAFETY_BASE, emergencyStopCount: 1 });
    const error = evaluate('safety', { ...SAFETY_BASE, emergencyStopCount: 5 });

    expect(caution.recommendedAction).toContain('確認が望ましい');
    expect(error.recommendedAction).toContain('対応が必要');
    expect(error.recommendedAction).toContain('現場で安全を確認');
  });

  it('ステータスコードの判定は、カテゴリ名ではなく名称で示す', () => {
    const result = evaluate(
      'maintainability',
      { failureCount: 0, recoveryMinutes: 0 },
      CAUTION_STATUS,
    );

    expect(result.diagnosticMessage).toContain('ステータス 停止中（注意）');
  });

  it('変更した判断基準による判定には、その旨を示す', () => {
    const custom = { ...getDefaultCriteria('safety'), isDefault: false, version: 'v2' };

    const result = evaluateHorizon({
      definition: getViewpointDefinition('safety'),
      measures: { values: SAFETY_BASE, status: null },
      criteria: custom,
    });

    expect(result.diagnosticMessage).toContain(CUSTOM_CRITERIA_NOTE);
  });

  it('不明の判定でも、変更した判断基準による判定である旨を示す', () => {
    const custom = { ...getDefaultCriteria('safety'), isDefault: false, version: 'v2' };

    const result = evaluateHorizon({
      definition: getViewpointDefinition('safety'),
      measures: { values: {}, status: null },
      criteria: custom,
    });

    expect(result.diagnosticMessage).toContain(CUSTOM_CRITERIA_NOTE);
  });

  it('判断基準に指標の条件がなければ、判断基準が未設定として不明にする', () => {
    const criteria = { ...getDefaultCriteria('safety'), criteria: [] };

    const result = evaluateHorizon({
      definition: getViewpointDefinition('safety'),
      measures: { values: SAFETY_BASE, status: null },
      criteria,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.diagnosticMessage).toContain('判断基準が未設定');
  });

  it('判断基準の閾値を変更すると、判定が変わる', () => {
    const base = getDefaultCriteria('safety');
    const stricter = {
      ...base,
      isDefault: false,
      criteria: base.criteria.map((criterion) =>
        criterion.indicator === 'emergencyStopPerHour' && criterion.kind === 'UPPER'
          ? { ...criterion, thresholds: { cautionFrom: 0.001, errorFrom: 0.002 } }
          : criterion,
      ),
    };

    const result = evaluateHorizon({
      definition: getViewpointDefinition('safety'),
      measures: { values: { ...SAFETY_BASE, emergencyStopCount: 1 }, status: null },
      criteria: stricter,
    });

    expect(result.status).toBe('ERROR');
  });
});
