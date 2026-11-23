/**
 * 凡例（折りたたみ式。Issue #154）。ボタンで開閉し（aria-expanded・aria-controls）、はじめは閉じている。
 * - 状態の凡例（`StatusLegend`）: ダッシュボードに置く。正常・注意・異常・不明の意味（evaluation.md 2 章）
 * - データの状態の凡例（`QualityLegend`）: 計測データ（SC-09）に置く。有効・欠損・遅延・不正の意味と、評価での扱い（ADR-0016 の D-10）
 * - カテゴリの凡例（`StatusCodeLegend`）: ステータスコード（SC-12）に置く。正常・注意・異常の意味と対応の目安（evaluation.md 2 章。ADR-0017 の D-23）。
 *   意味と対応の目安は、ダッシュボードの状態の凡例と同じ定義（`STATUS_MEANINGS`）から表示する（「不明」は、カテゴリにないため示さない）
 */

import { useId, useState, type ReactNode } from 'react';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_QUALITY_MEANINGS,
} from '@smart-farm/shared/constants/observation-labels';
import {
  EVALUATION_STATUSES,
  JUDGED_STATUSES,
  OBSERVATION_QUALITIES,
  STATUS_MEANINGS,
} from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';
import { StatusBadge } from './status-badge.tsx';

export function Legend(props: {
  readonly title: string;
  /** 試験・E2E 用の識別子。中身は `{testId}-body`。 */
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="legend" data-testid={props.testId}>
      <button
        type="button"
        className="button-secondary legend-toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {props.title}
      </button>
      {open ? (
        <div id={bodyId} className="legend-body" data-testid={`${props.testId}-body`}>
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

/** 状態（正常・注意・異常・不明）の凡例。 */
export function StatusLegend(): ReactNode {
  return (
    <Legend title={MESSAGES.help.statusLegendTitle} testId="status-legend">
      <dl className="legend-list">
        {EVALUATION_STATUSES.map((status) => (
          <div key={status} data-testid={`status-legend-${status}`}>
            <dt>
              <StatusBadge status={status} />
            </dt>
            <dd>{STATUS_MEANINGS[status]}</dd>
          </div>
        ))}
      </dl>
    </Legend>
  );
}

/** ステータスコードのカテゴリ（正常・注意・異常）の凡例。意味と対応の目安を示し、判定への使われ方を添える。 */
export function StatusCodeLegend(): ReactNode {
  return (
    <Legend title={MESSAGES.help.statusCodeLegendTitle} testId="status-code-legend">
      <dl className="legend-list">
        {JUDGED_STATUSES.map((status) => (
          <div key={status} data-testid={`status-code-legend-${status}`}>
            <dt>
              <StatusBadge status={status} />
            </dt>
            <dd>{STATUS_MEANINGS[status]}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">{MESSAGES.help.statusCodeLegendNote}</p>
    </Legend>
  );
}

/** データの状態（有効・欠損・遅延・不正）の凡例。評価での扱いを添える。 */
export function QualityLegend(): ReactNode {
  return (
    <Legend title={MESSAGES.help.qualityLegendTitle} testId="quality-legend">
      <dl className="legend-list">
        {OBSERVATION_QUALITIES.map((quality) => {
          const item = OBSERVATION_QUALITY_MEANINGS[quality];
          return (
            <div key={quality} data-testid={`quality-legend-${quality}`}>
              <dt>
                <span className={`quality quality-${quality.toLowerCase()}`}>
                  {OBSERVATION_QUALITY_LABELS[quality]}
                </span>
              </dt>
              <dd>
                {item.meaning}。
                <strong>
                  {item.usedInEvaluation
                    ? MESSAGES.help.usedInEvaluation
                    : MESSAGES.help.notUsedInEvaluation}
                </strong>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted">{MESSAGES.help.qualityLegendNote}</p>
    </Legend>
  );
}
