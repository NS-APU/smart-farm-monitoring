/**
 * ブラウザの Web Push（サービスワーカー・Push API・Notification API）の呼び出しを、1か所にまとめる（FR-7.2）。
 * 画面は、この窓口（PushBrowser）だけを使う。テストでは、差し替える。
 * 購読の宛先（endpoint）は、サーバーへ登録する。実際の配信は、サーバー（ポート NotifierPort）が行う。
 */

export type PushPermission = NotificationPermission | 'unsupported';

export interface PushBrowser {
  /** このブラウザが、Web Push（サービスワーカー・Push API・通知）に対応しているか。 */
  isSupported(): boolean;
  /** 通知の許可の状態。未対応なら 'unsupported'。 */
  permission(): PushPermission;
  /** 通知の許可を求める（ブラウザの確認が表示される）。 */
  requestPermission(): Promise<PushPermission>;
  /** この端末（ブラウザ）の購読の宛先。購読していない・未対応なら undefined。 */
  currentEndpoint(): Promise<string | undefined>;
  /** サービスワーカーを登録し、購読して、宛先（endpoint）を返す。 */
  subscribe(publicKey: string): Promise<string>;
  /** 購読を解除する。解除した購読の宛先を返す（購読がなければ undefined）。 */
  unsubscribe(): Promise<string | undefined>;
}

/** ブラウザの機能の窓口。テストでは、同じ形のオブジェクトを渡す。 */
export interface BrowserEnvironment {
  readonly navigator: {
    readonly serviceWorker?: {
      register(scriptUrl: string): Promise<unknown>;
      readonly ready: Promise<{
        readonly pushManager: {
          subscribe(options: {
            userVisibleOnly: boolean;
            applicationServerKey: Uint8Array<ArrayBuffer>;
          }): Promise<{ readonly endpoint: string; unsubscribe(): Promise<boolean> }>;
          getSubscription(): Promise<{
            readonly endpoint: string;
            unsubscribe(): Promise<boolean>;
          } | null>;
        };
      }>;
    };
  };
  readonly Notification?: {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  };
  readonly PushManager?: unknown;
}

const SERVICE_WORKER_URL = '/sw.js';

/** 公開鍵（base64url）を、購読の鍵（バイト列）にする。 */
export function decodePublicKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(publicKey.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** サービスワーカーの準備を待つ時間の上限（ミリ秒）。 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

export function createBrowserPush(env: BrowserEnvironment): PushBrowser {
  function supported(): boolean {
    return (
      env.navigator.serviceWorker !== undefined &&
      env.PushManager !== undefined &&
      env.Notification !== undefined
    );
  }

  async function readyRegistration() {
    const worker = env.navigator.serviceWorker;
    if (worker === undefined) {
      throw new Error('サービスワーカーに対応していません');
    }
    await worker.register(SERVICE_WORKER_URL);
    // 有効なサービスワーカーがない環境では、ready は、拒否されず、保留のままになる。画面が読み込み中のまま止まらないよう、上限を設ける（V-062）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('サービスワーカーの準備が完了しませんでした'));
      }, SERVICE_WORKER_READY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([worker.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isSupported: supported,

    permission() {
      return supported() ? (env.Notification?.permission ?? 'unsupported') : 'unsupported';
    },

    async requestPermission() {
      if (!supported() || env.Notification === undefined) {
        return 'unsupported';
      }
      return env.Notification.requestPermission();
    },

    async currentEndpoint() {
      if (!supported()) {
        return undefined;
      }
      const registration = await readyRegistration();
      return (await registration.pushManager.getSubscription())?.endpoint;
    },

    async subscribe(publicKey) {
      const registration = await readyRegistration();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodePublicKey(publicKey),
      });
      return subscription.endpoint;
    },

    async unsubscribe() {
      const registration = await readyRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription === null) {
        return undefined;
      }
      await subscription.unsubscribe();
      return subscription.endpoint;
    },
  };
}
