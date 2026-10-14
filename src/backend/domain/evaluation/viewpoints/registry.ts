/** 観点の定義の一覧。観点を追加する場合は、定義を作り、ここに追加する。 */

import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointDefinition } from '../definition.ts';
import { environmentalAdaptability } from './house-viewpoints.ts';
import { dataUtilization, satisfaction } from './operation-viewpoints.ts';
import {
  costEfficiency,
  durability,
  harvestAccuracy,
  harvestSpeed,
  maintainability,
  operability,
  safety,
} from './robot-viewpoints.ts';

const DEFINITIONS: Readonly<Record<ViewpointId, ViewpointDefinition>> = {
  harvestAccuracy,
  harvestSpeed,
  environmentalAdaptability,
  operability,
  maintainability,
  costEfficiency,
  safety,
  dataUtilization,
  durability,
  satisfaction,
};

export function getViewpointDefinition(viewpointId: ViewpointId): ViewpointDefinition {
  return DEFINITIONS[viewpointId];
}

/** 表示順（evaluation.md 1章）の観点の定義。 */
export const VIEWPOINT_DEFINITIONS: readonly ViewpointDefinition[] =
  VIEWPOINT_IDS.map(getViewpointDefinition);
