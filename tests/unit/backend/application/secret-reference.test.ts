/** 秘密情報の参照名の検証（Issue #206。D-55）の単体テスト。パラメータストアのパスになるため、形式を限る。 */

import { describe, expect, it } from 'vitest';
import {
  isValidSecretReference,
  parseSecretReference,
} from '../../../../src/backend/application/secret-reference.ts';

describe('秘密情報の参照名', () => {
  it.each([
    'file-server/robot',
    'federation/orion',
    'web-push/vapid-private-key',
    'a',
    'file-server/robot.v2_main',
  ])('正しい形式: %s', (reference) => {
    expect(isValidSecretReference(reference)).toBe(true);
    expect(parseSecretReference(reference)).toBe(reference);
  });

  it.each([
    ['空', ''],
    ['先頭が /（絶対パス）', '/file-server/robot'],
    ['末尾が /', 'file-server/'],
    ['上の階層への移動（..）', 'file-server/../federation/orion'],
    ['.. だけ', '..'],
    ['空の階層（//）', 'file-server//robot'],
    ['大文字', 'File-Server/robot'],
    ['空白', 'file server/robot'],
    ['日本語', 'ファイル/robot'],
    ['階層が深すぎる（5 階層）', 'a/b/c/d/e'],
    ['1 階層の長さが 64 を超える', `a/${'x'.repeat(65)}`],
    ['先頭が記号（-）', '-file/robot'],
    ['先頭が記号（.）', 'file/.robot'],
  ])('不正: %s', (_name, reference) => {
    expect(isValidSecretReference(reference)).toBe(false);
    expect(() => parseSecretReference(reference)).toThrow('秘密情報の参照名が正しくありません');
  });

  it('境界: 1 階層 64 文字・4 階層は、有効', () => {
    expect(isValidSecretReference('x'.repeat(64))).toBe(true);
    expect(isValidSecretReference('a/b/c/d')).toBe(true);
  });

  it('不正な参照名のエラーは、参照名の値を、メッセージに含めない（秘密の値を誤って渡した場合に、出ないように）', () => {
    expect(() => parseSecretReference('Dummy-Secret-Value/xyz')).toThrow(
      /^秘密情報の参照名が正しくありません$/,
    );
  });
});
