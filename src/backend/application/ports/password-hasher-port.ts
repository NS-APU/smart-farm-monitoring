/**
 * パスワードのハッシュ化のポート。ユーザー管理（UC-14）で、パスワードを保存するときに使う。
 * 平文のパスワードは保存・ログ出力しない（FR-9.2）。実装: ローカルは scrypt（infrastructure/local）。
 * Cognito へ移行した場合、パスワードは Cognito が持つため、このポートは使わない。
 */
export interface PasswordHasherPort {
  hash(password: string): string;
}
