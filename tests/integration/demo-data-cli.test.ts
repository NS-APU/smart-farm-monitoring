/**
 * 評価環境のデモデータを、投入・リセットするコマンド（`pnpm demo-data`。Issue #77。ADR-0012）の結合テスト。
 * DynamoDB は DynamoDB Local、S3 は偽の S3（実際の AWS には、接続しない）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import { KEPT_PARTITIONS } from '../../src/backend/infrastructure/dynamodb/data-reset.ts';
import { createJobLock } from '../../src/backend/infrastructure/dynamodb/job-lock.ts';
import { createLoginThrottle } from '../../src/backend/infrastructure/dynamodb/login-throttle.ts';
import { createSystemClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { runDemoDataCli } from '../../src/backend/runtime/demo-data-cli.ts';
import { createFakeS3 } from '../support/fake-s3.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const BUCKET = 'dummy-file-server';

function output() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
  };
}

async function setup(withBucket = true) {
  const database = createDynamoTestDatabase();
  await database.ready;
  const s3 = createFakeS3({ bucket: BUCKET });
  const env: Record<string, string> = {
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: dynamoTestClientOptions().endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
    ...(withBucket ? { FILE_SERVER_S3_BUCKET: BUCKET } : {}),
  };
  // 結果の確認用の、コマンドとは別のコンテナ
  const container = createContainer(parseConfig({ ...env, AWS_REGION: 'ap-northeast-1' }));
  const run = (args: string[], overrides: Parameters<typeof runDemoDataCli>[3] = {}) => {
    const out = output();
    return runDemoDataCli(args, env, out, { s3Client: s3, ...overrides }).then((exitCode) => ({
      exitCode,
      lines: out.lines,
    }));
  };
  const counts = async () => ({
    equipment: (await container.repositories.equipment.list({ includeDeleted: true })).length,
    statusCodes: (await container.repositories.statusCodes.list()).length,
    users: (await container.repositories.users.list()).length,
  });
  return { database, s3, container, run, counts };
}

describe('pnpm demo-data seed', () => {
  it('デモの設備・合成データ・評価を投入する。設備がすでにあれば、何もしない（上書きしない）', async () => {
    const { run, container, counts } = await setup();

    const first = await run(['seed']);
    const second = await run(['seed']);

    expect(first).toEqual({
      exitCode: 0,
      lines: ['info: デモデータを投入しました（設備 3 件・直近 3 日分の合成データ・評価）'],
    });
    expect(second.exitCode).toBe(0);
    expect(second.lines[0]).toContain(
      '設備がすでに 3 件あるため、デモデータは、投入しませんでした',
    );
    const { equipment, statusCodes } = await counts();
    expect(equipment).toBe(3);
    expect(statusCodes).toBe(8);
    // デモのハウスの評価が、できている
    const latest = await container.repositories.evaluations.listLatest(toEquipmentId('HOUSE-01'));
    expect(latest.length).toBeGreaterThan(0);
  });

  it('PERSISTENCE=dynamodb でなければ、設定エラー（終了コード 1）。コマンドの指定がなければ、使い方を示す', async () => {
    const out = output();

    const misconfigured = await runDemoDataCli(['seed'], {}, out);
    const unknown = await runDemoDataCli(['drop'], {}, out);
    const none = await runDemoDataCli([], {}, out);

    expect(misconfigured).toBe(1);
    expect(unknown).toBe(1);
    expect(none).toBe(1);
    expect(out.lines[0]).toContain('PERSISTENCE=dynamodb');
    expect(out.lines[1]).toContain('使い方: pnpm demo-data seed');
    expect(out.lines[2]).toContain('使い方: pnpm demo-data seed');
  });
});

describe('pnpm demo-data reset', () => {
  async function seeded() {
    const context = await setup();
    await context.run(['seed']);
    // 残すデータ: ユーザー・ログインの失敗の記録・ジョブのロック
    await context.container.repositories.users.save({
      userId: toUserId('keep-user'),
      userName: '残すユーザー',
      role: 'worker',
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    const clock = createSystemClock();
    const db = {
      client: context.database.client,
      tables: context.database.tables,
    };
    await createLoginThrottle(db, clock).recordFailure('203.0.113.10');
    await createJobLock(db, clock).tryAcquire('job:JB-04', 600_000);
    context.s3.putObject('robot/robot-20261020T0000Z.json', '{}', new Date());
    context.s3.putObject('environment-sensor/sensor-20261020T0000Z.csv', 'x', new Date());
    return { ...context, throttle: createLoginThrottle(db, clock), lock: createJobLock(db, clock) };
  }

  it('--yes がなければ、何も消さず、消す対象の件数と、実行の方法を示す', async () => {
    const { run, counts, s3 } = await seeded();

    const result = await run(['reset']);

    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain('を削除します。元に戻せません');
    expect(result.lines[0]).toContain('--yes を付けます');
    expect(result.lines[0]).toContain('S3 のファイル 2 件');
    expect((await counts()).equipment).toBe(3);
    expect(s3.keys()).toHaveLength(2);
  });

  it('--yes で、設備・観測値・評価・S3 のファイルを消し、ユーザー・ログイン失敗の記録・ジョブのロックは残す。ステータスコードは、入れ直す', async () => {
    const { run, counts, s3, container, throttle, lock } = await seeded();

    const result = await run(['reset', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain(
      'を削除しました。続けて、pnpm demo-data seed で、投入し直せます',
    );
    expect(result.lines[0]).toContain(KEPT_PARTITIONS.join('・'));
    expect(await counts()).toEqual({ equipment: 0, statusCodes: 8, users: 1 });
    expect(s3.keys()).toEqual([]);
    const observations = await container.repositories.observations.query(
      { equipmentIds: ['ROBOT-01'] as never, includeDeleted: true },
      { limit: 10 },
    );
    expect(observations.items).toEqual([]);
    // 残すもの
    expect(await throttle.isLocked('203.0.113.10')).toBe(false);
    expect(await lock.tryAcquire('job:JB-04', 600_000)).toBeNull();
  });

  it('リセットのあとに、もう一度、投入できる', async () => {
    const { run, counts } = await seeded();
    await run(['reset', '--yes']);

    const again = await run(['seed']);

    expect(again.lines[0]).toContain('デモデータを投入しました');
    expect((await counts()).equipment).toBe(3);
  });

  it('S3 のバケットを指定しなければ、DynamoDB のデータだけを消す', async () => {
    const context = await setup(false);
    await context.run(['seed']);
    context.s3.putObject('robot/a.json', '{}', new Date());

    const result = await context.run(['reset', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).not.toContain('S3 のファイル');
    expect((await context.counts()).equipment).toBe(0);
    expect(context.s3.keys()).toEqual(['robot/a.json']);
  });

  it('AWS のエラーは、名前だけを出力する（メッセージの、アカウント ID・ARN を、出力しない）。DynamoDB のデータは、消さない', async () => {
    const { run, counts } = await seeded();
    const failing = {
      send: () =>
        Promise.reject(
          Object.assign(
            new Error('User: arn:aws:sts::123456789012:assumed-role/example is not authorized'),
            { name: 'AccessDenied' },
          ),
        ),
    };

    const result = await run(['reset', '--yes'], { s3Client: failing as never });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('AccessDenied');
    expect(result.lines.join('\n')).not.toContain('123456789012');
    // S3 の削除に失敗したので、DynamoDB の削除には、進まない
    expect((await counts()).equipment).toBe(3);
  });

  it('S3 のファイルの一部を消せなかったときは、エラーにして、DynamoDB のデータは、消さない', async () => {
    const { run, counts, s3 } = await seeded();
    s3.failDeletes();

    const result = await run(['reset', '--yes']);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('demo-data reset に失敗しました');
    expect((await counts()).equipment).toBe(3);
  });
});
