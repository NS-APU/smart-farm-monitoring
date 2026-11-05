/** 観測値の一覧の、並べ替え・キーワード検索で必須の期間（31 日以内）の判定（#91。ADR-0007 の判断）の単体テスト。 */

import { describe, expect, it } from 'vitest';
import {
  checkListPeriod,
  LIST_PERIOD_GUIDANCE,
  MAX_LIST_PERIOD_DAYS,
  requiresListPeriod,
} from '@smart-farm/shared/observation-list-period';
import { MS_PER_DAY } from '@smart-farm/shared/time';

const FROM = '2026-10-01T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(FROM) + ms).toISOString();

describe('requiresListPeriod（期間が必須の操作か）', () => {
  it('計測日時の順で、キーワードがなければ、不要（全期間をページで送れる）', () => {
    expect(requiresListPeriod({ sort: 'observedAt' })).toBe(false);
    expect(requiresListPeriod({ sort: 'observedAt', keyword: '' })).toBe(false);
    expect(requiresListPeriod({ sort: 'observedAt', keyword: '   ' })).toBe(false);
  });

  it('値・カテゴリの順、または、キーワード（空白だけは除く）があれば、必要', () => {
    expect(requiresListPeriod({ sort: 'value' })).toBe(true);
    expect(requiresListPeriod({ sort: 'category' })).toBe(true);
    expect(requiresListPeriod({ sort: 'observedAt', keyword: '収穫' })).toBe(true);
  });
});

describe('checkListPeriod（期間の判定）', () => {
  it('上限は 31 日', () => {
    expect(MAX_LIST_PERIOD_DAYS).toBe(31);
  });

  it('開始・終了の両方がなければ、MISSING（片方だけでも）', () => {
    expect(checkListPeriod({})).toBe('MISSING');
    expect(checkListPeriod({ from: FROM })).toBe('MISSING');
    expect(checkListPeriod({ to: FROM })).toBe('MISSING');
  });

  it('境界: ちょうど 31 日は、有効（null）。1 ミリ秒でも超えたら、TOO_LONG', () => {
    expect(checkListPeriod({ from: FROM, to: at(31 * MS_PER_DAY) })).toBeNull();
    expect(checkListPeriod({ from: FROM, to: at(31 * MS_PER_DAY + 1) })).toBe('TOO_LONG');
  });

  it('短い期間・同じ日時は、有効', () => {
    expect(checkListPeriod({ from: FROM, to: FROM })).toBeNull();
    expect(checkListPeriod({ from: FROM, to: at(MS_PER_DAY) })).toBeNull();
  });

  it('案内の文言に、31 日を含む', () => {
    expect(LIST_PERIOD_GUIDANCE).toBe('並べ替え・検索は、期間（31 日以内）を指定してください');
  });
});
