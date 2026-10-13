/** 観点の詳細・推移・満足度・元データの画面のテスト用の応答データ（合成データ）。 */

import { toEquipmentId } from '../../src/shared/schemas/common.ts';
import type {
  HorizonDiagnosis,
  SeriesResponse,
  ViewpointDetailResponse,
} from '../../src/shared/schemas/evaluation.ts';
import type { ObservationListResponse } from '../../src/shared/schemas/observation.ts';
import { getDefaultCriteria } from '../../src/backend/domain/evaluation/default-criteria.ts';

const HOUSE = toEquipmentId('HOUSE-01');

export function diagnosis(overrides: Partial<HorizonDiagnosis> = {}): HorizonDiagnosis {
  return {
    horizon: 'LONG',
    periodDays: 7,
    status: 'CAUTION',
    diagnosticMessage: '環境適応性: 注意。温度 27.0℃（注意）、湿度 60.0%（正常）',
    recommendedAction: '確認が望ましい状態です。ハウスの環境を現場で確認し、調整してください',
    statusDetail: null,
    isCustomCriteria: false,
    criteriaVersion: 'DEFAULT',
    evaluatedFrom: '2026-10-02T03:00:00.000Z',
    evaluatedTo: '2026-10-09T03:00:00.000Z',
    evaluatedAt: '2026-10-09T03:00:00.000Z',
    ...overrides,
  };
}

export function detail(overrides: Partial<ViewpointDetailResponse> = {}): ViewpointDetailResponse {
  const long = diagnosis();
  const short = diagnosis({
    horizon: 'SHORT',
    periodDays: null,
    status: 'NORMAL',
    diagnosticMessage: '環境適応性: 正常。温度 20.0℃（正常）',
    recommendedAction: '現在の状態を維持し、引き続き推移を確認してください',
    evaluatedFrom: '2026-10-08T03:00:00.000Z',
  });
  return {
    equipmentId: HOUSE,
    viewpointId: 'environmentalAdaptability',
    name: '環境適応性',
    horizon: 'LONG',
    periodDays: 7,
    horizonUsed: 'LONG',
    hasShortHorizon: true,
    status: 'CAUTION',
    isEvaluated: true,
    short,
    long,
    selected: long,
    metrics: [
      { metricId: 'temperatureCelsius', value: 27, indicatorStatus: 'CAUTION', isPrimary: true },
      { metricId: 'humidityPercent', value: 60, indicatorStatus: 'NORMAL', isPrimary: true },
      { metricId: 'illuminanceLux', value: null, indicatorStatus: 'UNKNOWN', isPrimary: true },
      { metricId: 'co2Ppm', value: 900, indicatorStatus: null, isPrimary: false },
    ],
    criteria: getDefaultCriteria('environmentalAdaptability'),
    usesStatusIndicator: false,
    radar: null,
    ...overrides,
  };
}

/** ステータスコードで判定する観点（収穫速度）の詳細。 */
export function speedDetail(
  overrides: Partial<ViewpointDetailResponse> = {},
): ViewpointDetailResponse {
  const statusDetail = { code: 'HARVESTING', name: '収穫中', category: 'NORMAL' as const };
  const long = diagnosis({ status: 'NORMAL', statusDetail, isCustomCriteria: true });
  return detail({
    viewpointId: 'harvestSpeed',
    name: '収穫速度',
    status: 'NORMAL',
    short: null,
    long,
    selected: long,
    metrics: [
      { metricId: 'averageSecondsPerFruit', value: 36, indicatorStatus: 'NORMAL', isPrimary: true },
    ],
    criteria: { ...getDefaultCriteria('harvestSpeed'), version: 'V2', isDefault: false },
    usesStatusIndicator: true,
    ...overrides,
  });
}

