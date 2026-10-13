/**
 * FileSourcePort の契約テスト（モックと、将来の実ファイルサーバーのアダプタ（Q-002）で共通に適用する。V-128）。
 * アダプタごとに、ファイルの用意・停止の再現を行う `ContractSubject` を渡す。
 * 契約: 一覧は更新日時の古い順（同時刻は名前の順）／ファイルの内容は UTF-8 のテキスト／大きさ（バイト）を返す／
 * 存在しないファイル・不正な識別子・停止中は FileSourceUnavailableError。
 * まだ決まっていない契約（取り込み元の場所がない場合の一覧・接続の暗号化と認証・タイムアウト）は、Q-002 の確定後に追加する。
 */

import { describe, expect, it } from 'vitest';
import {
  FileSourceUnavailableError,
  type FileSourcePort,
} from '../../src/backend/application/ports/file-source-port.ts';

export interface ContractSubject {
  readonly source: FileSourcePort;
  /** 取り込み元にファイルを用意する。modifiedAt は、更新日時。 */
  readonly putFile: (sourceId: string, name: string, content: string, modifiedAt: Date) => void;
  /** 接続できない状態にする。 */
  readonly setDown: () => void;
}

export function describeFileSourceContract(name: string, create: () => ContractSubject): void {
  describe(`FileSourcePort の契約（${name}）`, () => {
    const OLD = new Date('2026-10-09T01:00:00Z');
    const NEW = new Date('2026-10-09T02:00:00Z');

    it('一覧は、更新日時の古い順に、識別子・名前・更新日時・大きさ（バイト）を返す。同じ更新日時は名前の順', async () => {
      const { source, putFile } = create();
      putFile('robot', 'new.json', '{"n":1}', NEW);
      putFile('robot', 'b.json', '{}', OLD);
      putFile('robot', 'a.json', '{}', OLD);

      const files = await source.listFiles('robot');

      expect(files.map((file) => file.fileId)).toEqual(['a.json', 'b.json', 'new.json']);
      expect(files[2]).toMatchObject({ name: 'new.json', sizeBytes: 7 });
      expect(files[2]?.modifiedAt.getTime()).toBe(NEW.getTime());
    });

    it('ファイルの内容を、UTF-8 のテキストとして返す（日本語を含む）', async () => {
      const { source, putFile } = create();
      putFile('robot', 'jp.json', '{"名前":"収穫ロボット"}', OLD);

      expect(await source.readFile('robot', 'jp.json')).toBe('{"名前":"収穫ロボット"}');
    });

    it('存在しないファイル・取り込み元の外へ出る識別子は、FileSourceUnavailableError で失敗する', async () => {
      const { source, putFile } = create();
      putFile('robot', 'a.json', '{}', OLD);

      await expect(source.readFile('robot', 'none.json')).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
      await expect(source.readFile('robot', '../a.json')).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
      await expect(source.listFiles('../robot')).rejects.toBeInstanceOf(FileSourceUnavailableError);
    });

    it('停止中は、接続テスト・一覧・読み取りのすべてが、FileSourceUnavailableError で失敗する', async () => {
      const { source, putFile, setDown } = create();
      putFile('robot', 'a.json', '{}', OLD);

      setDown();

      await expect(source.testConnection('robot')).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
      await expect(source.listFiles('robot')).rejects.toBeInstanceOf(FileSourceUnavailableError);
      await expect(source.readFile('robot', 'a.json')).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
    });

    it('取り込み元がある場合、接続テストは成功する', async () => {
      const { source, putFile } = create();
      putFile('robot', 'a.json', '{}', OLD);

      await expect(source.testConnection('robot')).resolves.toBeUndefined();
    });
  });
}
