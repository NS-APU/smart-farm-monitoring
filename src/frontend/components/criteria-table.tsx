/**
 * 観点の詳細: 判断基準（FR-6.4、FR-5.7）。指標ごとに、条件名と、正常・注意・異常の区分の条件を示す。
 * 変更した判断基準は、変更済みと識別できる。編集は、判断基準の編集（SC-13）から行う。
 */

import type { ReactNode } from 'react';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { describeCriterionRows } from '@smart-farm/shared/criteria-text';
import type { ViewpointDetailResponse } from '@smart-farm/shared/schemas/evaluation';
import { STATUS_LABELS } from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

export function CriteriaTable(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  const { criteria } = detail;
  return (
    <section className="panel" aria-labelledby="criteria-heading" data-testid="criteria">
      <div className="panel-head">
        <h2 id="criteria-heading">{MESSAGES.viewpoint.criteria}</h2>
        <span
          className={`tag ${criteria.isDefault ? '' : 'tag-changed'}`}
          data-testid="criteria-state"
        >
          {criteria.isDefault
            ? MESSAGES.viewpoint.criteriaDefault
            : `${MESSAGES.viewpoint.criteriaChanged}（${MESSAGES.viewpoint.criteriaVersion}: ${criteria.version}）`}
        </span>
        <Link className="panel-link" to={PATHS.criteria(detail.viewpointId)}>
          {MESSAGES.viewpoint.editCriteria}
        </Link>
      </div>
      <div className="table-scroll">
        <table className="data-table card-table criteria-table">
          <thead>
            <tr>
              <th scope="col">{MESSAGES.viewpoint.criteriaIndicator}</th>
              <th scope="col">{MESSAGES.viewpoint.criteriaLabel}</th>
              <th scope="col">{STATUS_LABELS.NORMAL}</th>
              <th scope="col">{STATUS_LABELS.CAUTION}</th>
              <th scope="col">{STATUS_LABELS.ERROR}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.criteria.map((criterion) => {
              const rows = describeCriterionRows(criterion);
              return (
                <tr key={criterion.indicator} data-testid={`criterion-${criterion.indicator}`}>
                  <th scope="row">{getMetricMeta(criterion.indicator).label}</th>
                  <td data-label={MESSAGES.viewpoint.criteriaLabel}>{criterion.label}</td>
                  {rows.map((row) => (
                    <td
                      key={row.status}
                      data-label={STATUS_LABELS[row.status]}
                      className={`condition condition-${row.status.toLowerCase()}`}
                    >
                      {row.condition}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail.usesStatusIndicator ? (
        <p className="muted" data-testid="criteria-status-note">
          {MESSAGES.viewpoint.criteriaStatusNote}（
          <Link to={PATHS.settingsStatusCodes}>{MESSAGES.viewpoint.statusCodeSettings}</Link>）
        </p>
      ) : null}
    </section>
  );
}
