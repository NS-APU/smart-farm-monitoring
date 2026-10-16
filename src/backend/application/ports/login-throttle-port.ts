/**
 * ログインの試行回数の制限のポート（FR-9.2。同じ接続元から、15 分あたり、失敗が 5 回に達したら、一時的に拒否する）。
 * Lambda のように、複数の実行環境が、同じ制限を共有する必要がある実装（Cognito）が使う。
 * ローカルの認証は、プロセス内で制限を持つ（infrastructure/local/local-auth.ts）。
 */
export interface LoginThrottlePort {
  /** 制限を超えている（ログインを、拒否する）か。 */
  isLocked(clientKey: string): Promise<boolean>;
  recordFailure(clientKey: string): Promise<void>;
  /** ログインに成功したら、失敗の回数をリセットする。 */
  reset(clientKey: string): Promise<void>;
}
