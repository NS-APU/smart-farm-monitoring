/**
 * 閲覧の割り当て（ハウスごと）のパネル（設備管理 SC-10。Issue #330。ADR-0013。FR-9.8）。ハウスの行の「閲覧の割り当て」から開き、
 * そのハウスを閲覧できる一般ユーザーを、チェックボックスで選んで、保存する（そのハウスを閲覧できる全ユーザーで、置き換える）。
 * 管理者は、すべてのハウスを閲覧できるため、選択肢に含めない。
 */

import { useState, type ReactNode } from 'react';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type {
  FacilityAccessEntry,
  FacilityAccessUser,
} from '@smart-farm/shared/schemas/facility-access';
import { setFacilityAccess } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { FormError } from '../components/form-controls.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';

const TEXT = MESSAGES.equipment.facilityAccess;

const sameUsers = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((userId) => right.includes(userId));

export interface FacilityAccessPanelProps {
  readonly facility: Equipment;
  /** 現在の割り当て（記録がなければ、割り当てなし）。 */
  readonly entry: FacilityAccessEntry | undefined;
  /** 割り当ての対象になる一般ユーザー。 */
  readonly users: readonly FacilityAccessUser[];
  readonly onSaved: (message: string) => void;
  readonly onCancel: () => void;
}

export function FacilityAccessPanel(props: FacilityAccessPanelProps): ReactNode {
  const { facility, entry, users, onSaved, onCancel } = props;
  const { api } = useAuth();
  const submit = useSubmit();
  const current = entry?.userIds ?? [];
  const [selected, setSelected] = useState<readonly string[]>(current);
  const changed = !sameUsers(current, selected);

  function toggle(userId: string): void {
    setSelected((previous) =>
      previous.includes(userId) ? previous.filter((id) => id !== userId) : [...previous, userId],
    );
  }

  async function handleSave(): Promise<void> {
    const result = await submit.run(() => setFacilityAccess(api, facility.equipmentId, selected));
    if (result.ok) {
      onSaved(TEXT.saved(facility.name));
    }
  }

  return (
    <div data-testid="facility-access" aria-labelledby="facility-access-title" role="group">
      <h2 id="facility-access-title">{TEXT.panelTitle(facility.name)}</h2>
      <p className="muted">{TEXT.lead}</p>
      {users.length === 0 ? (
        <p className="muted" data-testid="facility-access-no-users">
          {TEXT.noUsers}
        </p>
      ) : (
        <ul className="checkbox-list">
          {users.map((user) => (
            <li key={user.userId}>
              <label>
                <input
                  type="checkbox"
                  aria-label={TEXT.userLabel(user.userName)}
                  checked={selected.includes(user.userId)}
                  onChange={() => {
                    toggle(user.userId);
                  }}
                />{' '}
                {user.userName}
              </label>
            </li>
          ))}
        </ul>
      )}
      {submit.formMessage === undefined ? null : (
        <div data-testid="facility-access-error">
          <FormError message={submit.formMessage} />
        </div>
      )}
      <div className="form-actions">
        {users.length === 0 ? null : (
          <button
            type="button"
            disabled={submit.busy || !changed}
            onClick={() => {
              void handleSave();
            }}
          >
            {submit.busy ? TEXT.saving : TEXT.save}
          </button>
        )}
        <button type="button" className="button-secondary" onClick={onCancel}>
          {TEXT.close}
        </button>
      </div>
    </div>
  );
}
