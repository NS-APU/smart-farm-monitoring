/**
 * ハウスの結果: 配下の設備（ロボット・環境センサー）の結果のうち、最も悪いもの（D-19。FR-5.3、evaluation.md 1 章）。純粋関数。
 * 観点・視点（短期・長期）・期間ごとに、配下の設備の結果から、「不明」を除いた最も悪い判定を採る（悪い順は 異常 → 注意 → 正常。
 * 同じ悪さの設備が複数あるときは、登録順で先頭）。すべて「不明」なら「不明」。メトリクス・推奨アクションは、採った設備の結果から採る。
 * どの設備が悪いかを、診断メッセージの先頭に示す（設備が複数のときだけ。1 つだけなら、その設備の結果と同じにする）。
 */

import {
  STATUS_SEVERITY,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';

/** 配下の設備 1 つの、名称と、保存済みの評価結果。 */
export interface MemberResults {
  readonly equipmentName: string;
  readonly results: readonly EvaluationResult[];
}

export interface AggregateWorstInput {
  /** 結果を保存するハウス。 */
  readonly equipmentId: EquipmentId;
  /** 配下の設備（登録順）。 */
  readonly members: readonly MemberResults[];
  readonly evaluatedAt: Date;
}

interface Candidate {
  readonly equipmentName: string;
  readonly result: EvaluationResult;
}

/** 診断メッセージの先頭に付ける、悪い設備の示し方。 */
function withEquipmentName(equipmentName: string, message: string): string {
  return `（${equipmentName}）${message}`;
}

function groupKey(viewpointId: ViewpointId, horizon: Horizon, periodDays: PeriodDays | null) {
  return `${viewpointId}|${horizon}|${String(periodDays)}`;
}

function pickWorst(candidates: readonly Candidate[]): Candidate | undefined {
  let worst: Candidate | undefined;
  let worstSeverity = 0;
  for (const candidate of candidates) {
    const { status } = candidate.result;
    // 「不明」は除く。同じ悪さのときは、先に現れた（登録順で先頭の）設備を残す
    if (status !== 'UNKNOWN' && STATUS_SEVERITY[status] > worstSeverity) {
      worst = candidate;
      worstSeverity = STATUS_SEVERITY[status];
    }
  }
  return worst;
}

/** 配下の設備の結果から、ハウスの結果（観点・視点・期間ごと）を求める。設備に結果がない観点は、含めない。 */
export function aggregateWorstResults(input: AggregateWorstInput): EvaluationResult[] {
  const groups = new Map<string, Candidate[]>();
  for (const member of input.members) {
    for (const result of member.results) {
      const key = groupKey(result.viewpointId, result.horizon, result.periodDays);
      const candidate = { equipmentName: member.equipmentName, result };
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [candidate]);
      } else {
        group.push(candidate);
      }
    }
  }

  const aggregated: EvaluationResult[] = [];
  for (const candidates of groups.values()) {
    const worst = pickWorst(candidates);
    // すべて「不明」なら、先頭の設備の結果（「不明」の理由）。悪い設備がないため、設備名は付けない
    const chosen = worst ?? candidates[0];
    if (chosen === undefined) {
      continue;
    }
    const showName = worst !== undefined && candidates.length > 1;
    aggregated.push({
      ...chosen.result,
      equipmentId: input.equipmentId,
      diagnosticMessage: showName
        ? withEquipmentName(chosen.equipmentName, chosen.result.diagnosticMessage)
        : chosen.result.diagnosticMessage,
      evaluatedAt: input.evaluatedAt.toISOString(),
    });
  }
  return aggregated;
}
