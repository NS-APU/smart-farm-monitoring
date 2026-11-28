/**
 * 入力者・変更者の表示（Issue #154 の SC-07-7。FR-4.2.1・FR-4.2.3）: 「ユーザー名（ID）」。名前がなければ、ID だけ。
 */

import { describe, expect, it } from 'vitest';
import { userLabel } from '../../../src/frontend/lib/user-label.ts';

describe('userLabel', () => {
  it('ユーザー名があれば、「ユーザー名（ID）」にする', () => {
    expect(userLabel('worker-1', '作業者1')).toBe('作業者1（worker-1）');
  });

  it.each([
    ['ユーザー名がない（削除済みの利用者・古い応答）', undefined],
    ['ユーザー名が空', ''],
  ])('%s: ID だけを示す', (_name, userName) => {
    expect(userLabel('worker-1', userName)).toBe('worker-1');
  });

  it('長いユーザー名・ID も、そのまま連結する（折り返しは、表示側）', () => {
    const name = '名'.repeat(200);
    const id = 'a'.repeat(100);

    expect(userLabel(id, name)).toBe(`${name}（${id}）`);
  });
});
