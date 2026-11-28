/**
 * `pnpm test:e2e:parallel`（e2e-parallel.ts）の引数の解析（Issue #519）。単体テスト（tests/unit/tooling/）のため、実行部と分ける。
 */

export const DEFAULT_SHARDS = 2;
export const MAX_SHARDS = 16;

export interface Options {
  /** インスタンスの数（Playwright の `--shard=N/<この値>`）。 */
  readonly shards: number;
  /** `--shards` 以外の引数。Playwright に、そのまま渡す（ファイル・`-g` など）。 */
  readonly playwrightArgs: readonly string[];
}

function parseShards(value: string | undefined): number {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SHARDS) {
    throw new Error(`--shards は、1〜${String(MAX_SHARDS)} の整数で指定してください`);
  }
  return parsed;
}

/** `--shards N`（または `--shards=N`）を読み、残りを Playwright の引数にする。 */
export function parseArgs(argv: readonly string[]): Options {
  let shards = DEFAULT_SHARDS;
  const playwrightArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--shards') {
      index += 1;
      shards = parseShards(argv[index]);
    } else if (arg.startsWith('--shards=')) {
      shards = parseShards(arg.slice('--shards='.length));
    } else {
      playwrightArgs.push(arg);
    }
  }
  return { shards, playwrightArgs };
}
