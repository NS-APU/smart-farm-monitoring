/** ローカルのデータ保持（コレクション）のテスト。 */

import { describe, expect, it } from 'vitest';
import { createLocalStore } from '../../../../src/backend/infrastructure/local/local-store.ts';
import { z } from 'zod';

describe('ローカルのデータ保持（コレクション）', () => {
  it('値の追加・取得・削除ができ、件数を数える。存在しない値の削除は false', () => {
    const store = createLocalStore();
    const collection = store.collection('items', z.object({ id: z.string() }), (item) => item.id);

    collection.put({ id: 'a' });
    collection.put({ id: 'b' });

    expect(collection.size).toBe(2);
    expect(collection.get('a')).toEqual({ id: 'a' });
    expect(collection.delete('a')).toBe(true);
    expect(collection.delete('a')).toBe(false);
    expect(collection.values()).toEqual([{ id: 'b' }]);
    // ファイルを持たないストアは、保存も読み込みも何もしない
    store.flush();
    store.load();
    expect(collection.size).toBe(1);
  });
});
