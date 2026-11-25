/**
 * ファイルを置く保管先（HostedFileStorePort。Issue #565）の、ローカル・テスト用のメモリ実装の単体テスト。
 * 書き込みの日時は、時計から取る。置き直すと置き換わり、ETag が変わる。ファイルがなければ undefined。
 */

import { describe, expect, it } from 'vitest';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createMemoryHostedFileStore } from '../../../../src/backend/infrastructure/local/memory-hosted-file-store.ts';

describe('メモリの保管先（createMemoryHostedFileStore）', () => {
  it('ファイルがなければ、head・get は undefined', async () => {
    const store = createMemoryHostedFileStore(
      createControllableClock(new Date('2026-11-25T01:00:00Z')),
    );

    expect(await store.head('/robot/a.json')).toBeUndefined();
    expect(await store.get('/robot/a.json')).toBeUndefined();
  });

  it('置いたファイルを、内容・更新日時（時計の時刻）・大きさ・ETag つきで読める。head は、本文を含めない', async () => {
    const clock = createControllableClock(new Date('2026-11-25T01:00:00Z'));
    clock.freeze(new Date('2026-11-25T01:00:00Z'));
    const store = createMemoryHostedFileStore(clock);

    await store.put('/robot/a.json', '{"日本語":1}');
    const head = await store.head('/robot/a.json');
    const get = await store.get('/robot/a.json');

    expect(head).toMatchObject({
      lastModified: new Date('2026-11-25T01:00:00Z'),
      size: Buffer.byteLength('{"日本語":1}', 'utf8'),
    });
    expect(head).not.toHaveProperty('body');
    expect(get?.body).toBe('{"日本語":1}');
  });

  it('同じパスに置き直すと、内容・更新日時・ETag が変わる。別のパスは、変わらない', async () => {
    const clock = createControllableClock(new Date('2026-11-25T01:00:00Z'));
    clock.freeze(new Date('2026-11-25T01:00:00Z'));
    const store = createMemoryHostedFileStore(clock);
    await store.put('/robot/a.json', '{"v":1}');
    await store.put('/robot/b.json', '{"v":9}');
    const first = await store.head('/robot/a.json');
    clock.freeze(new Date('2026-11-25T01:05:00Z'));

    await store.put('/robot/a.json', '{"v":2}');
    const second = await store.head('/robot/a.json');

    expect((await store.get('/robot/a.json'))?.body).toBe('{"v":2}');
    expect((await store.get('/robot/b.json'))?.body).toBe('{"v":9}');
    expect(second?.lastModified).toEqual(new Date('2026-11-25T01:05:00Z'));
    expect(second?.etag).not.toBe(first?.etag);
  });
});
