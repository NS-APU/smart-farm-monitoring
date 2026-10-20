/**
 * ジョブの Lambda のハンドラを、本番の設定（APP_MODE=production・DynamoDB・Cognito）で動かす結合テスト（Issue #76。ADR-0011）。
 * DynamoDB は DynamoDB Local、Cognito は偽の Cognito（実際の AWS には、接続しない）。EventBridge の入力（`{ jobId }`）を渡す。
 * 同じジョブの重複（前回の実行が終わる前の次の起動・複数の実行環境）で、二重に実行しないことを確認する。
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { JobResult, JobRunner } from '../../src/backend/application/jobs/job-runner.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { createJobLambdaHandler } from '../../src/backend/runtime/job-lambda.ts';
import { createFakeCognito } from '../support/fake-cognito.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const DELIVERY: JobResult = {
  jobId: 'JB-04',
  summary: { notificationsProcessed: 0, delivered: 0, failed: 0 },
};

async function productionEnvironment() {
  const database = createDynamoTestDatabase();
  await database.ready;
  const env: Record<string, string> = {
    APP_MODE: 'production',
    AUTH_PROVIDER: 'cognito',
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: dynamoTestClientOptions().endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
    COGNITO_USER_POOL_ID: 'pool-1',
    COGNITO_CLIENT_ID: 'client-1',
    LOG_LEVEL: 'error',
  };
  const fake = createFakeCognito({
    userPoolId: 'pool-1',
    clientId: 'client-1',
    now: () => new Date(),
  });
  return { env, fake };
}

type Fake = Awaited<ReturnType<typeof productionEnvironment>>['fake'];

/** ジョブの実行を、差し替えられる Lambda のハンドラ（差し替えなければ、実際のジョブを実行する）。 */
function handlerWith(env: Record<string, string>, fake: Fake, runner?: JobRunner) {
  return createJobLambdaHandler(env, {
    createContainer: (config, overrides) => {
      const container = createContainer(config, { ...overrides, cognitoClient: fake });
      return runner === undefined ? container : { ...container, jobRunner: runner };
    },
  });
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ジョブの Lambda のハンドラ（本番の設定）', () => {
  it('EventBridge の入力（jobId）で、4 種のジョブを、それぞれ実行できる（データが空でも成功する）', async () => {
    const { env, fake } = await productionEnvironment();
    const handler = handlerWith(env, fake);

    const results = [];
    for (const jobId of ['JB-01', 'JB-02', 'JB-03', 'JB-04']) {
      results.push(await handler({ jobId }));
    }

    expect(results.map((result) => [result.jobId, result.outcome])).toEqual([
      ['JB-01', 'EXECUTED'],
      ['JB-02', 'EXECUTED'],
      ['JB-03', 'EXECUTED'],
      ['JB-04', 'EXECUTED'],
    ]);
  });

  it.each([
    ['jobId がない', {}],
    ['未知のジョブ', { jobId: 'JB-99' }],
    ['文字列でない', { jobId: 4 }],
    ['入力がない', undefined],
    ['文字列の入力', 'JB-01'],
  ])('入力が不正（%s）なら、内容を出さずに拒否する', async (_name, event) => {
    const { env, fake } = await productionEnvironment();

    await expect(handlerWith(env, fake)(event)).rejects.toThrow(
      'ジョブの識別子（jobId）が不正です',
    );
  });

  it('同じジョブが実行中なら、次の起動は、実行せずに終わる（前回の実行が終わる前の次の起動）。終われば、また実行できる', async () => {
    const { env, fake } = await productionEnvironment();
    const gate = deferred();
    const entered = deferred();
    let runs = 0;
    const runner: JobRunner = {
      run: async (jobId) => {
        runs += 1;
        // JB-04 だけが、終わらずに待つ（別のジョブは、すぐに終わる）
        if (jobId === 'JB-04') {
          entered.resolve();
          await gate.promise;
        }
        return DELIVERY;
      },
    };
    const handler = handlerWith(env, fake, runner);

    const first = handler({ jobId: 'JB-04' });
    await entered.promise;
    const duplicate = await handler({ jobId: 'JB-04' });
    const otherJob = await handler({ jobId: 'JB-03' });
    gate.resolve();

    expect(duplicate).toEqual({ jobId: 'JB-04', outcome: 'SKIPPED' });
    expect(otherJob).toMatchObject({ jobId: 'JB-03', outcome: 'EXECUTED' });
    expect(await first).toMatchObject({ jobId: 'JB-04', outcome: 'EXECUTED' });
    expect(await handler({ jobId: 'JB-04' })).toMatchObject({ outcome: 'EXECUTED' });
    // 重複した起動は、実行されない（JB-04 が 2 回、JB-03 が 1 回）
    expect(runs).toBe(3);
  });

  it('別の実行環境（別の Lambda）が、同じジョブを実行中でも、実行しない（ロックは、DynamoDB で共有する）', async () => {
    const { env, fake } = await productionEnvironment();
    const gate = deferred();
    const entered = deferred();
    const slow: JobRunner = {
      run: async () => {
        entered.resolve();
        await gate.promise;
        return DELIVERY;
      },
    };
    let otherRuns = 0;
    const other: JobRunner = {
      run: () => {
        otherRuns += 1;
        return Promise.resolve(DELIVERY);
      },
    };

    const first = handlerWith(env, fake, slow)({ jobId: 'JB-04' });
    await entered.promise;
    const second = await handlerWith(env, fake, other)({ jobId: 'JB-04' });
    gate.resolve();
    await first;

    expect(second).toEqual({ jobId: 'JB-04', outcome: 'SKIPPED' });
    expect(otherRuns).toBe(0);
  });

  it('ジョブが失敗したら、エラーを投げる（再試行はしない）。ロックは解放され、次の起動は実行できる', async () => {
    const { env, fake } = await productionEnvironment();
    let shouldFail = true;
    const runner: JobRunner = {
      run: () =>
        shouldFail ? Promise.reject(new Error('一時的な失敗')) : Promise.resolve(DELIVERY),
    };
    const handler = handlerWith(env, fake, runner);

    await expect(handler({ jobId: 'JB-04' })).rejects.toThrow('一時的な失敗');
    shouldFail = false;

    expect(await handler({ jobId: 'JB-04' })).toMatchObject({ outcome: 'EXECUTED' });
  });

  it('初期化に失敗しても、失敗を保持せず、次の起動で、再試行する', async () => {
    const { env, fake } = await productionEnvironment();
    let attempts = 0;
    const handler = createJobLambdaHandler(env, {
      createContainer: (config, overrides) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('一時的な初期化の失敗');
        }
        return createContainer(config, { ...overrides, cognitoClient: fake });
      },
    });

    await expect(handler({ jobId: 'JB-04' })).rejects.toThrow('一時的な初期化の失敗');

    expect(await handler({ jobId: 'JB-04' })).toMatchObject({ outcome: 'EXECUTED' });
    expect(attempts).toBe(2);
  });

  it('SEED_MODE の指定は、設定エラーにする（ジョブの起動のたびに、デモデータを投入しない）', async () => {
    const { env, fake } = await productionEnvironment();

    await expect(
      handlerWith({ ...env, SEED_MODE: 'DEMO' }, fake)({ jobId: 'JB-04' }),
    ).rejects.toThrow('SEED_MODE');
  });
});
