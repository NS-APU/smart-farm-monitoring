/**
 * E2E の実行まわり（Issue #519）の単体テスト: ポートのずらし（dev-ports.ts）、実行の設定（e2e-options.ts）、
 * 並列実行の引数の解析（scripts/e2e-parallel-args.ts）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHARDS, MAX_SHARDS, parseArgs } from '../../../scripts/e2e-parallel-args.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('dev-ports.ts（E2E_PORT_OFFSET）', () => {
  async function load() {
    vi.resetModules();
    return import('../../../dev-ports.ts');
  }

  it('未指定なら、既定のポート（バックエンド 8787・フロントエンド 5173）で、ずらしは 0', async () => {
    vi.stubEnv('E2E_PORT_OFFSET', '');
    const ports = await load();
    expect(ports.DEV_BACKEND_PORT).toBe(8787);
    expect(ports.DEV_FRONTEND_PORT).toBe(5173);
    expect(ports.PORT_OFFSET).toBe(0);
  });

  it('指定した値を、両方のポートに足す', async () => {
    vi.stubEnv('E2E_PORT_OFFSET', '300');
    const ports = await load();
    expect(ports.DEV_BACKEND_PORT).toBe(9087);
    expect(ports.DEV_FRONTEND_PORT).toBe(5473);
    expect(ports.PORT_OFFSET).toBe(300);
  });

  it('0 と、上限（50000）は、受け付ける', async () => {
    vi.stubEnv('E2E_PORT_OFFSET', '0');
    expect((await load()).DEV_BACKEND_PORT).toBe(8787);
    vi.stubEnv('E2E_PORT_OFFSET', '50000');
    expect((await load()).DEV_BACKEND_PORT).toBe(58787);
  });

  it.each(['-1', '1.5', 'abc', '50001'])(
    '範囲外・整数でない値（%s）は、エラーにする',
    async (value) => {
      vi.stubEnv('E2E_PORT_OFFSET', value);
      await expect(load()).rejects.toThrow('E2E_PORT_OFFSET');
    },
  );
});

describe('e2e-options.ts', () => {
  async function load() {
    vi.resetModules();
    return import('../../e2e/support/e2e-options.ts');
  }

  it('環境変数がなければ、動画は撮らず、本番ビルドを配信し、ビルド済みの指定も接尾辞もない', async () => {
    vi.stubEnv('E2E_VIDEO', '');
    vi.stubEnv('E2E_DEV_SERVER', '');
    vi.stubEnv('E2E_FRONTEND_DIST', '');
    vi.stubEnv('E2E_PORT_OFFSET', '');
    const options = await load();
    expect(options.E2E_VIDEO).toBe(false);
    expect(options.E2E_DEV_SERVER).toBe(false);
    expect(options.E2E_FRONTEND_DIST).toBeUndefined();
    expect(options.E2E_INSTANCE_SUFFIX).toBe('');
  });

  it('E2E_VIDEO=1・E2E_DEV_SERVER=1 のときだけ、有効になる（ほかの値は無効）', async () => {
    vi.stubEnv('E2E_VIDEO', '1');
    vi.stubEnv('E2E_DEV_SERVER', '1');
    const enabled = await load();
    expect(enabled.E2E_VIDEO).toBe(true);
    expect(enabled.E2E_DEV_SERVER).toBe(true);
    vi.stubEnv('E2E_VIDEO', 'true');
    vi.stubEnv('E2E_DEV_SERVER', '0');
    const disabled = await load();
    expect(disabled.E2E_VIDEO).toBe(false);
    expect(disabled.E2E_DEV_SERVER).toBe(false);
  });

  it('ビルド済みのディレクトリと、ポートをずらしたインスタンスの接尾辞を、読む', async () => {
    vi.stubEnv('E2E_FRONTEND_DIST', '/dummy/dist');
    vi.stubEnv('E2E_PORT_OFFSET', '200');
    const options = await load();
    expect(options.E2E_FRONTEND_DIST).toBe('/dummy/dist');
    expect(options.E2E_INSTANCE_SUFFIX).toBe('-200');
  });
});

describe('scripts/e2e-parallel-args.ts（parseArgs）', () => {
  it('引数がなければ、既定のインスタンス数で、Playwright の引数はない', () => {
    expect(parseArgs([])).toEqual({ shards: DEFAULT_SHARDS, playwrightArgs: [] });
  });

  it('--shards N と --shards=N を読む（1 と上限を含む）', () => {
    expect(parseArgs(['--shards', '3']).shards).toBe(3);
    expect(parseArgs(['--shards=6']).shards).toBe(6);
    expect(parseArgs(['--shards', '1']).shards).toBe(1);
    expect(parseArgs([`--shards=${String(MAX_SHARDS)}`]).shards).toBe(MAX_SHARDS);
  });

  it('それ以外の引数は、順序を保って、Playwright に渡す', () => {
    expect(
      parseArgs([
        'tests/e2e/UC-06-record-recovery.ts',
        '--shards',
        '2',
        '-g',
        '復旧',
        '--retries=1',
      ]),
    ).toEqual({
      shards: 2,
      playwrightArgs: ['tests/e2e/UC-06-record-recovery.ts', '-g', '復旧', '--retries=1'],
    });
  });

  it.each([
    [['--shards', '0']],
    [[`--shards=${String(MAX_SHARDS + 1)}`]],
    [['--shards', '1.5']],
    [['--shards=abc']],
    [['--shards=']],
    [['--shards']],
  ])('--shards が範囲外・整数でない・値がない（%j）は、エラーにする', (argv) => {
    expect(() => parseArgs(argv)).toThrow('--shards');
  });
});
