/**
 * 評価環境のデモデータを、投入・リセットするコマンド（`pnpm demo-data`。Issue #77。ADR-0012）の結合テスト。
 * DynamoDB は DynamoDB Local（実際の AWS には、接続しない）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import { KEPT_PARTITIONS } from '../../src/backend/infrastructure/dynamodb/data-reset.ts';
import { createJobLock } from '../../src/backend/infrastructure/dynamodb/job-lock.ts';
import { createLoginThrottle } from '../../src/backend/infrastructure/dynamodb/login-throttle.ts';
import { createSystemClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { runDemoDataCli } from '../../src/backend/runtime/demo-data-cli.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

function output() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
  };
}

async function setup() {
  const database = createDynamoTestDatabase();
  await database.ready;
  const env: Record<string, string> = {
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: dynamoTestClientOptions().endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
  };
  // 結果の確認用の、コマンドとは別のコンテナ
  const container = createContainer(parseConfig({ ...env, AWS_REGION: 'ap-northeast-1' }));
  const run = (
    args: string[],
    overrides: Parameters<typeof runDemoDataCli>[3] = {},
    extraEnv: Record<string, string> = {},
  ) => {
    const out = output();
    return runDemoDataCli(args, { ...env, ...extraEnv }, out, overrides).then((exitCode) => ({
      exitCode,
      lines: out.lines,
    }));
  };
  const counts = async () => ({
    equipment: (await container.repositories.equipment.list({ includeDeleted: true })).length,
    statusCodes: (await container.repositories.statusCodes.list()).length,
    users: (await container.repositories.users.list()).length,
  });
  return { database, container, run, counts };
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

  it('--days で、合成データの日数を指定できる（実測用。既定は 3 日）', async () => {
    const { run, container } = await setup();
    const startedAt = Date.now();

    const result = await run(['seed', '--days', '2']);

    expect(result).toEqual({
      exitCode: 0,
      lines: ['info: デモデータを投入しました（設備 3 件・直近 2 日分の合成データ・評価）'],
    });
    const observations = await container.repositories.observations.findForEvaluation(
      [toEquipmentId('ROBOT-01')],
      new Date(startedAt - 10 * MS_PER_DAY),
      new Date(),
    );
    const earliest = Math.min(...observations.map((item) => Date.parse(item.observedAt)));
    // 2 日前から始まる（3 日前ではない）
    expect(earliest).toBeGreaterThan(startedAt - 2 * MS_PER_DAY - 60 * 60_000);
    expect(earliest).toBeLessThan(startedAt - 1.5 * MS_PER_DAY);
  });

  it.each([
    [['seed', '--days'], '--days には、1〜31 の整数を指定してください'],
    [['seed', '--days', 'abc'], '--days には、1〜31 の整数を指定してください'],
    [['seed', '--days', '0'], '--days には、1〜31 の整数を指定してください'],
    [['seed', '--days', '32'], '--days には、1〜31 の整数を指定してください'],
  ])('--days の値が不正なら、何も投入せず、エラー（終了コード 1）: %j', async (args, message) => {
    const { run, counts } = await setup();

    const result = await run(args);

    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain(message);
    expect((await counts()).equipment).toBe(0);
  });

  it.each(['seed', 'reset'])(
    '本番サイト（SFM_ENVIRONMENT=production）では、%s を実行しない（何も投入・削除せず、終了コード 1。Issue #117）',
    async (command) => {
      const database = createDynamoTestDatabase();
      await database.ready;
      const env: Record<string, string> = {
        PERSISTENCE: 'dynamodb',
        DYNAMODB_ENDPOINT: dynamoTestClientOptions().endpoint ?? '',
        DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
        DYNAMODB_MAIN_TABLE: database.tables.main,
        SFM_ENVIRONMENT: 'production',
      };
      const out = output();

      const exitCode = await runDemoDataCli([command, '--yes'], env, out);

      expect(exitCode).toBe(1);
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toContain('開発サイト専用');
      const container = createContainer(parseConfig({ ...env, AWS_REGION: 'ap-northeast-1' }));
      expect((await container.repositories.equipment.list({ includeDeleted: true })).length).toBe(
        0,
      );
      container.close();
    },
  );

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

describe('pnpm demo-data use-http-feed（デモ用の HTTP 配信。Issue #344。ADR-0025）', () => {
  const FEED_URL = 'https://demo-feed.example.com/';
  const APPLIED = '取り込みを、デモ用の HTTP 配信に向けました';

  async function robotSourceConnection(container: Awaited<ReturnType<typeof setup>>['container']) {
    const sources = await container.ingestionSettings.listSources();
    return sources.map((source) => [source.sourceId, source.connection] as const);
  }

  it('seed のあとに、取り込み元の接続を HTTP にする（--url）。接続先は、出力しない。何度実行しても、同じ', async () => {
    const { run, container } = await setup();
    await run(['seed']);

    const first = await run(['use-http-feed', '--url', FEED_URL]);
    const second = await run(['use-http-feed', '--url', FEED_URL]);

    expect(first).toEqual({
      exitCode: 0,
      lines: [`info: ${APPLIED}（取り込み元 2 件・ファイルのパスを設定した設備 2 件）`],
    });
    expect(second).toEqual({
      exitCode: 0,
      lines: [`info: ${APPLIED}（取り込み元 2 件・ファイルのパスを設定した設備 0 件）`],
    });
    expect(first.lines.join('')).not.toContain('demo-feed.example.com');
    expect(await robotSourceConnection(container)).toEqual([
      [
        'robot',
        expect.objectContaining({ type: 'HTTP', protocol: 'HTTPS', host: 'demo-feed.example.com' }),
      ],
      [
        'environment-sensor',
        expect.objectContaining({ type: 'HTTP', host: 'demo-feed.example.com' }),
      ],
    ]);
  });

  it('設備ごとの接続も、デモの設備（ロボット・環境センサー）に保存する。何度実行しても、同じ（Issue #367。ADR-0026）', async () => {
    const { run, container } = await setup();
    await run(['seed']);

    await run(['use-http-feed', '--url', FEED_URL]);
    await run(['use-http-feed', '--url', FEED_URL]);

    const saved = await container.equipmentConnections.list();
    expect([...saved.keys()].sort()).toEqual(['ROBOT-01', 'SENSOR-01']);
    for (const connection of saved.values()) {
      expect(connection).toMatchObject({
        type: 'HTTP',
        protocol: 'HTTPS',
        host: 'demo-feed.example.com',
        authMethod: 'NONE',
      });
    }
  });

  it('seed の設備（ファイルのパスを持たない。以前に投入したものも同じ）に、ファイルのパスを設定する。環境変数 DEMO_FEED_URL でも指定できる', async () => {
    const { run, container } = await setup();
    await run(['seed']);
    expect(
      (await container.repositories.equipment.get(toEquipmentId('ROBOT-01')))?.sourceFilePath,
    ).toBeUndefined();

    const result = await run(['use-http-feed'], {}, { DEMO_FEED_URL: FEED_URL });

    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain('ファイルのパスを設定した設備 2 件');
    expect(
      (await container.repositories.equipment.get(toEquipmentId('ROBOT-01')))?.sourceFilePath,
    ).toBe('/robot/latest.json');
    expect(
      (await container.repositories.equipment.get(toEquipmentId('SENSOR-01')))?.sourceFilePath,
    ).toBe('/environment-sensor/latest.json');
  });

  it('seed に --url を付けると、投入のあとに、同じ設定をする', async () => {
    const { run, container } = await setup();

    const result = await run(['seed', '--url', FEED_URL]);

    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain('デモデータを投入しました');
    expect(result.lines[1]).toContain(APPLIED);
    expect(await robotSourceConnection(container)).toEqual([
      ['robot', expect.objectContaining({ type: 'HTTP' })],
      ['environment-sensor', expect.objectContaining({ type: 'HTTP' })],
    ]);
  });

  it.each([
    [['use-http-feed'], '配信の URL が必要です'],
    [['use-http-feed', '--url'], '--url には、配信の URL を指定してください'],
    [['use-http-feed', '--url', '--yes'], '--url には、配信の URL を指定してください'],
    [
      ['use-http-feed', '--url', 'https://demo-feed.example.com/a'],
      '接続先の URL が正しくありません',
    ],
  ])(
    'URL がない・正しくなければ、何も変えず、エラー（終了コード 1）: %j',
    async (args, message) => {
      const { run, container } = await setup();
      await run(['seed']);

      const result = await run(args);

      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toContain(message);
      // 何も変えない = 既定のまま（接続は、未設定）
      expect((await robotSourceConnection(container)).map(([, connection]) => connection)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it('デモの設備がなければ、先に seed を実行するよう、エラー（終了コード 1）。seed の URL が正しくなければ、投入しない', async () => {
    const { run, counts } = await setup();

    const noEquipment = await run(['use-http-feed', '--url', FEED_URL]);
    const badUrl = await run(['seed', '--url', 'ftp://demo-feed.example.com/']);

    expect(noEquipment.exitCode).toBe(1);
    expect(noEquipment.lines[0]).toContain('pnpm demo-data seed');
    expect(badUrl.exitCode).toBe(1);
    expect(badUrl.lines[0]).toContain('接続先の URL が正しくありません');
    expect((await counts()).equipment).toBe(0);
  });

  it('本番サイト（SFM_ENVIRONMENT=production）では、実行しない', async () => {
    const { run } = await setup();

    const result = await run(
      ['use-http-feed', '--url', FEED_URL],
      {},
      { SFM_ENVIRONMENT: 'production' },
    );

    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('開発サイト専用');
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
    return { ...context, throttle: createLoginThrottle(db, clock), lock: createJobLock(db, clock) };
  }

  it('--yes がなければ、何も消さず、消す対象の件数と、実行の方法を示す', async () => {
    const { run, counts } = await seeded();

    const result = await run(['reset']);

    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain('を削除します。元に戻せません');
    expect(result.lines[0]).toContain('--yes を付けます');
    expect(result.lines[0]).not.toContain('S3');
    expect((await counts()).equipment).toBe(3);
  });

  it('--yes で、設備・観測値・評価を消し、ユーザー・ログイン失敗の記録・ジョブのロックは残す。ステータスコードは、入れ直す', async () => {
    const { run, counts, container, throttle, lock } = await seeded();

    const result = await run(['reset', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain(
      'を削除しました。続けて、pnpm demo-data seed で、投入し直せます',
    );
    expect(result.lines[0]).toContain(KEPT_PARTITIONS.join('・'));
    expect(await counts()).toEqual({ equipment: 0, statusCodes: 8, users: 1 });
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

  it('AWS のエラーは、名前だけを出力する（メッセージの、アカウント ID・ARN・接続先を、出力しない）。到達できない接続先の DynamoDB で、reset が失敗しても、同じ', async () => {
    // 閉じているポート（DynamoDB Local は、使わない）。SDK の失敗の内容は、メッセージに接続先を含む
    const env = {
      PERSISTENCE: 'dynamodb',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:1',
      DYNAMODB_OBSERVATIONS_TABLE: 'dummy-observations',
      DYNAMODB_MAIN_TABLE: 'dummy-main',
      AWS_ACCESS_KEY_ID: 'dummyaccesskeyid',
      AWS_SECRET_ACCESS_KEY: 'dummysecretaccesskey',
      AWS_MAX_ATTEMPTS: '1',
    };
    const out = output();

    const exitCode = await runDemoDataCli(['reset', '--yes'], env, out);

    expect(exitCode).toBe(1);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('demo-data reset に失敗しました: AWS の操作に失敗しました（');
    expect(out.lines[0]).not.toContain('127.0.0.1');
  });
});
