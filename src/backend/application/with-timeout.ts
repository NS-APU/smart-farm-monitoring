/**
 * 外部との通信（ファイルサーバー・農業情報基盤・Web Push）に、タイムアウトを設ける（coding-standards.md「エラーハンドリング」）。
 * 応答しない通信が、取り込み・連携・通知の処理全体（スケジューラ）を止め続けないようにする。
 * 時間の計測には、実際のタイマーを使う（ClockPort の sleep は、テストで待たずに進むため、タイムアウトに使えない）。
 * 通信そのものは、中止できない（ポートは、中止の信号を受けない）。タイムアウトした通信の結果は、捨てる。
 */

import { namedErrorClass } from './named-error.ts';

/** 指定の時間内に、完了しなかった。 */
export class OperationTimeoutError extends namedErrorClass('OperationTimeoutError') {}

/**
 * 処理を実行し、timeoutMs を超えて完了しなければ OperationTimeoutError で失敗させる。
 * timeoutMs が 0 以下なら、タイムアウトを設けない。
 */
export function withTimeout<Result>(
  operation: () => Promise<Result>,
  timeoutMs: number,
  description: string,
): Promise<Result> {
  if (timeoutMs <= 0) {
    return operation();
  }
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new OperationTimeoutError(
          `${description}が、${String(timeoutMs)}ミリ秒以内に完了しませんでした`,
        ),
      );
    }, timeoutMs);
    // 待機中のタイマーで、プロセスの終了を妨げない
    timer.unref();
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
