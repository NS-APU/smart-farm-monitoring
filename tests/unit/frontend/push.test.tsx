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
  /** ブラウザの購読の JSON（宛先と、暗号鍵 p256dh・auth。#241）。鍵を返さない購読もある。 */
  toJSON: () => { endpoint?: string; keys?: Record<string, string> };
}

const SUBSCRIPTION_KEYS = { p256dh: 'dummy_p256dh-key', auth: 'dummy_auth-secret' };

function fakeEnvironment(
  options: {
    readonly permission?: NotificationPermission;
    readonly requested?: NotificationPermission;
    readonly existing?: FakeSubscription | null;
    readonly withWorker?: boolean;
    readonly withPushManager?: boolean;
    readonly withNotification?: boolean;
    readonly withoutKeys?: boolean;
    readonly keys?: Record<string, string>;
  } = {},
) {
  const subscription: FakeSubscription = {
    endpoint: 'https://push.example.invalid/dummy-1',
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: () => ({
      endpoint: 'https://push.example.invalid/dummy-1',
      ...(options.withoutKeys === true ? {} : { keys: options.keys ?? SUBSCRIPTION_KEYS }),
    }),
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
      toJSON: () => ({ endpoint: 'https://push.example.invalid/existing' }),
    };
    expect(await createBrowserPush(fakeEnvironment({ existing }).env).currentEndpoint()).toBe(
      existing.endpoint,
    );
    expect(await createBrowserPush(fakeEnvironment().env).currentEndpoint()).toBeUndefined();
  });

  it('購読する: サービスワーカーを登録し、公開鍵で購読して、宛先と暗号鍵（p256dh・auth）を返す（#241）', async () => {
    const { env, subscribe, register } = fakeEnvironment();

    const result = await createBrowserPush(env).subscribe(PUBLIC_KEY);

    expect(result).toEqual({
      endpoint: 'https://push.example.invalid/dummy-1',
      keys: SUBSCRIPTION_KEYS,
    });
    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('購読が暗号鍵を返さない（片方だけの場合を含む）ときは、鍵なしで、宛先だけを返す（サーバーは、本文なしで送る）', async () => {
    const withoutKeys = await createBrowserPush(
      fakeEnvironment({ withoutKeys: true }).env,
    ).subscribe(PUBLIC_KEY);

    const partial = await createBrowserPush(
      fakeEnvironment({ keys: { p256dh: 'dummy_p256dh-key' } }).env,
    ).subscribe(PUBLIC_KEY);

    expect(withoutKeys).toEqual({ endpoint: 'https://push.example.invalid/dummy-1' });
    expect(partial).toEqual({ endpoint: 'https://push.example.invalid/dummy-1' });
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
      toJSON: () => ({ endpoint: 'https://push.example.invalid/existing' }),
    };
    expect(await createBrowserPush(fakeEnvironment({ existing }).env).unsubscribe()).toBe(
      existing.endpoint,
    );
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await createBrowserPush(fakeEnvironment().env).unsubscribe()).toBeUndefined();
  });
});

/** iOS・iPadOS の判定に使う、実際の User-Agent の形（機種・OS のバージョンは、ダミー）。 */
const USER_AGENTS = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  // iPadOS 13 以降の Safari は、既定で、Mac を名乗る（platform も MacIntel）。タッチの点数で見分ける
  ipadosDesktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15',
  iphoneEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/123.0.0.0 Mobile/15E148 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Dummy) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
} as const;

