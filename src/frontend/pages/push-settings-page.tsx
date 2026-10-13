/**
 * SC-15 通知の設定（UC-23。FR-7.2）。Web Push 通知の有効化（ブラウザの許可を求め、購読を登録）と解除。
 * 有効／無効を示す。ブラウザが未対応・許可されていない場合は、その旨と、画面内の通知のみとなることを示す。
 * 設定は、ログイン中の利用者の、この端末が対象（暫定。dev_spec.md 4章）。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { getPushStatus, subscribePush, unsubscribePush } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { FormError } from '../components/form-controls.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { usePolling } from '../hooks/use-polling.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { usePushBrowser } from '../push/push-context.tsx';
import type { PushPermission } from '../push/browser-push.ts';

const TEXT = MESSAGES.push;

export function PushSettingsPage(): ReactNode {
  const { api } = useAuth();
  const push = usePushBrowser();
  // この端末の購読の状態（端末ごとに、有効・無効が異なる）。端末が購読していなければ（宛先がなければ）、無効
  const fetchStatus = useCallback(async () => {
    const endpoint = await push.currentEndpoint().catch(() => undefined);
    const status = await getPushStatus(api, endpoint);
    return { ...status, isSubscribed: endpoint !== undefined && status.isSubscribed };
  }, [api, push]);
  const { data, error, reload } = usePolling(fetchStatus);
  const submit = useSubmit();
  const [permission, setPermission] = useState<PushPermission>(() => push.permission());
  const [done, setDone] = useState<string | undefined>(undefined);

  async function enable(publicKey: string): Promise<void> {
    setDone(undefined);
    const result = await submit.run(async () => {
      const granted = await push.requestPermission();
      setPermission(granted);
      if (granted !== 'granted') {
        return false;
      }
      // ブラウザの機能の失敗（購読できない等）は、内部の情報を含まない案内にする
      const endpoint = await push.subscribe(publicKey).catch(() => {
        throw new ApiError(0, 'INTERNAL_ERROR', TEXT.failed);
      });
      await subscribePush(api, endpoint);
      return true;
    });
    if (result.ok && result.value) {
      setDone(TEXT.enabledDone);
      reload();
    }
  }

  async function disable(): Promise<void> {
    setDone(undefined);
    const result = await submit.run(async () => {
      await unsubscribePush(api, await push.unsubscribe());
    });
    if (result.ok) {
      setDone(TEXT.disabledDone);
      reload();
    }
  }

  let body: ReactNode;
  if (error !== undefined) {
    body = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingView />;
  } else {
    const limitation = !push.isSupported()
      ? TEXT.unsupported
      : !data.isAvailable
        ? TEXT.unavailable
        : permission === 'denied'
          ? TEXT.denied
          : undefined;
    const publicKey = data.publicKey;
    body = (
      <>
        <p className="push-state" data-testid="push-state">
          <span>{TEXT.state}: </span>
          <strong className={data.isSubscribed ? 'push-on' : 'push-off'}>
            {data.isSubscribed ? TEXT.enabled : TEXT.disabled}
          </strong>
        </p>
        {limitation === undefined ? (
          data.isSubscribed ? null : (
            <p className="muted">{TEXT.permissionRequest}</p>
          )
        ) : (
          <p className="notice notice-warning" role="status" data-testid="push-limitation">
            {limitation}
          </p>
        )}
        <div className="form-actions">
          {data.isSubscribed ? (
            <button
              type="button"
              className="button-secondary"
              disabled={submit.busy}
              onClick={() => {
                void disable();
              }}
            >
              {TEXT.disable}
            </button>
          ) : (
            <button
              type="button"
              disabled={submit.busy || limitation !== undefined || publicKey === null}
              onClick={() => {
                if (publicKey !== null) {
                  void enable(publicKey);
                }
              }}
            >
              {submit.busy ? TEXT.enabling : TEXT.enable}
            </button>
          )}
        </div>
        <FormError message={submit.formMessage} />
        {done === undefined ? null : (
          <p role="status" className="form-success" data-testid="push-done">
            {done}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="push-settings-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      <section className="panel" aria-label={TEXT.state}>
        {body}
        <p className="muted">{TEXT.scopeNote}</p>
      </section>
    </div>
  );
}
