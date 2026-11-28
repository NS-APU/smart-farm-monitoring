/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の、S3 の保管先（createS3HostedFileStore）の単体テスト。
 * 実際の AWS には接続せず、クライアントの偽物で、送るコマンドの内容・見つからない場合・障害・キーの範囲を確かめる。
 */

import { describe, expect, it } from 'vitest';
import { createS3HostedFileStore } from '../../../../src/backend/infrastructure/s3/s3-hosted-file-store.ts';

const BUCKET = 'dummy-bucket';
const MODIFIED = new Date('2026-11-25T01:02:03.000Z');

/** SDK のコマンドの、必要な部分（クラス名と入力）だけ。テストが、SDK に依存しないようにする。 */
interface FakeCommand {
  readonly constructor: { readonly name: string };
  readonly input: { Bucket?: string; Key?: string; Body?: string; ContentType?: string };
}

function awsError(name: string): Error {
  return Object.assign(new Error('dummy aws error'), { name });
}

/** S3 の偽物。置かれたオブジェクトを持ち、呼ばれたコマンドを記録する。 */
function createFake() {
  const objects = new Map<string, string>();
  const commands: FakeCommand[] = [];
  let failWith: Error | undefined;
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async send(command: FakeCommand): Promise<unknown> {
      commands.push(command);
      if (failWith !== undefined) {
        throw failWith;
      }
      const { Key: key = '', Body: body } = command.input;
      const kind = command.constructor.name;
      if (kind === 'PutObjectCommand') {
        objects.set(key, body ?? '');
        return {};
      }
      const stored = objects.get(key);
      if (stored === undefined) {
        throw awsError(kind === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey');
      }
      const metadata = {
        LastModified: MODIFIED,
        ETag: '"dummy-etag"',
        ContentLength: Buffer.byteLength(stored, 'utf8'),
      };
      return kind === 'GetObjectCommand'
        ? { ...metadata, Body: { transformToString: () => Promise.resolve(stored) } }
        : metadata;
    },
  };
  return {
    client,
    objects,
    commands,
    failWith: (error: Error | undefined) => {
      failWith = error;
    },
  };
}

describe('S3 の保管先（createS3HostedFileStore）', () => {
  it('put: 設備ごとのパスを、接頭辞（files）つきのキーで、JSON として置く。get で、内容とメタデータを読める', async () => {
    const fake = createFake();
    const store = createS3HostedFileStore({ client: fake.client, bucket: BUCKET });

    await store.put('/robot/robot-a/latest.json', '{"a":1}');
    const file = await store.get('/robot/robot-a/latest.json');

    expect(fake.commands[0]?.constructor.name).toBe('PutObjectCommand');
    expect(fake.commands[0]?.input).toEqual({
      Bucket: BUCKET,
      Key: 'files/robot/robot-a/latest.json',
      Body: '{"a":1}',
      ContentType: 'application/json',
    });
    expect(file).toEqual({
      body: '{"a":1}',
      lastModified: MODIFIED,
      etag: '"dummy-etag"',
      size: 7,
    });
  });

  it('head: 内容を読まず、メタデータだけを返す（HeadObject）', async () => {
    const fake = createFake();
    const store = createS3HostedFileStore({ client: fake.client, bucket: BUCKET });
    await store.put('/robot/a.json', '{"a":1}');

    const metadata = await store.head('/robot/a.json');

    expect(fake.commands.at(-1)?.constructor.name).toBe('HeadObjectCommand');
    expect(metadata).toEqual({ lastModified: MODIFIED, etag: '"dummy-etag"', size: 7 });
    expect(metadata).not.toHaveProperty('body');
  });

  it('ファイルがないとき（NoSuchKey・NotFound）は undefined。ほかの失敗（権限・障害）は、そのまま投げる', async () => {
    const fake = createFake();
    const store = createS3HostedFileStore({ client: fake.client, bucket: BUCKET });

    expect(await store.get('/robot/none.json')).toBeUndefined();
    expect(await store.head('/robot/none.json')).toBeUndefined();

    fake.failWith(awsError('AccessDenied'));
    await expect(store.get('/robot/a.json')).rejects.toThrow('dummy aws error');
    await expect(store.head('/robot/a.json')).rejects.toThrow('dummy aws error');
    await expect(store.put('/robot/a.json', '{}')).rejects.toThrow('dummy aws error');
  });

  it('接頭辞の外を指せない: / で始まらない・.. を含む・空のパスは、保管先に送らず、拒否する', async () => {
    const fake = createFake();
    const store = createS3HostedFileStore({ client: fake.client, bucket: BUCKET });

    for (const path of ['robot/a.json', '/robot/../a.json', '/..', '', '/']) {
      await expect(store.put(path, '{}'), path).rejects.toThrow();
      await expect(store.get(path), path).rejects.toThrow();
      await expect(store.head(path), path).rejects.toThrow();
    }
    expect(fake.commands).toEqual([]);
  });
});

describe('S3 の応答の項目が欠けているとき', () => {
  /** 指定した応答を、そのまま返す偽物（更新日時・ETag・大きさ・本文が、ないことがある）。 */
  const clientReturning = (output: unknown) => ({ send: () => Promise.resolve(output) });

  it('更新日時がなければ 1970 年・ETag がなければ省略・大きさがなければ 0（head）。本文がなければ空（get）', async () => {
    const store = createS3HostedFileStore({ client: clientReturning({}), bucket: BUCKET });

    const head = await store.head('/robot/a.json');
    const get = await store.get('/robot/a.json');

    expect(head).toEqual({ lastModified: new Date(0), size: 0 });
    expect(head).not.toHaveProperty('etag');
    expect(get).toEqual({ lastModified: new Date(0), size: 0, body: '' });
  });

  it('大きさがなければ、本文のバイト数（get）。ETag があれば、そのまま返す', async () => {
    const store = createS3HostedFileStore({
      client: clientReturning({
        ETag: '"dummy-etag"',
        Body: { transformToString: () => Promise.resolve('{"日本語":1}') },
      }),
      bucket: BUCKET,
    });

    const get = await store.get('/robot/a.json');

    expect(get).toMatchObject({
      etag: '"dummy-etag"',
      size: Buffer.byteLength('{"日本語":1}', 'utf8'),
    });
  });
});
