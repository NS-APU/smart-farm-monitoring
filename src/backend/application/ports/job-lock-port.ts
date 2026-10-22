/**
 * ジョブの排他（リース式ロック）のポート（Issue #76。ADR-0011）。
 * Lambda では、EventBridge の起動が、前回の実行の終了前に重なったり、再配信されたりして、同じジョブが同時に動くことがある。
 * 同時に動くと、通知の配信（Web Push）・農業情報基盤への連携が、二重になる。ジョブは、実行の前に、ロックを取る。
 * ロックには、期限（リース）がある。実行が異常終了して、解放されなくても、期限を過ぎれば、次の実行が取れる。
 */

/** 取得したロック。実行が終わったら、解放する。 */
export interface JobLease {
  /** 解放する。期限が過ぎて、別の実行に取られていた場合は、何もしない（他の実行のロックを、消さない）。 */
  release(): Promise<void>;
}

export interface JobLockPort {
  /**
   * ロックを取る。取れたら、リースを返す。ほかの実行が（期限内に）持っていれば、待たずに null を返す。
   * @param key ロックの名前（例: `job:JB-04`）
   * @param leaseMs ロックの期限（ミリ秒）。実行の最大の時間より長くする
   */
  tryAcquire(key: string, leaseMs: number): Promise<JobLease | null>;
}
