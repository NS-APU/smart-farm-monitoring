/**
 * 閲覧の割り当て（ハウスごと）の表（SC-14。Issue #330。ADR-0013。FR-9.8）。行がハウス、列が一般ユーザーで、
 * チェックボックスを付けて、変更したハウスだけを、まとめて保存する（そのハウスを閲覧できる全ユーザーで、置き換える）。
 * 管理者は、すべてのハウスを閲覧できるため、列に含めない。表の取得・保存の失敗は、この表だけに示す（ユーザーの一覧は、そのまま使える）。
 */

import { useCallback, useState, type ReactNode } from 'react';
import type { FacilityAccessEntry } from '@smart-farm/shared/schemas/facility-access';
import { getFacilityAccess, setFacilityAccess } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { Icon } from '../components/icon.tsx';
import { LoadingView } from '../components/state-views.tsx';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MANAGEMENT_MESSAGES } from '../i18n/management-messages.ts';

const TEXT = MANAGEMENT_MESSAGES.users.facilityAccess;

type Draft = Readonly<Record<string, readonly string[]>>;

const sameUsers = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((userId) => right.includes(userId));

export function FacilityAccessSection(): ReactNode {
  const { api } = useAuth();
  const submit = useSubmit();
  const fetchTable = useCallback(() => getFacilityAccess(api), [api]);
  const { data: table, error: loadError, reload } = usePolling(fetchTable);
  // 変更中のハウスだけを持つ（定期の更新で、ほかのハウスは、最新になる。変更中のものは、上書きしない）
  const [edits, setEdits] = useState<Draft>({});
  const [saved, setSaved] = useState(false);

  const usersOf = (facility: FacilityAccessEntry): readonly string[] =>
    edits[facility.facilityId] ?? facility.userIds;
  const changed = (table?.facilities ?? []).filter(
    (item) => !sameUsers(item.userIds, usersOf(item)),
  );

  function toggle(facility: FacilityAccessEntry, userId: string): void {
    setSaved(false);
    const users = usersOf(facility);
    setEdits((current) => ({
      ...current,
      [facility.facilityId]: users.includes(userId)
        ? users.filter((id) => id !== userId)
        : [...users, userId],
    }));
  }

  async function handleSave(): Promise<void> {
    setSaved(false);
    const result = await submit.run(async () => {
      for (const item of changed) {
        await setFacilityAccess(api, item.facilityId, usersOf(item));
      }
    });
    if (result.ok) {
      setEdits({});
      reload();
      setSaved(true);
    }
  }

  let body: ReactNode;
  if (table === undefined && loadError !== undefined) {
    body = (
      <p role="alert" className="form-error" data-testid="facility-access-load-error">
        <Icon name="status-error" size={16} />
        {TEXT.loadFailed}
      </p>
    );
  } else if (table === undefined) {
    body = <LoadingView />;
  } else if (table.facilities.length === 0) {
    body = (
      <p className="muted" data-testid="facility-access-no-facilities">
        {TEXT.noFacilities}
      </p>
    );
  } else if (table.users.length === 0) {
    body = (
      <p className="muted" data-testid="facility-access-no-users">
        {TEXT.noUsers}
      </p>
    );
  } else {
    body = (
      <>
        <div className="table-scroll">
          <table className="data-table facility-access-table">
            <thead>
              <tr>
                <th scope="col">{TEXT.facility}</th>
                {table.users.map((user) => (
                  <th key={user.userId} scope="col">
                    {user.userName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.facilities.map((facility) => (
                <tr
                  key={facility.facilityId}
                  data-testid="facility-access-row"
                  data-facility-id={facility.facilityId}
                >
                  <th scope="row">{facility.name}</th>
                  {table.users.map((user) => (
                    <td key={user.userId}>
                      <input
                        type="checkbox"
                        aria-label={TEXT.cellLabel(facility.name, user.userName)}
                        checked={usersOf(facility).includes(user.userId)}
                        onChange={() => {
                          toggle(facility, user.userId);
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <button
            type="button"
            disabled={submit.busy || changed.length === 0}
            onClick={() => {
              void handleSave();
            }}
          >
            {submit.busy ? TEXT.saving : TEXT.save}
          </button>
        </div>
      </>
    );
  }

  return (
    <section
      className="panel"
      data-testid="facility-access"
      aria-labelledby="facility-access-title"
    >
      <h2 id="facility-access-title">{TEXT.title}</h2>
      <p className="muted">{TEXT.lead}</p>
      {submit.formMessage === undefined ? null : (
        <p role="alert" className="form-error" data-testid="facility-access-error">
          <Icon name="status-error" size={16} />
          {submit.formMessage}
        </p>
      )}
      {saved ? (
        <p role="status" className="form-success" data-testid="facility-access-saved">
          <Icon name="status-normal" size={16} />
          {TEXT.saved}
        </p>
      ) : null}
      {body}
    </section>
  );
}
