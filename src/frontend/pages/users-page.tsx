/**
 * SC-14 ユーザー管理（UC-14。FR-9.4）。ユーザーの一覧（最終ログイン日時を含む）・登録・編集・削除（確認を求める）。
 * ユーザーIDは一意（重複はエラー）。パスワードは、8文字以上で英大文字・英小文字・数字を含む（変更する場合のみ入力）。
 * ユーザーを管理する権限（user:manage）が必要。ログイン中のユーザー自身は削除できない。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  UserCreateRequestSchema,
  UserUpdateRequestSchema,
  type PublicUser,
  type UserListResponse,
} from '@smart-farm/shared/schemas/auth';
import { createUser, deleteUser, listUsers, updateUser } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { ConfirmDialog, Field, FormError, PermissionNotice } from '../components/form-controls.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';

const TEXT = MESSAGES.users;

interface UserFormProps {
  readonly roles: UserListResponse['roles'];
  /** 編集するユーザー。なければ、新規の登録。 */
  readonly user?: PublicUser;
  readonly onDone: (message: string) => void;
  readonly onCancel?: () => void;
}

function UserForm(props: UserFormProps): ReactNode {
  const { user } = props;
  const { api } = useAuth();
  const submit = useSubmit();
  const [userId, setUserId] = useState(user?.userId ?? '');
  const [userName, setUserName] = useState(user?.userName ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(user?.role ?? props.roles[0]?.roleId ?? '');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (user === undefined) {
      const parsed = UserCreateRequestSchema.safeParse({ userId, userName, password, role });
      if (!parsed.success) {
        setClientErrors(fieldErrorsOfZod(parsed.error));
        return;
      }
      setClientErrors({});
      const result = await submit.run(() => createUser(api, parsed.data));
      if (result.ok) {
        setUserId('');
        setUserName('');
        setPassword('');
        props.onDone(TEXT.created);
      }
      return;
    }
    const parsed = UserUpdateRequestSchema.safeParse({
      userName,
      role,
      ...(password === '' ? {} : { password }),
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => updateUser(api, user.userId, parsed.data));
    if (result.ok) {
      props.onDone(TEXT.updated);
    }
  }

  const title = user === undefined ? TEXT.add : `${user.userName}を${MESSAGES.form.edit}`;
  return (
    <form
      className="inline-form"
      noValidate
      aria-label={title}
      data-testid={user === undefined ? 'user-add' : 'user-edit'}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3>{title}</h3>
      <div className="form-grid">
        {user === undefined ? (
          <Field label={TEXT.userId} name="userId" error={errors.userId} required>
            {(control) => (
              <input
                {...control}
                autoComplete="off"
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        <Field label={TEXT.userName} name="userName" error={errors.userName} required>
          {(control) => (
            <input
              {...control}
              value={userName}
              onChange={(event) => {
                setUserName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={TEXT.password}
          name="password"
          error={errors.password}
          hint={user === undefined ? TEXT.passwordHint : TEXT.passwordEditHint}
          required={user === undefined}
        >
          {(control) => (
            <input
              {...control}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.role} name="role" error={errors.role} required>
          {(control) => (
            <select
              {...control}
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
              }}
            >
              <option value="">{TEXT.selectRole}</option>
              {props.roles.map((option) => (
                <option key={option.roleId} value={option.roleId}>
                  {option.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {user === undefined ? TEXT.addSubmit : MESSAGES.form.save}
        </button>
        {props.onCancel === undefined ? null : (
          <button type="button" className="button-secondary" onClick={props.onCancel}>
            {MESSAGES.form.cancel}
          </button>
        )}
      </div>
    </form>
  );
}

export function UsersPage(): ReactNode {
  const { api, user: me } = useAuth();
  const canManage = usePermission('user:manage');
  const submit = useSubmit();
  const fetchList = useCallback(
    async () => (canManage ? listUsers(api) : undefined),
    [api, canManage],
  );
  const { data, error, reload } = usePolling(fetchList);
  const [editing, setEditing] = useState<PublicUser | undefined>(undefined);
  const [deleting, setDeleting] = useState<PublicUser | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  function done(message: string): void {
    setEditing(undefined);
    setNotice(message);
    reload();
  }

  async function confirmDelete(target: PublicUser): Promise<void> {
    const result = await submit.run(() => deleteUser(api, target.userId));
    setDeleting(undefined);
    if (result.ok) {
      done(TEXT.deleted);
    }
  }

  const roleNames = new Map(data?.roles.map((option) => [option.roleId, option.name]));

  let body: ReactNode;
  if (!canManage) {
    body = <PermissionNotice message={TEXT.forbidden} />;
  } else if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else {
    body = (
      <div className="table-scroll">
        <table className="data-table user-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.userId}</th>
              <th scope="col">{TEXT.userName}</th>
              <th scope="col">{TEXT.role}</th>
              <th scope="col">{TEXT.lastLogin}</th>
              <th scope="col">{TEXT.actions}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.userId} data-testid="user-row" data-user-id={item.userId}>
                <td>
                  {item.userId}
                  {item.userId === me?.userId ? (
                    <span className="muted category-note">{TEXT.self}</span>
                  ) : null}
                </td>
                <td>{item.userName}</td>
                <td>{roleNames.get(item.role) ?? item.role}</td>
                <td>
                  {item.lastLoginAt === undefined
                    ? TEXT.never
                    : formatDateTimeJst(item.lastLoginAt)}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => {
                        setNotice(undefined);
                        setEditing(item);
                      }}
                    >
                      {MESSAGES.form.edit}
                    </button>
                    <button
                      type="button"
                      className="button-danger-outline"
                      disabled={item.userId === me?.userId}
                      onClick={() => {
                        setNotice(undefined);
                        setDeleting(item);
                      }}
                    >
                      {MESSAGES.form.delete}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="users-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      {notice === undefined ? null : (
        <p role="status" className="form-success" data-testid="users-notice">
          {notice}
        </p>
      )}
      <FormError message={submit.formMessage} />
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
      {canManage && data !== undefined && editing !== undefined ? (
        <section className="panel">
          <UserForm
            key={editing.userId}
            user={editing}
            roles={data.roles}
            onDone={done}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </section>
      ) : null}
      {canManage && data !== undefined ? (
        <section className="panel">
          <UserForm roles={data.roles} onDone={done} />
        </section>
      ) : null}
      {deleting === undefined ? null : (
        <ConfirmDialog
          title={TEXT.deleteTitle}
          message={TEXT.deleteMessage}
          confirmLabel={MESSAGES.form.delete}
          busy={submit.busy}
          onConfirm={() => {
            void confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}
