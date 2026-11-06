/** ファイルパス（ファイルサーバー〔HTTP〕の、取得するファイルのパス）のスキーマ。接続設定（ingestion.ts）と設備（equipment.ts）が使う。 */

import { z } from 'zod';

/** ファイルパス: / で始まるファイル 1 つ。クエリ・フラグメント・空白・.. ・% のエスケープは使えない。 */
export const FilePathSchema = z
  .string()
  .min(2, 'ファイルパスを入力してください')
  .max(500, 'ファイルパスは500文字以内で指定してください')
  .refine(
    (path) =>
      /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(path) &&
      !path.endsWith('/') &&
      path
        .split('/')
        .every(
          (segment, index) =>
            index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
        ),
    'ファイルパスは、/ で始まるファイル 1 つを、英数字と記号（. _ ~ - / など）で指定してください（..・?・#・空白・% は使えません）',
  );
