/**
 * DynamoDB Local の用意（vitest の globalSetup）。DynamoDB アダプタのテストが、接続先を `inject('dynamodbEndpoint')` で受ける。
 *
 * 接続先は、次の順に決める:
 * 1. 環境変数 `DYNAMODB_ENDPOINT`（起動済みの DynamoDB Local。CI の service container など）。接続できるまで待つ
 * 2. 環境変数 `DYNAMODB_LOCAL_DIR`（DynamoDBLocal.jar を展開したディレクトリ）: 空きポートで起動し、テストの後に止める
 * 3. どちらもなければ、未設定（DynamoDB のテストが、設定を促すエラーで失敗する。スキップはしない）
 *
 * DynamoDB Local は、AWS の公式の配布物（Java）。手順は docs/00_project/commands.md。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string | undefined;
  }
}

const STARTUP_TIMEOUT_MS = 60_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function waitForPort(port: number, host: string, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(
        'DynamoDB Local が起動できませんでした（Java の有無・DYNAMODB_LOCAL_DIR を確認）',
      );
    }
    if (await canConnect(port, host)) {
      return;
    }
    await sleep(200);
  }
  throw new Error('DynamoDB Local の起動を待ちきれませんでした');
}

export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
  const configured = process.env.DYNAMODB_ENDPOINT;
  if (configured !== undefined && configured !== '') {
    // 起動したばかり（CI の service container など）でも、接続できるまで待つ
    const url = new URL(configured);
    await waitForPort(Number(url.port || 80), url.hostname, () => true);
    project.provide('dynamodbEndpoint', configured);
    return undefined;
  }
  const directory = process.env.DYNAMODB_LOCAL_DIR;
  if (directory === undefined || directory === '') {
    project.provide('dynamodbEndpoint', undefined);
    return undefined;
  }
  const port = await freePort();
  let alive = true;
  const child = spawn(
    'java',
    [
      `-Djava.library.path=${join(directory, 'DynamoDBLocal_lib')}`,
      '-jar',
      join(directory, 'DynamoDBLocal.jar'),
      '-inMemory',
      '-sharedDb',
      '-port',
      String(port),
    ],
    // 作業用のファイル（メタデータ）が、リポジトリに残らないよう、一時ディレクトリで起動する。テレメトリは送らない
    {
      stdio: 'ignore',
      cwd: mkdtempSync(join(tmpdir(), 'dynamodb-local-')),
      env: { ...process.env, DDB_LOCAL_TELEMETRY: '0' },
    },
  );
  child.once('exit', () => {
    alive = false;
  });
  try {
    await waitForPort(port, '127.0.0.1', () => alive);
  } catch (error) {
    child.kill();
    throw error;
  }
  project.provide('dynamodbEndpoint', `http://127.0.0.1:${port}`);
  return () => {
    child.kill();
  };
}
