/** プロセスの終了処理（レビュー V-047・V-065）のテスト。 */

import { describe, expect, it, vi } from 'vitest';
import { NULL_LOGGER } from '../../../../src/backend/application/ports/logger-port.ts';
import { registerProcessHandlers } from '../../../../src/backend/runtime/shutdown.ts';

describe('プロセスの終了処理（V-047・V-065）', () => {
  function setup(closeResult: () => Promise<void> = () => Promise.resolve()) {
    const handlers = new Map<string, (reason?: unknown) => void>();
    const exits: number[] = [];
    const errors: { message: string; fields?: unknown }[] = [];
    const proc = {
      once: (event: string, listener: () => void) => handlers.set(event, listener),
      on: (event: string, listener: (reason: unknown) => void) => handlers.set(event, listener),
      exit: (code: number) => {
        exits.push(code);
      },
    };
    const close = vi.fn(closeResult);
    registerProcessHandlers(
      proc,
      { close },
      {
        ...NULL_LOGGER,
        error: (message, fields) => errors.push({ message, fields }),
      },
    );
    return { handlers, exits, errors, close };
  }

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it.each(['SIGINT', 'SIGTERM'])(
    '%s: サーバーを止め（データを書き出し）、終了コード 0 で終了する',
    async (signal) => {
      const { handlers, exits, close } = setup();

      handlers.get(signal)?.();
      await settle();

      expect(close).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([0]);
    },
  );

  it('停止処理（データの書き込み）が失敗したら、ログに残し、非ゼロの終了コードで終了する', async () => {
    const { handlers, exits, errors } = setup(() => Promise.reject(new Error('書き込みに失敗')));

    handlers.get('SIGTERM')?.();
    await settle();

    expect(exits).toEqual([1]);
    expect(errors[0]?.message).toContain('停止処理に失敗しました');
    expect(errors[0]?.fields).toMatchObject({ errorMessage: '書き込みに失敗' });
  });

  it.each(['uncaughtException', 'unhandledRejection'])(
    '%s: ログに残し、データを書き出してから、終了コード 1 で終了する。重ねて起きても、1回だけ処理する',
    async (event) => {
      const { handlers, exits, errors, close } = setup();

      handlers.get(event)?.(new TypeError('想定外'));
      handlers.get('uncaughtException')?.(new TypeError('重ねて'));
      await settle();

      expect(errors[0]).toMatchObject({
        message: '未処理のエラーが発生しました。データを書き出して終了します',
        fields: { errorName: 'TypeError', errorMessage: '想定外' },
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([1]);
    },
  );
});
