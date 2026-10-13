import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PushPayloadSchema } from '@smart-farm/shared/schemas/notification';

type Listener = (event: unknown) => void;

/** sw.js を、サービスワーカーの `self` を模した環境で実行し、登録されたイベントの処理を取り出す。 */
function loadServiceWorker() {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../src/frontend/public/sw.js'),
    'utf8',
  );
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fakeSelf = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    registration: { showNotification },
    clients: { openWindow },
  };
  runInNewContext(source, { self: fakeSelf });
  return { listeners, showNotification, openWindow };
}

function pushEvent(json: () => unknown) {
  const waitUntil = vi.fn();
  return { event: { data: { json }, waitUntil }, waitUntil };
}

describe('サービスワーカー（push の受信。V-064・V-127）', () => {
  it('本文（title・message・notificationId）の形式は、共有のスキーマ（PushPayloadSchema）と一致する', () => {
    const { listeners, showNotification } = loadServiceWorker();
    const payload = PushPayloadSchema.parse({
      title: '異常を検知しました',
      message: '【異常】収穫精度（ハウス1）',
      notificationId: 'n-1',
    });

    listeners.get('push')?.(pushEvent(() => payload).event);

    expect(showNotification).toHaveBeenCalledWith('異常を検知しました', {
      body: '【異常】収穫精度（ハウス1）',
      tag: 'n-1',
    });
  });

  it.each([
    [
      'JSON でない本文（例外）',
      () => {
        throw new SyntaxError('Unexpected token');
      },
    ],
    ['オブジェクトでない本文', () => 'plain text'],
    ['null の本文', () => null],
    ['型が違うキー', () => ({ title: 1, message: ['a'], notificationId: 5 })],
  ])('%s: 例外にせず、既定の文言で通知を表示する（通知を失わない）', (_name, json) => {
    const { listeners, showNotification } = loadServiceWorker();
    const { event, waitUntil } = pushEvent(json);

    expect(() => listeners.get('push')?.(event)).not.toThrow();

    expect(showNotification).toHaveBeenCalledWith('稼働モニタリング', {
      body: '新しい通知があります',
      tag: undefined,
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('本文がない push も、既定の文言で表示する', () => {
    const { listeners, showNotification } = loadServiceWorker();
    const waitUntil = vi.fn();

    listeners.get('push')?.({ data: null, waitUntil });

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('通知を選ぶと、通知を閉じて、通知の画面を開く', () => {
    const { listeners, openWindow } = loadServiceWorker();
    const close = vi.fn();
    const waitUntil = vi.fn();

    listeners.get('notificationclick')?.({ notification: { close }, waitUntil });

    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('/notifications');
  });
});
