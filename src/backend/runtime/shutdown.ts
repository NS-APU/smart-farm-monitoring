/**
 * プロセスの終了処理（シグナル・未捕捉の例外）。終了の前に、サーバーを止め、未保存のデータを書き出す。
 * 停止処理の失敗は、ログに残し、非ゼロの終了コードにする（プロセス管理が、正常終了と誤認しないように。V-065）。
 * 未捕捉の例外・拒否でも、データを書き出してから終了する（直近の変更が失われることを減らす。V-047）。
 */

import { errorLogFields } from '../application/error-fields.ts';
import type { Logger } from '../application/ports/logger-port.ts';

/** `process` のうち、この処理が使う部分（テストで差し替える）。 */
export interface ProcessLike {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void,
  ): unknown;
  exit(code: number): unknown;
}

export interface StoppableServer {
  close(): Promise<void>;
}

/** シグナル・未捕捉の例外で、サーバーを止めてから終了するよう、ハンドラを登録する。 */
export function registerProcessHandlers(
  proc: ProcessLike,
  server: StoppableServer,
  logger: Logger,
): void {
  let stopping = false;

  async function stop(exitCodeOnSuccess: number): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await server.close();
      proc.exit(exitCodeOnSuccess);
    } catch (error) {
      logger.error('停止処理に失敗しました（データの書き込みに失敗した可能性があります）', {
        ...errorLogFields(error),
      });
      proc.exit(1);
    }
  }

  const onSignal = (): void => {
    void stop(0);
  };
  proc.once('SIGINT', onSignal);
  proc.once('SIGTERM', onSignal);

  const onFatal = (reason: unknown): void => {
    logger.error('未処理のエラーが発生しました。データを書き出して終了します', {
      ...errorLogFields(reason),
    });
    void stop(1);
  };
  proc.on('uncaughtException', onFatal);
  proc.on('unhandledRejection', onFatal);
}
