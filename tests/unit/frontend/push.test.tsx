import { renderHook } from '@testing-library/react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserPush,
  decodePublicKey,
  type BrowserEnvironment,
  type PushBrowser,
  type PushPermission,
} from '../../../src/frontend/push/browser-push.ts';
import { usePushBrowser } from '../../../src/frontend/push/push-context.tsx';
import { jsonResponse } from '../../support/frontend.ts';
import { callsOf, errorBody, noContent, renderApp } from '../../support/management-frontend.ts';

const PUBLIC_KEY = 'ZHVtbXktcHVibGljLWtleQ';

interface FakeSubscription {
  readonly endpoint: string;
  unsubscribe: () => Promise<boolean>;
}

function fakeEnvironment(
  options: {
    readonly permission?: NotificationPermission;
    readonly requested?: NotificationPermission;
    readonly existing?: FakeSubscription | null;
    readonly withWorker?: boolean;
    readonly withPushManager?: boolean;
    readonly withNotification?: boolean;
  } = {},
) {
  const subscription: FakeSubscription = {
    endpoint: 'https://push.example.invalid/dummy-1',
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  let current: FakeSubscription | null = options.existing ?? null;
  const subscribe = vi.fn(() => {
    current = subscription;
    return Promise.resolve(subscription);
  });
  const register = vi.fn(() => Promise.resolve({}));
  const env: BrowserEnvironment = {
    navigator:
      options.withWorker === false
        ? {}
        : {
            serviceWorker: {
              register,
              ready: Promise.resolve({
                pushManager: { subscribe, getSubscription: () => Promise.resolve(current) },
              }),
            },
          },
    ...(options.withNotification === false
      ? {}
      : {
          Notification: {
            permission: options.permission ?? 'default',
            requestPermission: () => Promise.resolve(options.requested ?? 'granted'),
          },
        }),
    ...(options.withPushManager === false ? {} : { PushManager: {} }),
  };
  return { env, subscription, subscribe, register };
}

describe('decodePublicKey', () => {
  it('base64url の公開鍵を、バイト列にする（パディングなし・- と _ を含む）', () => {
    expect([...decodePublicKey('ZHVtbXk')]).toEqual([...new TextEncoder().encode('dummy')]);
    // 0xfb 0xff は、base64url で「-_8」
    expect([...decodePublicKey('-_8')]).toEqual([0xfb, 0xff]);
  });
});

describe('createBrowserPush（ブラウザの Web Push の窓口）', () => {
  it('サービスワーカー・Push API・通知がそろっていれば、対応している。許可の状態を返す', () => {
    const push = createBrowserPush(fakeEnvironment({ permission: 'denied' }).env);
    expect(push.isSupported()).toBe(true);
    expect(push.permission()).toBe('denied');
  });

  it.each([
    ['サービスワーカーがない', { withWorker: false }],
    ['Push API がない', { withPushManager: false }],
    ['通知の機能がない', { withNotification: false }],
  ])('%s場合は、未対応。許可の確認・宛先の取得は、行わない', async (_name, options) => {
    const { env, register } = fakeEnvironment(options);
    const push = createBrowserPush(env);

    expect(push.isSupported()).toBe(false);
    expect(push.permission()).toBe('unsupported');
    expect(await push.requestPermission()).toBe('unsupported');
    expect(await push.currentEndpoint()).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it('許可を求める: ブラウザの確認の結果を返す', async () => {
    const push = createBrowserPush(fakeEnvironment({ requested: 'denied' }).env);
    expect(await push.requestPermission()).toBe('denied');
  });

  it('現在の宛先: 購読があれば、その宛先。なければ undefined', async () => {
    const existing: FakeSubscription = {
      endpoint: 'https://push.example.invalid/existing',
      unsubscribe: () => Promise.resolve(true),
    };
    expect(await createBrowserPush(fakeEnvironment({ existing }).env).currentEndpoint()).toBe(
      existing.endpoint,
    );
    expect(await createBrowserPush(fakeEnvironment().env).currentEndpoint()).toBeUndefined();
  });

  it('購読する: サービスワーカーを登録し、公開鍵で購読して、宛先を返す', async () => {
    const { env, subscribe, register } = fakeEnvironment();

    const endpoint = await createBrowserPush(env).subscribe(PUBLIC_KEY);

    expect(endpoint).toBe('https://push.example.invalid/dummy-1');
    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('サービスワーカーに対応していなければ、購読・解除は、エラーになる', async () => {
    const push = createBrowserPush(fakeEnvironment({ withWorker: false }).env);
    await expect(push.subscribe(PUBLIC_KEY)).rejects.toThrow('サービスワーカーに対応していません');
    await expect(push.unsubscribe()).rejects.toThrow('サービスワーカーに対応していません');
  });

  it('解除する: 購読を解除し、その宛先を返す。購読がなければ undefined', async () => {
    const existing: FakeSubscription = {
      endpoint: 'https://push.example.invalid/existing',
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    expect(await createBrowserPush(fakeEnvironment({ existing }).env).unsubscribe()).toBe(
      existing.endpoint,
    );
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await createBrowserPush(fakeEnvironment().env).unsubscribe()).toBeUndefined();
  });
});

describe('usePushBrowser', () => {
  it('PushBrowserProvider の外では、エラーになる', () => {
    expect(() => renderHook(() => usePushBrowser())).toThrow('PushBrowserProvider の外');
  });
});

interface FakePushOptions {
  permission?: PushPermission;
  requested?: PushPermission;
  supported?: boolean;
  endpoint?: string | undefined;
  currentEndpointFails?: boolean;
  subscribeFails?: boolean;
}

function fakePush(options: FakePushOptions = {}) {
  let endpoint = options.endpoint;
  const push: PushBrowser & { subscribeCalls: string[] } = {
    subscribeCalls: [],
    isSupported: () => options.supported ?? true,
    permission: () => options.permission ?? 'default',
    requestPermission: () => Promise.resolve(options.requested ?? 'granted'),
    currentEndpoint: () =>
      options.currentEndpointFails === true
        ? Promise.reject(new Error('失敗'))
        : Promise.resolve(endpoint),
    subscribe: (publicKey) => {
      push.subscribeCalls.push(publicKey);
      if (options.subscribeFails === true) {
        return Promise.reject(new Error('内部の詳細'));
      }
      endpoint = 'https://push.example.invalid/new';
      return Promise.resolve(endpoint);
    },
    unsubscribe: () => {
      const previous = endpoint;
      endpoint = undefined;
      return Promise.resolve(previous);
    },
  };
  return push;
}

const AVAILABLE = { isAvailable: true, publicKey: PUBLIC_KEY, isSubscribed: false };

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('通知の設定（UC-23。SC-15）', () => {
  it('無効のとき: 状態を「無効」と示し、有効にできる。有効にすると、許可を求めて購読し、サーバーへ登録する', async () => {
    let subscribed = false;
    const pushBrowser = fakePush();
    const { calls } = renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: subscribed }),
        'PUT /push-subscription': () => {
          subscribed = true;
          return noContent();
        },
      },
      { pushBrowser },
    );
    expect((await screen.findByTestId('push-state')).textContent).toContain('無効');
    expect(screen.getByText('有効にすると、ブラウザが通知の許可を求めます')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '有効にする' }));

    expect((await screen.findByTestId('push-done')).textContent).toBe(
      'Web Push 通知を有効にしました',
    );
    expect(pushBrowser.subscribeCalls).toEqual([PUBLIC_KEY]);
    expect(callsOf(calls, 'PUT', '/push-subscription')[0]?.body).toEqual({
      endpoint: 'https://push.example.invalid/new',
    });
    await waitFor(() => {
      expect(screen.getByTestId('push-state').textContent).toContain('有効');
    });
    expect(screen.getByRole('button', { name: '解除する' })).toBeDefined();
  });

  it('宛先は、この端末のものでサーバーに問い合わせる。サーバーが有効でも、この端末が購読していなければ無効', async () => {
    const { calls } = renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: true }) },
      { pushBrowser: fakePush({ endpoint: undefined }) },
    );
    expect((await screen.findByTestId('push-state')).textContent).toContain('無効');
    expect(callsOf(calls, 'GET', '/push-subscription')[0]?.query.get('endpoint')).toBeNull();
  });

  it('この端末が購読していれば、宛先を付けて問い合わせ、「有効」と示す。解除できる', async () => {
    let subscribed = true;
    const { calls } = renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: subscribed }),
        'DELETE /push-subscription': () => {
          subscribed = false;
          return noContent();
        },
      },
      { pushBrowser: fakePush({ endpoint: 'https://push.example.invalid/mine' }) },
    );
    expect((await screen.findByTestId('push-state')).textContent).toContain('有効');
    // 有効のときは、「有効にすると、許可を求めます」の案内を出さない
    expect(screen.queryByText('有効にすると、ブラウザが通知の許可を求めます')).toBeNull();
    expect(callsOf(calls, 'GET', '/push-subscription')[0]?.query.get('endpoint')).toBe(
      'https://push.example.invalid/mine',
    );

    fireEvent.click(screen.getByRole('button', { name: '解除する' }));

    expect((await screen.findByTestId('push-done')).textContent).toBe(
      'Web Push 通知を解除しました',
    );
    expect(callsOf(calls, 'DELETE', '/push-subscription')[0]?.body).toEqual({
      endpoint: 'https://push.example.invalid/mine',
    });
    await waitFor(() => {
      expect(screen.getByTestId('push-state').textContent).toContain('無効');
    });
  });

  it('宛先を取得できなくても、状態の確認は続ける（無効として扱う）。解除に宛先がなければ、宛先なしで解除する', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: true }) },
      { pushBrowser: fakePush({ currentEndpointFails: true }) },
    );
    expect((await screen.findByTestId('push-state')).textContent).toContain('無効');
  });

  it('解除の宛先がなければ（購読がなければ）、宛先なしで API を呼ぶ', async () => {
    const pushBrowser = fakePush({ endpoint: 'https://push.example.invalid/mine' });
    pushBrowser.unsubscribe = () => Promise.resolve(undefined);
    const { calls } = renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: true }),
        'DELETE /push-subscription': () => noContent(),
      },
      { pushBrowser },
    );

    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    await screen.findByTestId('push-done');
    expect(callsOf(calls, 'DELETE', '/push-subscription')[0]?.body).toBeUndefined();
  });

  it('解除に失敗した場合は、エラーを表示する', async () => {
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: true }),
        'DELETE /push-subscription': () => errorBody(500, 'INTERNAL_ERROR', '解除できません'),
      },
      { pushBrowser: fakePush({ endpoint: 'https://push.example.invalid/mine' }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: '解除する' }));

    expect((await screen.findByRole('alert')).textContent).toBe('解除できません');
  });

  it('ブラウザで通知が拒否されたとき: 有効にならない。許可の状態を反映して、案内を表示する', async () => {
    const { calls } = renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ requested: 'denied' }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: '有効にする' }));

    expect((await screen.findByTestId('push-limitation')).textContent).toContain(
      '通知が許可されていません',
    );
    expect(screen.queryByTestId('push-done')).toBeNull();
    expect(callsOf(calls, 'PUT', '/push-subscription')).toHaveLength(0);
  });

  it('すでに拒否されている場合は、有効にするボタンを押せない', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ permission: 'denied' }) },
    );
    await screen.findByTestId('push-limitation');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '有効にする' }).disabled).toBe(
      true,
    );
  });

  it('ブラウザが未対応の場合は、その旨を示し、有効にできない', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ supported: false }) },
    );
    expect((await screen.findByTestId('push-limitation')).textContent).toContain(
      '対応していません',
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '有効にする' }).disabled).toBe(
      true,
    );
  });

  it('サーバーで Web Push を使えない（公開鍵の設定がない）場合は、その旨を示し、有効にできない', async () => {
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () =>
          jsonResponse({ isAvailable: false, publicKey: null, isSubscribed: false }),
      },
      { pushBrowser: fakePush() },
    );
    expect((await screen.findByTestId('push-limitation')).textContent).toContain('利用できません');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '有効にする' }).disabled).toBe(
      true,
    );
  });

  it('購読に失敗した場合は、内部の情報を含まない案内を表示する', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ subscribeFails: true }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: '有効にする' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Web Push 通知を設定できませんでした');
    expect(alert.textContent).not.toContain('内部の詳細');
  });

  it('状態の取得に失敗した場合は、エラーを表示する', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => errorBody(500, 'INTERNAL_ERROR', '取得できません') },
      { pushBrowser: fakePush() },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('取得できません');
  });

  it('実際のブラウザの機能を使う場合（jsdom は Web Push 未対応）は、未対応と示す', async () => {
    renderApp('/settings/push', { 'GET /push-subscription': () => jsonResponse(AVAILABLE) });
    expect((await screen.findByTestId('push-limitation')).textContent).toContain(
      '対応していません',
    );
  });
});
