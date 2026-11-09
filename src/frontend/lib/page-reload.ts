/**
 * 古い画面の部品（遅延読み込みのチャンク）の取得の失敗への対応（Issue #323）。
 * デプロイのあと、ブラウザが古い画面（`index.html`・メインのバンドル）を使い続けると、削除済みの画面の部品の取得に失敗する
 * （`Failed to fetch dynamically imported module`）。再読み込みで、新しい版になり、直る。
 * 失敗を見分け（isChunkLoadError）、1 回だけ、自動で再読み込みする（tryAutoReload。読み込みの繰り返しを防ぐ）。
 */

/** 動的 import の失敗のメッセージ（ブラウザごと）。 */
const CHUNK_LOAD_MESSAGES: readonly string[] = [
  // Chrome・Edge
  'Failed to fetch dynamically imported module',
  // Firefox
  'error loading dynamically imported module',
  // Safari
  'Importing a module script failed',
];

/** 画面の部品（チャンク）の取得の失敗か。 */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error && CHUNK_LOAD_MESSAGES.some((message) => error.message.includes(message))
  );
}

/** 再読み込み（テストで、差し替える）。 */
export const pageReloader = {
  reload(): void {
    window.location.reload();
  },
};

/** 自動の再読み込みの、最短の間隔（ミリ秒）。これより短い間隔では、繰り返さない（読み込みの無限の繰り返しを防ぐ）。 */
export const AUTO_RELOAD_INTERVAL_MS = 60_000;
export const AUTO_RELOAD_STORAGE_KEY = 'sfm-chunk-auto-reload-at';

/**
 * 自動で再読み込みする（前回の自動の再読み込みから、一定の時間が過ぎているときだけ）。再読み込みしたら true。
 * ブラウザの保存領域（sessionStorage）が使えないときは、繰り返しを避けるため、しない（false）。
 */
export function tryAutoReload(now: number = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < AUTO_RELOAD_INTERVAL_MS) {
      return false;
    }
    window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(now));
  } catch {
    return false;
  }
  pageReloader.reload();
  return true;
}
