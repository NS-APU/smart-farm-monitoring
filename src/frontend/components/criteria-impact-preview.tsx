/**
 * 判断基準の影響の確認（SC-13-2。Issue #165。ADR-0017 の D-24）。「影響を確認」ボタン（自動では実行しない）と、結果。
 * 結果は、入力途中の閾値を、保存済みの評価結果に当てた再判定（保存しない）。状態が変わる設備だけを、「現在」と「変更後」で一覧にし、
 * 未評価の設備と、「不明」の設備（閾値を変えても「不明」のまま）は、区別して示す。保存済みの結果に対する影響であることを、結果の近くに明記する。
 */

import type { ReactNode } from 'react';
import type { CriteriaPreviewResponse } from '@smart-farm/shared/schemas/criteria';
import { MESSAGES } from '../i18n/messages.ts';
import { equipmentOptionLabel } from './equipment-options.ts';
import { formatDateTimeJst } from './format.ts';
import { HelpHint } from './help-hint.tsx';
import { ResultNotice } from './result-notice.tsx';
import { StatusBadge } from './status-badge.tsx';

const TEXT = MESSAGES.criteria.preview;

function noticeMessage(result: CriteriaPreviewResponse): string {
  if (result.targetCount === 0) {
    return TEXT.noTarget;
  }
  return result.changes.length === 0 ? TEXT.noChange : TEXT.changed(result.changes.length);
}

export function CriteriaImpactPreview(props: {
  readonly busy: boolean;
  readonly result: CriteriaPreviewResponse | undefined;
  readonly onPreview: () => void;
}): ReactNode {
  const { result } = props;
  return (
    <section className="criteria-preview" aria-labelledby="criteria-preview-heading">
      <h2 id="criteria-preview-heading">
        {TEXT.title}
        <HelpHint name={TEXT.title} help={TEXT.help} />
      </h2>
      <p className="muted">{TEXT.lead}</p>
      <button
        type="button"
        className="button-secondary"
        disabled={props.busy}
        onClick={props.onPreview}
      >
        {props.busy ? TEXT.busy : TEXT.button}
      </button>
      {result === undefined ? null : (
        <div data-testid="criteria-preview">
          <ResultNotice message={noticeMessage(result)} testId="criteria-preview-notice" />
          {result.changes.length === 0 ? null : (
            <div className="table-scroll">
              <table
                className="data-table card-table criteria-preview-table"
                data-testid="criteria-preview-table"
              >
                <thead>
                  <tr>
                    <th scope="col">{TEXT.equipment}</th>
                    <th scope="col">{TEXT.current}</th>
                    <th scope="col">{TEXT.after}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.changes.map((change) => (
                    <tr
                      key={change.equipmentId}
                      data-testid={`criteria-preview-row-${change.equipmentId}`}
                    >
                      <th scope="row">
                        {equipmentOptionLabel({ ...change, name: change.equipmentName })}
                      </th>
                      <td data-label={TEXT.current}>
                        <StatusBadge status={change.current} />
                      </td>
                      <td data-label={TEXT.after}>
                        <StatusBadge status={change.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.unevaluated.length === 0 ? null : (
            <p className="muted" data-testid="criteria-preview-unevaluated">
              {TEXT.unevaluated}:{' '}
              {result.unevaluated
                .map((item) => equipmentOptionLabel({ ...item, name: item.equipmentName }).trim())
                .join('、')}
            </p>
          )}
          {result.unknownCount === 0 ? null : (
            <p className="muted" data-testid="criteria-preview-unknown">
              {TEXT.unknown(result.unknownCount)}
            </p>
          )}
          <p className="muted" data-testid="criteria-preview-basis">
            {TEXT.basis(
              result.evaluatedAt === null ? undefined : formatDateTimeJst(result.evaluatedAt),
            )}
          </p>
        </div>
      )}
    </section>
  );
}
