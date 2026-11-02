/**
 * 評価の観点（10観点）。表示順は evaluation.md 1章、識別子は data-dictionary.md 8.1 に従う。
 * 観点ごとのメトリクス・判断基準の本体は backend のドメイン層（docs/10_design/viewpoint/）。
 */

import { DEFAULT_PERIOD_DAYS, type EquipmentType, type PeriodDays } from './status.ts';

export const VIEWPOINT_IDS = [
  'harvestAccuracy',
  'harvestSpeed',
  'environmentalAdaptability',
  'operability',
  'maintainability',
  'costEfficiency',
  'safety',
  'dataUtilization',
  'durability',
  'satisfaction',
] as const;
export type ViewpointId = (typeof VIEWPOINT_IDS)[number];

/** 観点の対象。評価の運用面（OPERATION）はハウス単位で評価する（暫定。FR-5.3）。 */
export type ViewpointTarget = 'ROBOT' | 'HOUSE' | 'OPERATION';

export interface ViewpointMeta {
  readonly id: ViewpointId;
  readonly name: string;
  readonly target: ViewpointTarget;
}

/** 表示順に並べている。 */
export const VIEWPOINTS: readonly ViewpointMeta[] = [
  { id: 'harvestAccuracy', name: '収穫精度', target: 'ROBOT' },
  { id: 'harvestSpeed', name: '収穫速度', target: 'ROBOT' },
  { id: 'environmentalAdaptability', name: '環境適応性', target: 'HOUSE' },
  { id: 'operability', name: '操作性', target: 'ROBOT' },
  { id: 'maintainability', name: 'メンテナンス性', target: 'ROBOT' },
  { id: 'costEfficiency', name: 'コスト効率', target: 'ROBOT' },
  { id: 'safety', name: '安全性', target: 'ROBOT' },
  { id: 'dataUtilization', name: 'データ活用度合い', target: 'OPERATION' },
  { id: 'durability', name: '耐久性', target: 'ROBOT' },
  { id: 'satisfaction', name: '満足度', target: 'OPERATION' },
];

const VIEWPOINT_BY_ID: ReadonlyMap<string, ViewpointMeta> = new Map(
  VIEWPOINTS.map((viewpoint) => [viewpoint.id, viewpoint]),
);

export function findViewpointMeta(viewpointId: string): ViewpointMeta | undefined {
  return VIEWPOINT_BY_ID.get(viewpointId);
}

/** 満足度の入力対象となる観点（満足度以外の9観点）。 */
export const SATISFACTION_TARGET_VIEWPOINT_IDS: readonly ViewpointId[] = VIEWPOINT_IDS.filter(
  (id) => id !== 'satisfaction',
);

/** 満足度の既定の長期の期間（日）。月に 1 回の入力が、期間におおむね 1 回入る長さ（D-18）。 */
export const SATISFACTION_DEFAULT_PERIOD_DAYS: PeriodDays = 30;

/**
 * 観点の既定の長期の期間（日）。期間を選ばないときの表示と、最終ステータス（通知・連携の基準）に使う。
 * 満足度は 30 日、ほかの観点は共通の既定（7 日）。期間を選んだときは、観点によらず、選んだ期間で評価する。
 */
export function defaultPeriodDays(viewpointId: string): PeriodDays {
  return viewpointId === 'satisfaction' ? SATISFACTION_DEFAULT_PERIOD_DAYS : DEFAULT_PERIOD_DAYS;
}

/**
 * 設備の種別ごとに表示・評価する観点（暫定。FR-5.3、dev_spec.md 4章）。
 * ハウス: 全観点、ロボット: ロボットの観点、センサー: 環境適応性のみ。
 */
export function viewpointsForEquipmentType(equipmentType: EquipmentType): readonly ViewpointMeta[] {
  switch (equipmentType) {
    case 'FACILITY':
      return VIEWPOINTS;
    case 'ROBOT':
      return VIEWPOINTS.filter((viewpoint) => viewpoint.target === 'ROBOT');
    case 'SENSOR':
      return VIEWPOINTS.filter((viewpoint) => viewpoint.id === 'environmentalAdaptability');
  }
}
