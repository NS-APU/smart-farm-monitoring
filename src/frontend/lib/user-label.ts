/**
 * 入力者・変更者の表示（Issue #154 の SC-07-7。FR-4.2.1・FR-4.2.3）: 「ユーザー名（ID）」。
 * ユーザー名は、API が、現在のユーザー名から付ける。引けない（削除済みの利用者・古い応答）ときは、ID だけを示す。
 */

export function userLabel(userId: string, userName: string | undefined): string {
  return userName === undefined || userName === '' ? userId : `${userName}（${userId}）`;
}
