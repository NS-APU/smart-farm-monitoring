/**
 * 自身のユーザー名の変更（SC-14 の本人用。UC-14。FR-9.7）。一般を含む、ログインしている全員が使える。
 * ユーザー ID・ロールは、表示だけで、変えられない（ロールの変更は、ユーザー管理だけ）。パスワードは、「パスワードの変更」で変える。
 */

import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useAuth } from '../auth/auth-context.tsx';
import { Field, FormError } from '../components/form-controls.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';

const TEXT = MESSAGES.profile;
const USER_NAME_MAX_LENGTH = 200;

export function ProfilePage(): ReactNode {
  const { user, updateUserName } = useAuth();
  const submit = useSubmit();
  const headingId = useId();
  const [userName, setUserName] = useState(user?.userName ?? '');
  const [clientError, setClientError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const error = clientError ?? submit.fieldErrors.userName;

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    const trimmed = userName.trim();
    const found =
      trimmed === ''
        ? TEXT.nameRequired
        : trimmed.length > USER_NAME_MAX_LENGTH
          ? TEXT.nameTooLong
          : undefined;
    setClientError(found);
    if (found !== undefined) {
      return;
    }
    const result = await submit.run(() => updateUserName(trimmed));
    if (result.ok) {
      setUserName(trimmed);
      setSaved(true);
    }
  }

  return (
    <section className="panel change-password" aria-labelledby={headingId}>
      <h1 id={headingId}>{TEXT.title}</h1>
      <p className="muted">{TEXT.lead}</p>
      <p>
        {TEXT.userId}: <span data-testid="profile-user-id">{user?.userId}</span>
      </p>
      <form
        className="entry-form"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <Field label={TEXT.userName} name="userName" error={error}>
          {(control) => (
            <input
              {...control}
              type="text"
              autoComplete="name"
              value={userName}
              onChange={(event) => {
                setUserName(event.target.value);
                setSaved(false);
              }}
            />
          )}
        </Field>
        <FormError message={submit.formMessage} />
        {saved ? (
          <p role="status" className="notice notice-success" data-testid="profile-saved">
            {TEXT.saved}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="submit" disabled={submit.busy}>
            {submit.busy ? TEXT.submitting : TEXT.submit}
          </button>
        </div>
      </form>
    </section>
  );
}
