/**
 * 時計のポート。現在時刻・待機を差し替え可能にし、テストで時刻を固定・進行できるようにする
 * （architecture.md 14章、coding-standards.md「テスト」）。
 */
export interface ClockPort {
  now(): Date;
  /** 指定した時間（ミリ秒）待つ。固定時計では、待たずに時刻だけを進める。 */
  sleep(milliseconds: number): Promise<void>;
}
