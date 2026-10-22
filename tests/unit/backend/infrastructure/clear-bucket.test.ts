import { describe, expect, it } from 'vitest';
import { clearBucket } from '../../../../src/backend/infrastructure/s3/clear-bucket.ts';
import { createFakeS3 } from '../../../support/fake-s3.ts';

const BUCKET = 'dummy-file-server';
const MODIFIED = new Date('2026-10-20T00:00:00Z');

function setup(pageSize?: number) {
  const s3 = createFakeS3({ bucket: BUCKET, ...(pageSize === undefined ? {} : { pageSize }) });
  for (let index = 0; index < 5; index += 1) {
    s3.putObject(`robot/file-${String(index)}.json`, '{}', MODIFIED);
  }
  s3.putObject('environment-sensor/a.csv', 'x', MODIFIED);
  return s3;
}

describe('S3 のバケットを空にする（Issue #77）', () => {
  it('すべてのオブジェクトを消し、消した件数を返す。1 回の一覧に収まらないときは、続きを取って、まとめて消す', async () => {
    const s3 = setup(2);

    const count = await clearBucket(s3, BUCKET);

    expect(count).toBe(6);
    expect(s3.keys()).toEqual([]);
    // 2 件ずつ、3 回に分けて、一覧して、消した
    expect(s3.calls.filter((call) => call.command === 'DeleteObjectsCommand')).toHaveLength(3);
  });

  it('dryRun なら、消さずに、件数だけを数える', async () => {
    const s3 = setup();

    const count = await clearBucket(s3, BUCKET, { dryRun: true });

    expect(count).toBe(6);
    expect(s3.keys()).toHaveLength(6);
    expect(s3.calls.some((call) => call.command === 'DeleteObjectsCommand')).toBe(false);
  });

  it('空のバケットは、0 件。削除を呼ばない', async () => {
    const s3 = createFakeS3({ bucket: BUCKET });

    expect(await clearBucket(s3, BUCKET)).toBe(0);
    expect(s3.calls.some((call) => call.command === 'DeleteObjectsCommand')).toBe(false);
  });

  it('一部のオブジェクトを消せなかったときは、エラーにする（残ったファイルが、取り込まれ続けるため）', async () => {
    const s3 = setup();
    s3.failDeletes();

    await expect(clearBucket(s3, BUCKET)).rejects.toThrow('一部を、削除できませんでした');
  });

  it('バケットがない（設定の誤り）ときは、そのエラーを伝える', async () => {
    const s3 = createFakeS3({ bucket: BUCKET });

    await expect(clearBucket(s3, 'other-bucket')).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });
});