describe('createBrowserPush: ホーム画面に追加する案内が要るか（needsHomeScreen。#159 SC-15-8）', () => {
  /** Push API を持たない（Safari のタブ）環境。ホーム画面から開いている環境は、withPushManager で作る。 */
  function iosEnvironment(
    navigatorFields: {
      userAgent?: string;
      platform?: string;
      maxTouchPoints?: number;
      standalone?: boolean;
    },
    options: { withPushManager?: boolean; displayModeStandalone?: boolean } = {},
  ): BrowserEnvironment {
    const base = fakeEnvironment({ withPushManager: options.withPushManager ?? false }).env;
    return {
      ...base,
      navigator: { ...base.navigator, ...navigatorFields },
      matchMedia: (query: string) => ({
        matches: query === '(display-mode: standalone)' && options.displayModeStandalone === true,
      }),
    };
  }

  it.each([
    [
      'iPhone の Safari',
      { userAgent: USER_AGENTS.iphoneSafari, platform: 'iPhone', maxTouchPoints: 5 },
    ],
    [
      'iPad の Safari（モバイル表示）',
      { userAgent: USER_AGENTS.ipadSafari, platform: 'iPad', maxTouchPoints: 5 },
    ],
    [
      'iPadOS の Safari（デスクトップ表示。User-Agent は Mac を名乗る）',
      { userAgent: USER_AGENTS.ipadosDesktopSafari, platform: 'MacIntel', maxTouchPoints: 5 },
    ],
  ])('%s のタブで開いている（Web Push に未対応）: true', (_name, fields) => {
    const push = createBrowserPush(iosEnvironment(fields));

    expect(push.isSupported()).toBe(false);
    expect(push.needsHomeScreen()).toBe(true);
  });

  it.each([
    [
      'Mac の Safari（タッチなし）',
      { userAgent: USER_AGENTS.macSafari, platform: 'MacIntel', maxTouchPoints: 0 },
    ],
    [
      'Android の Chrome',
      { userAgent: USER_AGENTS.androidChrome, platform: 'Linux armv8l', maxTouchPoints: 5 },
    ],
    [
      'iPhone の Chrome（Safari ではない）',
      { userAgent: USER_AGENTS.iphoneChrome, platform: 'iPhone', maxTouchPoints: 5 },
    ],
    [
      'iPhone の Firefox（Safari ではない）',
      { userAgent: USER_AGENTS.iphoneFirefox, platform: 'iPhone', maxTouchPoints: 5 },
    ],
    [
      'iPhone の Edge（Safari ではない）',
      { userAgent: USER_AGENTS.iphoneEdge, platform: 'iPhone', maxTouchPoints: 5 },
    ],
    ['User-Agent がない環境', {}],
  ])('%s: false（これまでの「対応していません」の文言）', (_name, fields) => {
    expect(createBrowserPush(iosEnvironment(fields)).needsHomeScreen()).toBe(false);
  });

  it('ホーム画面から開いている（navigator.standalone が true）なら、案内しない', () => {
    const push = createBrowserPush(
      iosEnvironment({ userAgent: USER_AGENTS.iphoneSafari, platform: 'iPhone', standalone: true }),
    );

    expect(push.needsHomeScreen()).toBe(false);
  });

  it('ホーム画面から開いている（display-mode: standalone）なら、案内しない', () => {
    const push = createBrowserPush(
      iosEnvironment(
        { userAgent: USER_AGENTS.iphoneSafari, platform: 'iPhone' },
        { displayModeStandalone: true },
      ),
    );

    expect(push.needsHomeScreen()).toBe(false);
  });

  it('Web Push に対応している（ホーム画面のアプリで、Push API が使える）なら、案内しない', () => {
    const push = createBrowserPush(
      iosEnvironment(
        { userAgent: USER_AGENTS.iphoneSafari, platform: 'iPhone', maxTouchPoints: 5 },
        { withPushManager: true },
      ),
    );

    expect(push.isSupported()).toBe(true);
    expect(push.needsHomeScreen()).toBe(false);
  });

  it('matchMedia がない環境でも、判定できる（タブの iPhone なら true）', () => {
    const base = fakeEnvironment({ withPushManager: false }).env;
    const env: BrowserEnvironment = {
      ...base,
      navigator: { ...base.navigator, userAgent: USER_AGENTS.iphoneSafari, platform: 'iPhone' },
    };

    expect(createBrowserPush(env).needsHomeScreen()).toBe(true);
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
  /** 購読が暗号鍵を返さない。 */
  withoutKeys?: boolean;
  /** iOS・iPadOS の Safari のタブで開いている（ホーム画面に追加して開き直す必要がある。#159 SC-15-8）。 */
  needsHomeScreen?: boolean;
}

function fakePush(options: FakePushOptions = {}) {
  let endpoint = options.endpoint;
  const push: PushBrowser & { subscribeCalls: string[] } = {
    subscribeCalls: [],
    isSupported: () => options.supported ?? true,
    needsHomeScreen: () => options.needsHomeScreen ?? false,
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
      return Promise.resolve({
        endpoint,
        ...(options.withoutKeys === true ? {} : { keys: SUBSCRIPTION_KEYS }),
      });
    },
    unsubscribe: () => {
      const previous = endpoint;
      endpoint = undefined;
      return Promise.resolve(previous);
    },
  };
  return push;
}

const AVAILABLE = {
  isAvailable: true,
  publicKey: PUBLIC_KEY,
  isSubscribed: false,
  isInvalidated: false,
};

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
      keys: SUBSCRIPTION_KEYS,
    });
    await waitFor(() => {
      expect(screen.getByTestId('push-state').textContent).toContain('有効');
    });
    expect(screen.getByRole('button', { name: '解除する' })).toBeDefined();
  });

  it('購読が暗号鍵を返さない場合は、宛先だけを登録する（鍵のない購読。本文なしで配信される）', async () => {
    const { calls } = renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse({ ...AVAILABLE, isSubscribed: false }),
        'PUT /push-subscription': () => noContent(),
      },
      { pushBrowser: fakePush({ withoutKeys: true }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: '有効にする' }));

    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/push-subscription')).toHaveLength(1);
    });
    expect(callsOf(calls, 'PUT', '/push-subscription')[0]?.body).toEqual({
      endpoint: 'https://push.example.invalid/new',
    });
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
          jsonResponse({
            isAvailable: false,
            publicKey: null,
            isSubscribed: false,
            isInvalidated: false,
          }),
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

