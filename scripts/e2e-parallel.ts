/*
 * E2E を、複数のインスタンスに分けて、並列に実行する（Issue #519）。`pnpm test:e2e:parallel` から使う。
 *
 * 各インスタンスは、自分のバックエンド・フロントエンド（ポートは、環境変数 E2E_PORT_OFFSET で分ける。dev-ports.ts）と、
 * 出力先（test-result/e2e-<ずらした値>/、test-result/playwright-report-<ずらした値>/）を持つ。テストは、テストごとに
 * バックエンドのデータを初期化するため、インスタンス同士は、状態を共有しない。Playwright の `--shard=N/M` で、テストを分ける（既定は 2。手元の PC では、3 以上にしても全体の時間は変わらず、CPU の取り合いで、タイムアウトの失敗が出た）
 * （CI の e2e-shard と同じ分け方）。フロントエンドは、1 回だけビルドして、全インスタンスで配信する。
 *
 * ポートは、既定の 5173・8787 と重ならない値（100 ずつずらす）を使う。開発サーバーと、同時に動かせる。
 *
 * 使い方: `pnpm test:e2e:parallel [--shards N] [Playwright の引数（ファイル・-g など）]`
 * 終了コードは、すべてのインスタンスが成功したときだけ 0。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from './e2e-parallel-args.ts';

const ROOT = resolve(import.meta.dirname, '..');
/** インスタンス i のポートのずらし幅（i = 1〜）。0 は、通常の実行（5173・8787）。 */
const PORT_STEP = 100;
const FRONTEND_DIST = resolve(ROOT, 'test-result/e2e-dist-parallel');

/** 子プロセスの出力を、行ごとに、先頭へ印をつけて、標準出力・標準エラーへ流す。 */
function pipeWithPrefix(child: ChildProcess, prefix: string, write: (text: string) => void): void {
  const handle = (stream: NodeJS.ReadableStream | null): void => {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        write(`${prefix} ${line}\n`);
      }
    });
    stream?.on('end', () => {
      if (pending !== '') {
        write(`${prefix} ${pending}\n`);
      }
    });
  };
  handle(child.stdout);
  handle(child.stderr);
}

function run(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; prefix: string },
): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeWithPrefix(child, options.prefix, (text) => process.stdout.write(text));
    child.on('error', (error) => {
      process.stderr.write(`${options.prefix} 起動に失敗しました: ${error.message}\n`);
      done(1);
    });
    child.on('close', (code) => {
      done(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  const { shards, playwrightArgs } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  process.stdout.write(`フロントエンドをビルドします（${FRONTEND_DIST}）\n`);
  const buildCode = await run(
    [
      resolve(ROOT, 'node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      FRONTEND_DIST,
      '--emptyOutDir',
    ],
    { cwd: resolve(ROOT, 'src/frontend'), env: process.env, prefix: '[build]' },
  );
  if (buildCode !== 0) {
    process.stderr.write('フロントエンドのビルドに失敗しました\n');
    return buildCode;
  }

  process.stdout.write(`E2E を ${String(shards)} 個のインスタンスで並列に実行します\n`);
  const results = await Promise.all(
    Array.from({ length: shards }, async (_, index) => {
      const shard = index + 1;
      const instanceStartedAt = Date.now();
      const code = await run(
        [
          resolve(ROOT, 'node_modules/@playwright/test/cli.js'),
          'test',
          `--shard=${String(shard)}/${String(shards)}`,
          ...playwrightArgs,
        ],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            E2E_PORT_OFFSET: String(shard * PORT_STEP),
            E2E_FRONTEND_DIST: FRONTEND_DIST,
          },
          prefix: `[${String(shard)}/${String(shards)}]`,
        },
      );
      return { shard, code, seconds: Math.round((Date.now() - instanceStartedAt) / 1000) };
    }),
  );

  process.stdout.write('\n結果:\n');
  for (const { shard, code, seconds } of results) {
    process.stdout.write(
      `  [${String(shard)}/${String(shards)}] ${code === 0 ? '成功' : `失敗（終了コード ${String(code)}）`}  ${String(seconds)} 秒\n`,
    );
  }
  const totalSeconds = Math.round((Date.now() - startedAt) / 1000);
  const failed = results.filter((result) => result.code !== 0);
  process.stdout.write(
    `全体: ${failed.length === 0 ? '成功' : `失敗（${String(failed.length)} 個のインスタンス）`}  ${String(totalSeconds)} 秒（ビルドを含む）\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(
      `失敗の詳細は、上の出力と、test-result/playwright-report-<${String(PORT_STEP)} の倍数>/ の HTML レポートで確認できます\n`,
    );
  }
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
