/**
 * ファイルサーバーのモックの S3 版（Issue #77。ADR-0012）のテスト。FileSourcePort の契約テストと、S3 固有の振る舞い
 * （続きの取得・直下のオブジェクトだけ・AWS のエラーの扱い）。S3 は偽の S3（実際の AWS には、接続しない）。
 */

import { describe, expect, it } from 'vitest';
import { FileSourceUnavailableError } from '../../src/backend/application/ports/file-source-port.ts';
import { createS3FileSource } from '../../src/backend/infrastructure/s3/s3-file-source.ts';
import { describeFileSourceContract } from '../support/file-source-contract.ts';
import { createFakeS3 } from '../support/fake-s3.ts';

const BUCKET = 'dummy-file-server';
const MODIFIED = new Date('2026-10-09T01:00:00Z');

function setup(pageSize?: number) {
  const s3 = createFakeS3({ bucket: BUCKET, ...(pageSize === undefined ? {} : { pageSize }) });
  const source = createS3FileSource({ client: s3, bucket: BUCKET });
  return { s3, source };
}

describeFileSourceContract('S3 のファイルサーバーのモック（偽の S3）', () => {
  const { s3, source } = setup();
  return {
    source,
    putFile(sourceId, name, content, modifiedAt) {
      s3.putObject(`${sourceId}/${name}`, content, modifiedAt);
    },
    setDown() {
      s3.setDown();
    },
  };
});

describe('S3 のファイルサーバーのモック（S3 固有の振る舞い）', () => {
  it('1 回の一覧に収まらない件数でも、続きを取って、すべて返す', async () => {
    const { s3, source } = setup(2);
    for (let index = 0; index < 5; index += 1) {
      s3.putObject(`robot/file-${String(index)}.json`, '{}', MODIFIED);
    }

    const files = await source.listFiles('robot');

    expect(files.map((file) => file.fileId)).toEqual([
      'file-0.json',
      'file-1.json',
      'file-2.json',
      'file-3.json',
      'file-4.json',
    ]);
    // 2 件ずつ、3 回に分けて取った
    expect(s3.calls.filter((call) => call.command === 'ListObjectsV2Command')).toHaveLength(3);
  });

  it('取り込み元の直下のファイルだけを返す。別の取り込み元・より深い場所・「ディレクトリ」を表すオブジェクトは、含めない', async () => {
    const { s3, source } = setup();
    s3.putObject('robot/a.json', '{}', MODIFIED);
    s3.putObject('robot/sub/b.json', '{}', MODIFIED);
    s3.putObject('robot/', '', MODIFIED);
    s3.putObject('robot-other/c.json', '{}', MODIFIED);
    s3.putObject('environment-sensor/d.csv', 'x', MODIFIED);

    const files = await source.listFiles('robot');

    expect(files.map((file) => file.fileId)).toEqual(['a.json']);
  });

  it('ファイルがない取り込み元は、空の一覧を返す。接続テストは、バケットを一覧できれば成功する', async () => {
    const { source } = setup();

    expect(await source.listFiles('robot')).toEqual([]);
    await expect(source.testConnection('robot')).resolves.toBeUndefined();
  });

  it('AWS のエラーは、FileSourceUnavailableError にする。利用者に見せる文言に、AWS の情報を含めず、原因は cause に残す', async () => {
    const s3 = createFakeS3({ bucket: BUCKET });
    // バケットが存在しない（設定の誤り）
    const wrongBucket = createS3FileSource({ client: s3, bucket: 'other-bucket' });

    const listing = await wrongBucket.listFiles('robot').catch((error: unknown) => error);
    const reading = await wrongBucket.readFile('robot', 'a.json').catch((error: unknown) => error);
    const connection = await wrongBucket.testConnection('robot').catch((error: unknown) => error);

    for (const error of [listing, reading, connection]) {
      expect(error).toBeInstanceOf(FileSourceUnavailableError);
      expect((error as Error).message).toBe('ファイルサーバーに接続できません');
      expect(((error as Error).cause as Error).name).toBe('NoSuchBucket');
    }
  });

  it('存在しないファイルは「見つかりません」、取得の本文がないときは「読めませんでした」で失敗する', async () => {
    const { s3, source } = setup();

    await expect(source.readFile('robot', 'none.json')).rejects.toThrow('ファイルが見つかりません');

    const bodyless = createS3FileSource({
      client: { send: () => Promise.resolve({}) } as never,
      bucket: BUCKET,
    });
    await expect(bodyless.readFile('robot', 'a.json')).rejects.toThrow(
      'ファイルを読めませんでした',
    );
    expect(s3.calls).toHaveLength(1);
  });

  it.each(['', '.', '..', 'a/b.json', '../a.json'])(
    '取り込み元の外へ出うるファイルの識別子（%j）は、S3 を呼ばずに拒否する',
    async (fileId) => {
      const { s3, source } = setup();

      await expect(source.readFile('robot', fileId)).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
      expect(s3.calls).toHaveLength(0);
    },
  );

  it.each(['../robot', 'Robot', '', 'a/b', '-robot'])(
    '不正な取り込み元の識別子（%j）は、S3 を呼ばずに拒否する',
    async (sourceId) => {
      const { s3, source } = setup();

      await expect(source.listFiles(sourceId)).rejects.toBeInstanceOf(FileSourceUnavailableError);
      await expect(source.testConnection(sourceId)).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
      expect(s3.calls).toHaveLength(0);
    },
  );
});