describe('通知の設定: iPhone・iPad のタブでの案内（#159 SC-15-8）', () => {
  it('iOS・iPadOS の Safari のタブで開いているときは、「ホーム画面に追加して、アイコンから開き直してください」と案内する。有効にできない', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ supported: false, needsHomeScreen: true }) },
    );

    const limitation = await screen.findByTestId('push-limitation');

    expect(limitation.textContent).toContain(
      'ホーム画面に追加して、アイコンから開き直してください',
    );
    expect(limitation.textContent).not.toContain('このブラウザは、Web Push 通知に対応していません');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '有効にする' }).disabled).toBe(
      true,
    );
  });

  it('それ以外の未対応（Web Push 非対応のブラウザなど）は、これまでの文言', async () => {
    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush({ supported: false, needsHomeScreen: false }) },
    );

    const limitation = await screen.findByTestId('push-limitation');

    expect(limitation.textContent).toBe(
      'このブラウザは、Web Push 通知に対応していません。画面内の通知のみ利用できます',
    );
  });
});

describe('通知の設定: 購読が無効になったときの案内（#159 SC-15-6）', () => {
  it('購読が無効になっている（isInvalidated）ときは、「無効になりました。もう一度有効にしてください」と示す。状態は「無効」で、有効にできる', async () => {
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () =>
          jsonResponse({ ...AVAILABLE, isSubscribed: false, isInvalidated: true }),
      },
      { pushBrowser: fakePush({ endpoint: 'https://push.example.invalid/mine' }) },
    );

    const notice = await screen.findByTestId('push-invalidated');

    expect(notice.textContent).toContain('無効になりました。もう一度有効にしてください');
    expect(screen.getByTestId('push-state').textContent).toContain('無効');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '有効にする' }).disabled).toBe(
      false,
    );
  });

  it('無効になっていない（ふつうの「無効」）ときは、示さない。有効なときも、示さない', async () => {
    const { unmount } = renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush() },
    );
    await screen.findByTestId('push-state');
    expect(screen.queryByTestId('push-invalidated')).toBeNull();
    unmount();

    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () =>
          jsonResponse({ ...AVAILABLE, isSubscribed: true, isInvalidated: true }),
      },
      { pushBrowser: fakePush({ endpoint: 'https://push.example.invalid/mine' }) },
    );
    await screen.findByTestId('push-state');
    expect(screen.queryByTestId('push-invalidated')).toBeNull();
  });

  it('もう一度有効にすると、案内は消える', async () => {
    let subscribed = false;
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () =>
          jsonResponse({ ...AVAILABLE, isSubscribed: subscribed, isInvalidated: !subscribed }),
        'PUT /push-subscription': () => {
          subscribed = true;
          return noContent();
        },
      },
      { pushBrowser: fakePush() },
    );
    await screen.findByTestId('push-invalidated');

    fireEvent.click(screen.getByRole('button', { name: '有効にする' }));

    await waitFor(() => {
      expect(screen.queryByTestId('push-invalidated')).toBeNull();
    });
    expect(screen.getByTestId('push-state').textContent).toContain('有効');
  });
});

