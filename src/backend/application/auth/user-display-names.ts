/**
 * 入力者・変更者の表示名の解決（Issue #154 の SC-07-7。FR-4.2.1・FR-4.2.3）。
 * 画面の「入力者」「変更者」を「ユーザー名（ID）」で出せるよう、読み取りの応答を作るサービスが、ユーザー ID から、現在のユーザー名を引く。
 * 履歴・入力には、変更時点の名前を保存しない（ユーザー名を変えると、過去の入力・履歴も、現在のユーザー名で出る）。
 * 削除済みの利用者は、名前を引けない（応答に、表示名の項目を出さない。画面は、ユーザー ID だけを表示する）。
 * ユーザーの一覧は、応答ごとに 1 回だけ読む（利用者は約 10 名の想定）。応答に、引く対象がなければ、読まない。
 */

import type { UserRepository } from '../ports/repositories.ts';

/** ユーザー ID から、現在のユーザー名を引く。削除済み・存在しない利用者は undefined。 */
export type UserNameLookup = (userId: string) => string | undefined;

/** 利用者の一覧を 1 回読んで、ユーザー ID から、現在のユーザー名を引く関数を返す。 */
export async function loadUserNames(users: Pick<UserRepository, 'list'>): Promise<UserNameLookup> {
  const names = new Map<string, string>(
    (await users.list()).map((user) => [user.userId, user.userName]),
  );
  return (userId) => names.get(userId);
}
