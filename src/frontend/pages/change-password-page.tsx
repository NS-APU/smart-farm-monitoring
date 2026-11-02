/**
 * パスワードの変更（SC-01。UC-13・UC-14。FR-9.4・FR-9.7。D-45）。
 * - 強制（`forced`）: 管理者が決めたパスワードで、最初にログインした利用者。新しいパスワードを決めるまで、ほかの画面へ移れない
 *   （共通のレイアウト・API 呼び出しなしの、この画面だけ）。管理者は、本人が決めたパスワードを知らない。
 * - 任意: ヘッダーから開く。現在のパスワードを入力して、自分のパスワードを変える。
 * 変更すると、ほかの端末のセッションは失効し、この端末は、新しいセッションに替わる。
 */

import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { findPasswordPolicyViolation } from '@smart-farm/shared/schemas/auth';
import { useAuth } from '../auth/auth-context.tsx';
import { Field, FormError } from '../components/form-controls.tsx';
import { HouseAndStrawberry } from '../components/illustration.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { navigate } from '../router/router.tsx';

const TEXT = MESSAGES.changePassword;

export interface ChangePasswordPageProps {
  /** 管理者が決めたパスワードの変更が済むまで、ほかの画面へ移れない（変更が必要な利用者）。 */
  readonly forced?: boolean;
}

function validate(
  current: string,
  next: string,
  confirm: string,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (current === '') {
    errors.currentPassword = TEXT.currentRequired;
  }
  if (next === '') {
    errors.newPassword = TEXT.newRequired;
  } else {
    const violation = findPasswordPolicyViolation(next);
    if (violation !== null) {
      errors.newPassword = violation;
    } else if (next === current) {
      errors.newPassword = TEXT.sameAsCurrent;
    }
  }
  if (confirm !== next && errors.newPassword === undefined) {
    errors.confirmPassword = TEXT.confirmMismatch;
  }
  return errors;
}

export function ChangePasswordPage(props: ChangePasswordPageProps): ReactNode {
  const forced = props.forced === true;
  const { changePassword, logout } = useAuth();
  const submit = useSubmit();
  const headingId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const found = validate(current, next, confirm);
    setClientErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    const result = await submit.run(() => changePassword(current, next));
    if (result.ok && !forced) {
      // 変更が必要な利用者は、変更の状態が変わると、もとの画面が表示される。任意の変更は、ダッシュボードへ戻る
      navigate(PATHS.dashboard, { replace: true });
    }
  }

  const content = (
    <section className="panel change-password" aria-labelledby={headingId}>
      <h1 id={headingId}>{TEXT.title}</h1>
      {forced ? (
        <p role="status" className="notice notice-info" data-testid="password-change-required">
          {TEXT.forcedNotice}
        </p>
      ) : (
        <p className="muted">{TEXT.lead}</p>
      )}
      <form
        className="entry-form"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <Field label={TEXT.current} name="currentPassword" error={errors.currentPassword}>
          {(control) => (
            <input
              {...control}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={TEXT.next}
          name="newPassword"
          error={errors.newPassword}
          hint={TEXT.policyHint}
        >
          {(control) => (
            <input
              {...control}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => {
                setNext(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.confirm} name="confirmPassword" error={errors.confirmPassword}>
          {(control) => (
            <input
              {...control}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
              }}
            />
          )}
        </Field>
        <FormError message={submit.formMessage} />
        <div className="form-actions">
          <button type="submit" disabled={submit.busy}>
            {submit.busy ? TEXT.submitting : TEXT.submit}
          </button>
          {forced ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                void logout();
              }}
            >
              {MESSAGES.layout.logout}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );

  if (!forced) {
    return content;
  }
  // 変更が必要な間は、共通のレイアウト（メニュー・ヘッダー）を出さない（ほかの画面へ移れない）
  return (
    <main className="login-page">
      <div className="login-brand">
        <HouseAndStrawberry />
        <p className="login-brand-name">{MESSAGES.appName}</p>
      </div>
      {content}
    </main>
  );
}
