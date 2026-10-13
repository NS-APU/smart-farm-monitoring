/**
 * データファイル（ローカルの永続化）とロガーの堅牢性（レビュー V-048・V-069・V-142・V-194）のテスト。
 * プロセスの終了処理（V-047・V-065）は tests/unit/backend/runtime/process-shutdown.test.ts、
 * アクセスログ（V-099）は tests/integration/access-log.test.ts にある（層ごとに分けている）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createJsonLogger } from '../../../../src/backend/infrastructure/logging/json-logger.ts';
import {
  LocalStoreError,
  createLocalStore,
} from '../../../../src/backend/infrastructure/local/local-store.ts';

const ItemSchema = z.object({ id: z.string(), value: z.number() });
type Item = z.infer<typeof ItemSchema>;

function newDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'smart-farm-store-'));
}

function openStore(filePath: string, extra: { onFlushError?: (error: unknown) => void } = {}) {
  const store = createLocalStore({ filePath, flushDelayMs: 5, ...extra });
  const items = store.collection<Item>('items', ItemSchema, (item) => item.id);
  return { store, items };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('データファイルの読み込み（V-048）', () => {
  it('版が、このアプリより新しいファイルは、読み込まず、原因を示すエラーにする。元のファイルは残し、控えを作る', () => {
    const directory = newDirectory();
    const filePath = join(directory, 'store.json');
    writeFileSync(filePath, JSON.stringify({ version: 99, collections: {} }), 'utf8');
    const { store } = openStore(filePath);

    expect(() => {
      store.load();
    }).toThrow(LocalStoreError);
    expect(() => {
      store.load();
    }).toThrow('版');

    expect(existsSync(filePath)).toBe(true);
    expect(readdirSync(directory).some((name) => name.startsWith('store.json.corrupt-'))).toBe(
      true,
    );
  });

  it('壊れたファイル（JSON でない・値がスキーマに合わない）は、明確なエラーにし、控えを残す（自動では消さない）', () => {
    const invalidJson = join(newDirectory(), 'store.json');
    writeFileSync(invalidJson, '{broken', 'utf8');
    const invalidValue = join(newDirectory(), 'store.json');
    writeFileSync(
      invalidValue,
      JSON.stringify({ version: 1, collections: { items: [{ id: 1 }] } }),
      'utf8',
    );

    expect(() => {
      openStore(invalidJson).store.load();
    }).toThrow('データファイルを読み込めません');
    expect(() => {
      openStore(invalidValue).store.load();
    }).toThrow(LocalStoreError);
    expect(existsSync(invalidJson)).toBe(true);
  });

  it('版が現在と同じ、または版の記載がないファイルは読み込める', () => {
    const filePath = join(newDirectory(), 'store.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, collections: { items: [{ id: 'a', value: 1 }] } }),
      'utf8',
    );
    const { store, items } = openStore(filePath);

    store.load();

    expect(items.get('a')).toEqual({ id: 'a', value: 1 });
  });
});

describe('データファイルの権限（V-142）', () => {
  it.skipIf(process.platform === 'win32')(
    'データファイルは所有者のみ、ディレクトリも所有者のみが読み書きできる権限で作る',
    () => {
      const directory = join(newDirectory(), 'data');
      const filePath = join(directory, 'store.json');
      const { store, items } = openStore(filePath);

      items.put({ id: 'a', value: 1 });
      store.flush();

      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    },
  );
});

describe('書き込みの失敗（V-194）', () => {
  it('タイマーでの書き込みが失敗しても、例外でプロセスを落とさず、通知して、メモリ上の変更を保持し、再び書き込む', () => {
    vi.useFakeTimers();
    const directory = newDirectory();
    // ファイルのあるべき場所にディレクトリを置いて、置き換え（rename）を失敗させる
    const filePath = join(directory, 'store.json');
    mkdirSync(filePath);
    const errors: unknown[] = [];
    const { store, items } = openStore(filePath, {
      onFlushError: (error) => errors.push(error),
    });

    items.put({ id: 'a', value: 1 });
    expect(() => vi.advanceTimersByTime(5)).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(items.get('a')).toEqual({ id: 'a', value: 1 });

    // 原因が解消すれば、次の再試行で書き込まれる（待ち時間は広がる）
    errors.length = 0;
    vi.advanceTimersByTime(40);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    store.clear();
  });

  it('onFlushError がなくても、タイマーの失敗で例外を投げない。明示的な flush は、失敗を呼び出し元へ伝える', () => {
    vi.useFakeTimers();
    const filePath = join(newDirectory(), 'store.json');
    mkdirSync(filePath);
    const { store, items } = openStore(filePath);

    items.put({ id: 'a', value: 1 });

    expect(() => vi.advanceTimersByTime(5)).not.toThrow();
    expect(() => {
      store.flush();
    }).toThrow();
  });
});

describe('ロガー（V-069）', () => {
  function capture() {
    const lines: string[] = [];
    const logger = createJsonLogger({ sink: { write: (line) => lines.push(line) } });
    return { lines, logger };
  }

  it('ネストした秘密情報（ヘッダーの authorization など）も、値をマスクする', () => {
    const { lines, logger } = capture();

    logger.info('x', { request: { headers: { authorization: 'Bearer abc', accept: 'json' } } });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      request: { headers: { authorization: '[MASKED]', accept: 'json' } },
    });
  });

  it('循環参照・BigInt・Error・Date・関数を含む値でも、例外を投げずに出力する', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;

    logger.error('x', {
      circular,
      big: 10n,
      error: new RangeError('壊れた'),
      at: new Date('2026-10-09T03:00:00Z'),
      invalidDate: new Date('invalid'),
      callback: () => undefined,
      list: [1, { token: 't' }],
    });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      circular: { name: 'a', self: '[Circular]' },
      big: '10',
      error: { name: 'RangeError', message: '壊れた' },
      at: '2026-10-09T03:00:00.000Z',
      invalidDate: null,
      callback: '[function]',
      list: [1, { token: '[MASKED]' }],
    });
  });

  it('深すぎる値は切り詰める。値の取得で例外を投げるプロパティがあっても、出力の失敗で呼び出し元を止めない', () => {
    const { lines, logger } = capture();
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 10; level += 1) {
      deep = { child: deep };
    }
    const throwing = {
      get value(): never {
        throw new Error('getter の失敗');
      },
    };

    logger.info('深い値', { deep });
    expect(() => {
      logger.info('例外を投げる値', { throwing });
    }).not.toThrow();

    expect(lines[0]).toContain('[Truncated]');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      message: '例外を投げる値',
      fields: '[UNSERIALIZABLE]',
    });
  });
});
