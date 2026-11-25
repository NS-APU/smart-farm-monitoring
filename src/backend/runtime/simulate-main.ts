/**
 * シミュレーション（`pnpm simulate`）の起動エントリ。ロジックを持たない（テストの対象は runtime/simulate-cli.ts）。
 * 時計・待つ・ファイル・通信を、実際のものに組み立てる。Ctrl+C（SIGINT）・SIGTERM は、待ちを抜けて、次の回の前に止める
 * （状態ファイルは、各回のあとに書いてあるため、`--resume` で続きから始められる）。`.env` は、読み込まない（トークンは、環境変数 SIM_WRITE_TOKEN）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runSimulateCli } from './simulate-cli.ts';

let stopped = false;
const waiters = new Set<() => void>();
const requestStop = (): void => {
  stopped = true;
  for (const wake of waiters) {
    wake();
  }
};
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

/** 指定のミリ秒、待つ。止めの指示があれば、すぐに戻る。 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (stopped) {
      resolve();
      return;
    }
    const wake = (): void => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, milliseconds);
    waiters.add(wake);
  });
}

try {
  process.exitCode = await runSimulateCli(process.argv.slice(2), process.env, {
    output: {
      info: (message) => {
        process.stdout.write(`${message}\n`);
      },
      error: (message) => {
        process.stderr.write(`${message}\n`);
      },
    },
    now: () => new Date(),
    sleep,
    shouldStop: () => stopped,
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    // 途中で止まっても、壊れた状態ファイルを残さないよう、一時ファイルに書いてから、置き換える
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, path);
    },
    fetch: (input, init) => fetch(input, init),
  });
} catch (error) {
  process.stderr.write(
    `simulate が、予期しないエラーで止まりました（${error instanceof Error ? error.name : 'unknown'}）。状態ファイルがあれば、--resume で続きから始められます\n`,
  );
  process.exitCode = 1;
}
