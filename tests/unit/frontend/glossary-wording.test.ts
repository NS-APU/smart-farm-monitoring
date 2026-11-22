/**
 * 画面の文言の用語の統一（用語集「画面での呼び方」。Issue #154）の単体テスト。
 * 画面に出す文言（`MESSAGES`）に、画面では使わない言葉（内部用語）を含めない。
 */

import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../../src/frontend/i18n/messages.ts';

/** 画面に出さない内部用語と、画面での呼び方。 */
const FORBIDDEN_TERMS = [
  {
    term: '論理削除',
    screenTerm: '「削除したデータは、一覧と集計の対象から外れます」の趣旨で書く',
  },
  { term: 'メトリクス', screenTerm: '「指標」' },
] as const;

/** 文言の木から、文字列を集める（関数は、文言の組み立てなので、対象外）。 */
function collectStrings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, `${path}.${key}`, out);
    }
  }
}

describe('画面の文言の用語（用語集「画面での呼び方」）', () => {
  const strings: { path: string; text: string }[] = [];
  collectStrings(MESSAGES, 'MESSAGES', strings);

  it('文言を集められている（検査が空振りしていない）', () => {
    expect(strings.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN_TERMS)(
    '画面の文言に「$term」を使わない（画面では $screenTerm）',
    ({ term }) => {
      const found = strings.filter((entry) => entry.text.includes(term)).map((entry) => entry.path);

      expect(found).toEqual([]);
    },
  );
});
