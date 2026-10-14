/**
 * 未読の通知の件数（ヘッダー）の再取得の通知。通知を既読にした画面などが発行し、ヘッダーが受け取って、
 * 約10秒の更新を待たずに件数を読み直す。
 */

const UNREAD_CHANGED_EVENT = 'smart-farm:unread-changed';

export function notifyUnreadChanged(): void {
  window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
}

export function subscribeUnreadChanged(listener: () => void): () => void {
  window.addEventListener(UNREAD_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(UNREAD_CHANGED_EVENT, listener);
  };
}
