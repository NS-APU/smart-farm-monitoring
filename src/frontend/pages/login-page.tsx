/** SC-01 ログイン（FR-9.1, UC-13）。失敗時は、原因を特定できないメッセージを表示する。 */

import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { LoginRequestSchema } from '@smart-farm/shared/schemas/auth';
import { ApiError } from '../api/client.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { navigate, useLocation } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';
import { HouseAndStrawberry } from '../components/illustration.tsx';
import { PasswordInput } from '../components/password-input.tsx';

/**
 * ログイン後に戻る場所。外部のサイトへ誘導されないよう、同じサイト内のパスだけを許す。
 * ブラウザと同じ規則（URL の解釈）で、同じ origin かを確かめる（バックスラッシュ・タブ・改行を挟んだ `//x` など、文字列の前方一致では見抜けない値を拒否する）。
 * ログイン画面そのもの（`/login` とその下）は、戻り先にしない。許す場合は、解釈した後のパス・クエリ・ハッシュを返す。
 */
export function safeNextPath(next: string | null): string {
  if (next?.startsWith('/') !== true) {
    return PATHS.dashboard;
  }
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return PATHS.dashboard;
  }
  const isLoginPath = url.pathname === PATHS.login || url.pathname.startsWith(`${PATHS.login}/`);
  if (url.origin !== window.location.origin || isLoginPath) {
    return PATHS.dashboard;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** 未認証のアクセスを、ログイン画面へ誘導する URL（元のパスとクエリを、戻り先（next）に持つ）。 */
export function loginRedirectPath(pathname: string, search: URLSearchParams): string {
  const query = search.size > 0 ? `?${search.toString()}` : '';
  return `${PATHS.login}?next=${encodeURIComponent(`${pathname}${query}`)}`;
}

export function LoginPage(): ReactNode {
  const { user, login } = useAuth();
  const { search } = useLocation();
  const next = search.get('next');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const userIdRef = useRef<HTMLInputElement>(null);
  const passwordId = useId();

  // 開いたとき、ユーザーIDの欄で、すぐ入力できるようにする（開いたときの 1 回だけ）。autoFocus 属性は、
  // jsx-a11y の no-autofocus で禁じているため、使わない
  useEffect(() => {
    userIdRef.current?.focus();
  }, []);

  // ログイン後の遷移は、ここの 1 か所だけ（ログインに成功したときも、ログイン済みでログイン画面を開いたときも）。
  // 戻り先（next）があればそこへ、なければダッシュボードへ、履歴に残さずに移る
  useEffect(() => {
    if (user !== null) {
      navigate(safeNextPath(next), { replace: true });
    }
  }, [user, next]);

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

  // ログイン済みのときは、上のエフェクトが移るまでの間、フォームを出さない
  if (user !== null) {
    return null;
  }

  return (
    <main className="login-page">
      <div className="login-brand">
        <HouseAndStrawberry />
        <h1>{MESSAGES.appName}</h1>
      </div>
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
            ref={userIdRef}
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
        <div className="login-field">
          <label htmlFor={passwordId}>
            <span>{MESSAGES.login.password}</span>
          </label>
          <PasswordInput
            id={passwordId}
            name="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={fieldErrors.password !== undefined}
            aria-describedby={fieldErrors.password === undefined ? undefined : 'password-error'}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
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
