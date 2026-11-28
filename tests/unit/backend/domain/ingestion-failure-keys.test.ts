/**
 * 取り込みの失敗・停止の通知の、重複の抑制の単位「失敗の項目」（ADR-0019 の D-38。Issue #589）の単体テスト。
 * 同じ項目が続く間は、再通知しない。新しい項目（設備・理由が増える・変わる）があるときだけ、通知する。回復した項目は、記録から消す。
 */

import { describe, expect, it } from 'vitest';
import {
  equipmentIdOfIngestionFailureKey,
  ingestionFailureKey,
  newIngestionFailureKeys,
  remainingIngestionFailureKeys,
} from '../../../../src/backend/domain/notification-rules.ts';

describe('失敗の項目のキー', () => {
  it('表示の文言ではなく、種類・設備・理由の区分から作る', () => {
    expect(ingestionFailureKey.listing('ファイルサーバーに接続できませんでした')).toBe(
      'LISTING:ファイルサーバーに接続できませんでした',
    );
    expect(ingestionFailureKey.unexpected()).toBe('UNEXPECTED');
    expect(ingestionFailureKey.file('FORMAT')).toBe('FILE:FORMAT');
    expect(ingestionFailureKey.equipment('ROBOT-1', '認証に失敗しました')).toBe(
      'EQUIPMENT:ROBOT-1:認証に失敗しました',
    );
    expect(ingestionFailureKey.stoppedEquipment('ROBOT-1')).toBe('EQUIPMENT:ROBOT-1');
  });
});

describe('新しい失敗の項目（通知するか）', () => {
  it('記録がなければ、すべて新しい（通知する）', () => {
    expect(newIngestionFailureKeys([], ['A', 'B'])).toEqual(['A', 'B']);
  });

  it('記録済みの項目だけなら、新しい項目はない（通知しない）', () => {
    expect(newIngestionFailureKeys(['A', 'B'], ['B', 'A'])).toEqual([]);
    expect(newIngestionFailureKeys(['A', 'B'], ['A'])).toEqual([]);
  });

  it('記録にない項目（設備が増えた・理由が変わった）があれば、それだけを返す', () => {
    expect(newIngestionFailureKeys(['A'], ['A', 'B'])).toEqual(['B']);
    expect(newIngestionFailureKeys(['EQUIPMENT:R1:接続'], ['EQUIPMENT:R1:認証'])).toEqual([
      'EQUIPMENT:R1:認証',
    ]);
  });

  it('同じ項目が重なっていても、1 回だけ返す', () => {
    expect(newIngestionFailureKeys([], ['A', 'A'])).toEqual(['A']);
  });
});

describe('回復した失敗の項目（記録から消す）', () => {
  const active = new Set(['A']);

  it('いま失敗している項目は残す。回復した（調べた範囲で、失敗していない）項目は消す', () => {
    expect(remainingIngestionFailureKeys(['A', 'B'], active, () => true)).toEqual(['A']);
  });

  it('調べていない範囲の項目（今回の実行の対象外の設備）は、失敗していなくても残す', () => {
    expect(
      remainingIngestionFailureKeys(['A', 'EQUIPMENT:R2:接続'], active, (key) => key === 'A'),
    ).toEqual(['A', 'EQUIPMENT:R2:接続']);
  });

  it('すべて回復すると、空になる（記録を削除できる）', () => {
    expect(remainingIngestionFailureKeys(['A', 'B'], new Set(), () => true)).toEqual([]);
  });
});

describe('設備の項目のキーから、設備の ID を取り出す', () => {
  it('設備ごとの失敗・停止の項目から、設備の ID を取り出す。それ以外の項目は、undefined', () => {
    expect(
      equipmentIdOfIngestionFailureKey(
        ingestionFailureKey.equipment('ROBOT-1', '認証に失敗しました'),
      ),
    ).toBe('ROBOT-1');
    expect(equipmentIdOfIngestionFailureKey(ingestionFailureKey.stoppedEquipment('ROBOT-1'))).toBe(
      'ROBOT-1',
    );
    expect(equipmentIdOfIngestionFailureKey(ingestionFailureKey.listing('理由'))).toBeUndefined();
    expect(equipmentIdOfIngestionFailureKey(ingestionFailureKey.unexpected())).toBeUndefined();
    expect(equipmentIdOfIngestionFailureKey(ingestionFailureKey.file('FORMAT'))).toBeUndefined();
  });
});
