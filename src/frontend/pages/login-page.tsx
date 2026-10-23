/** SC-01 ログイン（FR-9.1, UC-13）。失敗時は、原因を特定できないメッセージを表示する。 */

import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { LoginRequestSchema } from '@smart-farm/shared/schemas/auth';
import { ApiError } from '../api/client.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { navigate, useLocation } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';

/** ログイン後に戻る場所。外部のサイトへ誘導されないよう、同じサイト内のパスだけを許す。 */
export function safeNextPath(next: string | null): string {
  return next !== null && next.startsWith('/') && !next.startsWith('//') ? next : PATHS.dashboard;
}

/** 未認証のアクセスを、ログイン画面へ誘導する URL（元のパスとクエリを、戻り先（next）に持つ）。 */
export function loginRedirectPath(pathname: string, search: URLSearchParams): string {
  const query = search.size > 0 ? `?${search.toString()}` : '';
  return `${PATHS.login}?next=${encodeURIComponent(`${pathname}${query}`)}`;
}

export function LoginPage(): ReactNode {
  const { login } = useAuth();
  const { search } = useLocation();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    const parsed = LoginRequestSchema.safeParse({ userId, password });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errors[String(issue.path[0])] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);
    try {
      await login(parsed.data.userId, parsed.data.password);
      navigate(safeNextPath(search.get('next')), { replace: true });
    } catch (error) {
      // 認証の失敗は、ユーザーIDの存在を推測させないよう、同じメッセージを表示する
      setFormError(
        error instanceof ApiError && error.code === 'UNAUTHENTICATED'
          ? MESSAGES.login.failed
          : error instanceof ApiError
            ? error.message
            : MESSAGES.common.unexpectedError,
      );
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <h1>{MESSAGES.appName}</h1>
      <form
        className="login-form"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <h2>{MESSAGES.login.title}</h2>
        {formError === undefined ? null : (
          <p role="alert" className="form-error">
            <Icon name="status-error" size={16} />
            {formError}
          </p>
        )}
        <label>
          <span>{MESSAGES.login.userId}</span>
          <input
            name="userId"
            autoComplete="username"
            value={userId}
            aria-invalid={fieldErrors.userId !== undefined}
            aria-describedby={fieldErrors.userId === undefined ? undefined : 'userId-error'}
            onChange={(event) => {
              setUserId(event.target.value);
            }}
          />
        </label>
        {fieldErrors.userId === undefined ? null : (
          <p id="userId-error" className="field-error">
            <Icon name="status-error" size={14} />
            {fieldErrors.userId}
          </p>
        )}
        <label>
          <span>{MESSAGES.login.password}</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={fieldErrors.password !== undefined}
            aria-describedby={fieldErrors.password === undefined ? undefined : 'password-error'}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
        {fieldErrors.password === undefined ? null : (
          <p id="password-error" className="field-error">
            <Icon name="status-error" size={14} />
            {fieldErrors.password}
          </p>
        )}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? MESSAGES.login.submitting : MESSAGES.login.submit}
        </button>
      </form>
    </main>
  );
}
