/**
 * 資格情報（パスワード）の管理のポート。ユーザー管理（UC-14。FR-9.4）が使う。
 * 「誰か」の確認（AuthPort）とは別に、資格情報を、どこが持つかを差し替えられるようにする。
 * - ローカル: パスワードのハッシュを、ユーザーの記録（UserRecord）に持つ（infrastructure/local）
 * - Cognito: パスワードは Cognito が持つ。ユーザーの記録には、持たない（infrastructure/cognito。ADR-0008）
 * 平文のパスワードは、保存・ログ出力しない（FR-9.2）。
 */

import type { UserId } from '@smart-farm/shared/schemas/common';

/** ユーザーの記録（UserRecord）に、追加で保存する値。資格情報を、記録の外に持つ実装は、空。 */
export interface StoredCredential {
  readonly passwordHash?: string;
}

export interface CredentialPort {
  /** 新しいユーザーの資格情報を作る（パスワードを設定する）。 */
  register(userId: UserId, password: string): Promise<StoredCredential>;
  /** パスワードを再設定する。 */
  reset(userId: UserId, password: string): Promise<StoredCredential>;
  /** ユーザーの資格情報を削除する。なければ、何もしない。 */
  remove(userId: UserId): Promise<void>;
}