export function satisfactionDetail(
  scores: readonly (number | null)[],
  overrides: Partial<ViewpointDetailResponse> = {},
): ViewpointDetailResponse {
  const names = [
    ['harvestAccuracy', '収穫精度'],
    ['harvestSpeed', '収穫速度'],
    ['environmentalAdaptability', '環境適応性'],
    ['operability', '操作性'],
    ['maintainability', 'メンテナンス性'],
    ['costEfficiency', 'コスト効率'],
    ['safety', '安全性'],
    ['dataUtilization', 'データ活用度合い'],
    ['durability', '耐久性'],
  ] as const;
  const entered = scores.filter((score): score is number => score !== null);
  const overall =
    entered.length === 9
      ? Math.round((entered.reduce((sum, score) => sum + score, 0) / 9) * 10) / 10
      : null;
  const status =
    overall === null ? 'UNKNOWN' : overall >= 4 ? 'NORMAL' : overall >= 3 ? 'CAUTION' : 'ERROR';
  const long = diagnosis({
    status,
    diagnosticMessage: `満足度: ${status}`,
    recommendedAction: '満足度の低い観点について、農作業者から所感を聞き取ってください',
  });
  return detail({
    viewpointId: 'satisfaction',
    name: '満足度',
    hasShortHorizon: false,
    status,
    short: null,
    long,
    selected: long,
    metrics: [
      {
        metricId: 'overallSatisfaction',
        value: overall,
        indicatorStatus: overall === null ? 'UNKNOWN' : status,
        isPrimary: true,
      },
    ],
    criteria: getDefaultCriteria('satisfaction'),
    radar: names.map(([viewpointId, name], index) => ({
      viewpointId,
      name,
      score: scores[index] ?? null,
    })),
    ...overrides,
  });
}

export function series(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  const days = ['02', '03', '04', '05', '06', '07', '08'];
  return {
    equipmentId: HOUSE,
    viewpointId: 'environmentalAdaptability',
    horizon: 'LONG',
    horizonUsed: 'LONG',
    periodDays: 7,
    hasShortHorizon: true,
    bucket: 'DAY',
    from: '2026-10-02T15:00:00.000Z',
    to: '2026-10-09T03:00:00.000Z',
    metrics: [
      {
        metricId: 'temperatureCelsius',
        isPrimary: true,
        points: days.map((day, index) => ({
          at: `2026-10-${day}T15:00:00.000Z`,
          value: index === 2 ? null : 20 + index,
        })),
        average: 23.5,
      },
      {
        metricId: 'humidityPercent',
        isPrimary: true,
        points: days.map((day) => ({ at: `2026-10-${day}T15:00:00.000Z`, value: null })),
        average: null,
      },
      {
        metricId: 'co2Ppm',
        isPrimary: false,
        points: days.map((day) => ({ at: `2026-10-${day}T15:00:00.000Z`, value: 900 })),
        average: 900,
      },
    ],
    statusHistory: {
      initial: 'NORMAL',
      changes: [{ changedAt: '2026-10-06T03:00:00.000Z', status: 'CAUTION' }],
    },
    feedback: {
      short: diagnosis({ horizon: 'SHORT', periodDays: null, status: 'NORMAL' }),
      long: diagnosis(),
    },
    ...overrides,
  };
}

export function observationList(
  overrides: Partial<ObservationListResponse> = {},
): ObservationListResponse {
  const base = {
    category: 'ENVIRONMENT' as const,
    source: 'AUTO_IMPORT' as const,
    quality: 'VALID' as const,
    receivedAt: '2026-10-09T02:00:00.000Z',
    isDeleted: false,
  };
  return {
    items: [
      {
        ...base,
        equipmentId: toEquipmentId('SENSOR-01'),
        itemKey: 'temperatureCelsius',
        observedAt: '2026-10-09T02:00:00.000Z',
        value: 27.5,
      },
      {
        ...base,
        equipmentId: toEquipmentId('ROBOT-01'),
        category: 'STATUS',
        itemKey: 'statusCode',
        observedAt: '2026-10-09T01:00:00.000Z',
        value: 'HARVESTING',
      },
      {
        ...base,
        equipmentId: toEquipmentId('ROBOT-01'),
        category: 'HARVEST',
        itemKey: 'harvestCount',
        observedAt: '2026-10-09T00:00:00.000Z',
        value: null,
        quality: 'MISSING',
        source: 'MANUAL',
      },
      {
        ...base,
        equipmentId: toEquipmentId('SENSOR-01'),
        itemKey: 'illuminanceLux',
        observedAt: '2026-10-08T23:00:00.000Z',
        value: 30000,
        quality: 'LATE',
      },
      {
        ...base,
        equipmentId: toEquipmentId('GONE-01'),
        category: 'STATUS',
        itemKey: 'customUnknownItem',
        observedAt: '2026-10-08T22:00:00.000Z',
        value: 'UNDEFINED_CODE',
        quality: 'INVALID',
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

export const STATUS_CODES_RESPONSE = {
  items: [
    { code: 'HARVESTING', name: '収穫中', category: 'NORMAL', isDeleted: false },
    { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR', isDeleted: false },
  ],
};
