/**
 * 秘密情報のポート（architecture.md 3.1 の SecretPort）。
 * 接続先の認証情報などは、設定には参照名のみを持ち、値はこのポートで読み出す（NFR-5.4）。
 * 実装: 環境変数（ローカル）。本番はシークレット管理サービス（TODO: インフラ確定後）。
 * 読み出した値を、ログ・画面・エラーメッセージに出さない。
 */
export interface SecretPort {
  /** 参照名に対応する秘密情報の値。未設定は undefined。 */
  get(reference: string): string | undefined;
}
