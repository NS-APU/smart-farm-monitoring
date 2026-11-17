/**
 * 判断基準の帯（SC-13。Issue #358）。値の範囲を、正常・注意・異常の区分に色分けして、横 1 本の帯で示す。
 * 区分は、色と文字（正常・注意・異常）で示し（色だけに頼らない。NFR-7.2）、帯全体に、条件の文章（aria-label）を付ける。
 * 閾値の大小関係が成り立たないとき（入力の途中）は、帯を示さない。
 */

import type { ReactNode } from 'react';
import { STATUS_LABELS } from '@smart-farm/shared/constants/status';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import type { ThresholdSliderRange } from '@smart-farm/shared/constants/criteria-ranges';
import { criterionBands, describeCriterionRows } from '@smart-farm/shared/criteria-text';
import type { Criterion } from '@smart-farm/shared/schemas/criteria';

export interface CriterionZoneBarProps {
  /** 帯の名前（例: 現在・変更後）。 */
  readonly title: string;
  readonly criterion: Criterion;
  readonly range: ThresholdSliderRange;
  /** 試験・E2E 用の識別子。 */
  readonly testId?: string;
}

/** 区分の幅（範囲に占める割合）。範囲の外は切り捨て、幅 0 の区分は示さない。 */
function segmentsOf(criterion: Criterion, range: ThresholdSliderRange) {
  const span = range.max - range.min;
  return criterionBands(criterion)
    .map((band) => {
      const from = Math.max(band.from, range.min);
      const to = Math.min(band.to, range.max);
      return { status: band.status, width: Math.max(0, (to - from) / span) };
    })
    .filter((segment) => segment.width > 0);
}

export function CriterionZoneBar(props: CriterionZoneBarProps): ReactNode {
  const { criterion, range } = props;
  const { unit } = getMetricMeta(criterion.indicator);
  const summary = describeCriterionRows(criterion)
    .map((row) => `${STATUS_LABELS[row.status]}: ${row.condition}`)
    .join('、');
  return (
    <div className="zone-bar-block" data-testid={props.testId}>
      <p className="zone-bar-title">{props.title}</p>
      <div className="zone-bar" role="img" aria-label={`${props.title}の判断基準（${summary}）`}>
        {segmentsOf(criterion, range).map((segment, index) => (
          <span
            // 同じ区分が 2 か所に出る（範囲型の注意・異常）ため、位置を含める
            key={`${segment.status}-${String(index)}`}
            className={`zone-seg zone-${segment.status.toLowerCase()}`}
            style={{ flexGrow: segment.width }}
            aria-hidden="true"
          >
            <span className="zone-seg-label">{STATUS_LABELS[segment.status]}</span>
          </span>
        ))}
      </div>
      <p className="zone-scale" aria-hidden="true">
        <span>
          {range.min}
          {unit}
        </span>
        <span>
          {range.max}
          {unit}
        </span>
      </p>
    </div>
  );
}
