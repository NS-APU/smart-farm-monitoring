/*
 * サービスワーカー（Web Push の受信。FR-7.2）。サーバーから push を受け取ったら、通知を表示する。
 * 通知を選ぶと、通知の画面（/notifications）を開く。
 * push の本文の形式は、`src/shared/schemas/notification.ts` の PushPayloadSchema（title・message・notificationId）。
 * このファイルは、TypeScript でなく、ビルドを通さずに配信するため、スキーマを import できない。形式を変えるときは、双方を更新する。
 */

/** push の本文（JSON）を読む。本文がない・JSON でない・オブジェクトでない場合は、空として扱い、既定の文言で通知を表示する。 */
function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    return data !== null && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === 'string' ? data.title : '稼働モニタリング',
      {
        body: typeof data.message === 'string' ? data.message : '新しい通知があります',
        tag: typeof data.notificationId === 'string' ? data.notificationId : undefined,
      },
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/notifications'));
});
