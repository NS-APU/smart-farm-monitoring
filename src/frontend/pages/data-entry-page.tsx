/**
 * SC-06 データ入力（UC-06、UC-07。FR-4.1）。機器から取れない情報や、復旧対応の結果を入力し、評価に反映する。
 * 保存すると、評価を更新し、「注意」「異常」があれば通知につなげる（サーバー側）。保存結果と、更新後の関連観点の
 * ステータスを表示する。入力の権限（manual-entry:write）がなければ、入力できない旨を示す。
 */

import { useState, type ReactNode } from 'react';
import type { ManualEntrySaveResponse } from '@smart-farm/shared/schemas/manual-entry';
import { useAppState } from '../components/app-state.tsx';
import { PermissionNotice } from '../components/form-controls.tsx';
import { LoadingView } from '../components/state-views.tsx';
import { ManualEntryForm } from '../components/manual-entry-form.tsx';
import { ManualEntryResult } from '../components/manual-entry-result.tsx';
import { usePermission } from '../hooks/use-permission.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';

const TEXT = MESSAGES.entry;

export function DataEntryPage(): ReactNode {
  const canWrite = usePermission('manual-entry:write');
  const { equipmentTree } = useAppState();
  const [result, setResult] = useState<ManualEntrySaveResponse | undefined>(undefined);

  return (
    <div className="data-entry-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
        <p className="page-meta">
          <Link to={PATHS.dataEntryList}>{TEXT.goList}</Link>
        </p>
      </div>
      <p className="muted">{TEXT.lead}</p>
      {result === undefined ? null : (
        <ManualEntryResult response={result} title={TEXT.savedTitle} />
      )}
      {!canWrite ? (
        <PermissionNotice message={MESSAGES.form.noPermission} />
      ) : equipmentTree === undefined ? (
        <LoadingView />
      ) : equipmentTree.facilities.length === 0 ? (
        <div className="notice notice-warning" role="status" data-testid="no-equipment">
          <Icon name="status-caution" size={18} />
          <p>{TEXT.noEquipment}</p>
          <p className="notice-links">
            <Link to={PATHS.settingsEquipment}>{TEXT.goEquipment}</Link>
          </p>
        </div>
      ) : (
        <section className="panel" aria-label={TEXT.title}>
          <ManualEntryForm
            onSaved={(response) => {
              setResult(response);
            }}
          />
        </section>
      )}
    </div>
  );
}