describe('通知の設定: テスト通知（#159 SC-15-2）', () => {
  const MINE = 'https://push.example.invalid/mine';
  const SUBSCRIBED = { ...AVAILABLE, isSubscribed: true };

  it('有効なときだけ、「テスト通知を送る」を示す。無効なときは、示さない', async () => {
    const { unmount } = renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(AVAILABLE) },
      { pushBrowser: fakePush() },
    );
    await screen.findByTestId('push-state');
    expect(screen.queryByRole('button', { name: 'テスト通知を送る' })).toBeNull();
    unmount();

    renderApp(
      '/settings/push',
      { 'GET /push-subscription': () => jsonResponse(SUBSCRIBED) },
      { pushBrowser: fakePush({ endpoint: MINE }) },
    );
    expect(await screen.findByRole('button', { name: 'テスト通知を送る' })).toBeDefined();
  });

  it('押すと、この端末の宛先で API を呼び、送ったことを示す（届くか確認するよう促す）', async () => {
    const { calls } = renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse(SUBSCRIBED),
        'POST /push-subscription/test': () => noContent(),
      },
      { pushBrowser: fakePush({ endpoint: MINE }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'テスト通知を送る' }));

    expect((await screen.findByTestId('push-done')).textContent).toBe(
      'テスト通知を送りました。この端末に届いたか、確認してください',
    );
    expect(callsOf(calls, 'POST', '/push-subscription/test')).toHaveLength(1);
    expect(callsOf(calls, 'POST', '/push-subscription/test')[0]?.body).toEqual({ endpoint: MINE });
  });

  it('1 分以内の再送（429）は、サーバーのメッセージ（あと何秒か）を示す。成功の表示は出さない', async () => {
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () => jsonResponse(SUBSCRIBED),
        'POST /push-subscription/test': () =>
          errorBody(
            429,
            'RATE_LIMITED',
            'テスト通知は、1 分に 1 回までです。あと 40 秒たってから、もう一度お試しください',
          ),
      },
      { pushBrowser: fakePush({ endpoint: MINE }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'テスト通知を送る' }));

    expect((await screen.findByRole('alert')).textContent).toContain('あと 40 秒');
    expect(screen.queryByTestId('push-done')).toBeNull();
  });

  it('購読が無効になっていた（409）ときは、エラーを示し、状態を取り直して、「無効になりました」を示す', async () => {
    let invalidated = false;
    renderApp(
      '/settings/push',
      {
        'GET /push-subscription': () =>
          jsonResponse(
            invalidated ? { ...AVAILABLE, isSubscribed: false, isInvalidated: true } : SUBSCRIBED,
          ),
        'POST /push-subscription/test': () => {
          invalidated = true;
          return errorBody(
            409,
            'CONFLICT',
            'この端末の Web Push 通知は、無効になりました。もう一度有効にしてください',
          );
        },
      },
      { pushBrowser: fakePush({ endpoint: MINE }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'テスト通知を送る' }));

    expect((await screen.findByRole('alert')).textContent).toContain('もう一度有効にしてください');
    expect(await screen.findByTestId('push-invalidated')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'テスト通知を送る' })).toBeNull();
  });
});
