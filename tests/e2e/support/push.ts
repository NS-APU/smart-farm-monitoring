/**
 * Web Push（UC-23）の E2E の補助。実際の Push サービスへの接続・ブラウザの許可の確認は、テストできないため、
 * ブラウザの機能（Notification の許可、PushManager の購読）を、ページの読み込み前にスタブへ差し替える。
 * サービスワーカーの登録（/sw.js）と、サーバーへの購読の登録・解除・配信の記録は、実際のものを使う。
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { apiOk } from './app.ts';

export interface PushStubOptions {
  /** ブラウザが Web Push に対応しているか。false なら、PushManager を持たない。 */
  readonly supported?: boolean;
  /** 通知の許可の初期状態。 */
  readonly permission?: 'default' | 'granted' | 'denied';
  /** 許可を求められたときの、利用者の回答。 */
  readonly answer?: 'granted' | 'denied';
  /** 購読の宛先（endpoint）の識別。端末ごとに変える。 */
  readonly device?: string;
}

/** ページの読み込み前に呼ぶ（`page.goto` の前）。 */
export async function stubPush(page: Page, options: PushStubOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ supported, permission, answer, device }) => {
      let currentPermission = permission;
      const storageKey = 'e2e-push-endpoint';
      const endpoint = `https://push.example.invalid/e2e/${device}`;
      const stubNotification = {
        get permission(): string {
          return currentPermission;
        },
        requestPermission(): Promise<string> {
          currentPermission = answer;
          return Promise.resolve(currentPermission);
        },
      };
      Object.defineProperty(window, 'Notification', {
        value: stubNotification,
        configurable: true,
      });
      if (!supported) {
        Object.defineProperty(window, 'PushManager', { value: undefined, configurable: true });
        return;
      }
      const subscriptionObject = () => ({
        endpoint,
        unsubscribe: () => {
          window.localStorage.removeItem(storageKey);
          return Promise.resolve(true);
        },
      });
      const manager = (
        window as unknown as { PushManager?: { prototype: Record<string, unknown> } }
      ).PushManager;
      if (manager !== undefined) {
        manager.prototype.subscribe = () => {
          window.localStorage.setItem(storageKey, endpoint);
          return Promise.resolve(subscriptionObject());
        };
        manager.prototype.getSubscription = () =>
          Promise.resolve(
            window.localStorage.getItem(storageKey) === null ? null : subscriptionObject(),
          );
      }
    },
    {
      supported: options.supported ?? true,
      permission: options.permission ?? 'default',
      answer: options.answer ?? 'granted',
      device: options.device ?? 'device-1',
    },
  );
}

/** Web Push のダミーが、配信した内容（通知の識別子・購読の識別子）。 */
export async function deliveredPushes(
  request: APIRequestContext,
): Promise<{ notificationId: string; subscriptionId: string }[]> {
  const body = await apiOk<{ items: { notificationId: string; subscriptionId: string }[] }>(
    request,
    'GET',
    '/dev/mocks/web-push/delivered',
  );
  return body.items;
}

/** ログイン中の利用者の、Web Push の購読の状態（API）。 */
export async function pushStatus(
  request: APIRequestContext,
): Promise<{ isAvailable: boolean; publicKey: string | null; isSubscribed: boolean }> {
  return apiOk(request, 'GET', '/push-subscription');
}
