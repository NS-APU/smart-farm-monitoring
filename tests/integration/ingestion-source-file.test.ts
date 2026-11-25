/**
 * ブラウザから、設備ごとの取り込み用のファイルを置く機能（Issue #565。UC-15。SC-11。ADR-0027）の結合テスト。
 * `POST /ingestion/equipment/{id}/source-file/check`（検査だけ。保存しない）と、`PUT /ingestion/equipment/{id}/source-file`（検査して置く）。
 * 本文は、ファイルそのもの（JSON のテキスト。上限は、API の本文の上限と同じ 1 MiB）。管理者（`ingestion:configure`）だけ。
 * 置いたファイルは、ロボットの `PUT` と同じ場所（設備の `sourceFilePath`）に入り、取り込みが、そのまま読める。
 * 保管先は、メモリ（実際の S3 には、接続しない）。ファイルの内容は、変更履歴・ログに残さない。
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import {
  FileServerConnectionSchema,
  SourceFileInspectionSchema,
  SourceFilePlacedSchema,
} from '@smart-farm/shared/schemas/ingestion';
import {
  createHostedFileServer,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
} from '../../src/backend/application/hosted-file-server/hosted-file-server.ts';
import { fileServerEquipmentSecretReference } from '../../src/backend/application/ingestion/file-server-credentials.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createMemorySecretPort } from '../../src/backend/infrastructure/local/env-secret.ts';
import { createHostedFileServerLambdaHandler } from '../../src/backend/runtime/hosted-file-server-lambda.ts';
import { ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { FIXTURES_DIRECTORY } from '../support/fixtures-path.ts';
import { createMemoryHostedFileStore } from '../support/memory-hosted-file-store.ts';
import {
  addUserAndLogin,
  withEquipment,
  withSourceFilePaths,
  type TestContext,
} from '../support/test-context.ts';

const robotFixture = (name: string): string =>
  readFileSync(join(FIXTURES_DIRECTORY, 'file-server', 'robot', name), 'utf8');
const VALID = robotFixture('robot-definition-sample-001.json');
const ROBOT_PATH = `/robot/${ROBOT_ID}.json`;

const checkPath = (equipmentId: string) => `/ingestion/equipment/${equipmentId}/source-file/check`;
const putPath = (equipmentId: string) => `/ingestion/equipment/${equipmentId}/source-file`;

/** ファイルそのものを、本文として送る（JSON の包みは、付けない）。 */
async function sendFile(
  context: TestContext,
  method: 'POST' | 'PUT',
  path: string,
  content: string,
  token?: string,
): Promise<Response> {
  const accessToken = token ?? (await context.login());
  return context.app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: content,
  });
}

async function setup(env: Record<string, string> = {}): Promise<TestContext> {
  const context = await withEquipment({ env });
  await withSourceFilePaths(context);
  return context;
}

const storedFile = async (context: TestContext, path: string = ROBOT_PATH) =>
  (await context.container.hostedFileStore?.get(path))?.body;

describe('検査（POST …/source-file/check）', () => {
  it('取り込みと同じ解釈で、読み取れた計測日時・項目数・仕様の版を返す。何も保存しない', async () => {
    const context = await setup();

    const response = await sendFile(context, 'POST', checkPath(ROBOT_ID), VALID);

    expect(response.status).toBe(200);
    const body = SourceFileInspectionSchema.parse(await response.json());
    expect(body).toMatchObject({
      ok: true,
      formatLabel: 'robot-json@1.0.0(CONFIRMED)',
      observedAt: '2026-10-09T02:00:00.000Z',
      itemCount: 7,
      size: Buffer.byteLength(VALID, 'utf8'),
      problems: [],
    });
    expect(await storedFile(context)).toBeUndefined();
    expect(
      await context.container.repositories.observations.query({}, { limit: 10 }),
    ).toMatchObject({ items: [] });
  });

  it('JSON でない・形式が仕様と違う・計測日時がない内容は、置けない（ok: false。理由を返す）。200 で返す', async () => {
    const context = await setup();

    const broken = SourceFileInspectionSchema.parse(
      await (
        await sendFile(
          context,
          'POST',
          checkPath(ROBOT_ID),
          robotFixture('robot-sample-003-broken.json'),
        )
      ).json(),
    );
    const noTimestamp = SourceFileInspectionSchema.parse(
      await (
        await sendFile(
          context,
          'POST',
          checkPath(ROBOT_ID),
          robotFixture('robot-sample-004-no-timestamp.json'),
        )
      ).json(),
    );
    const empty = SourceFileInspectionSchema.parse(
      await (await sendFile(context, 'POST', checkPath(ROBOT_ID), '')).json(),
    );

    for (const result of [broken, noTimestamp, empty]) {
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.observedAt).toBeUndefined();
    }
  });

  it('値が範囲外などの項目は、警告にする（置ける。取り込みでは「不正」になる点を、項目名で知らせる。値は、含めない）', async () => {
    const context = await setup();
    const outOfRange = JSON.stringify({
      ...(JSON.parse(VALID) as Record<string, unknown>),
      harvestCount: -5,
    });

    const body = SourceFileInspectionSchema.parse(
      await (await sendFile(context, 'POST', checkPath(ROBOT_ID), outOfRange)).json(),
    );

    expect(body.ok).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('収穫数');
    expect(JSON.stringify(body)).not.toContain('-5');
  });

  it('環境センサーは、センサーの仕様で解釈する（ロボットのファイルは、置けない）', async () => {
    const context = await setup();
    const sensorSample = readFileSync(
      join(FIXTURES_DIRECTORY, 'file-server', 'environment-sensor', 'sensor-sample-001.json'),
      'utf8',
    );

    const ok = SourceFileInspectionSchema.parse(
      await (await sendFile(context, 'POST', checkPath(SENSOR_ID), sensorSample)).json(),
    );
    const robotFileForSensor = SourceFileInspectionSchema.parse(
      await (await sendFile(context, 'POST', checkPath(SENSOR_ID), VALID)).json(),
    );

    expect(ok.ok).toBe(true);
    expect(ok.formatLabel).toContain('environment-sensor-json');
    expect(robotFileForSensor.itemCount).not.toBe(7);
  });
});

describe('置く（PUT …/source-file）', () => {
  it('設備の sourceFilePath に、ファイルの内容のまま置く。応答に、置いた日時・検査の結果を返す。変更履歴に、内容を含めずに残す', async () => {
    const context = await setup();

    const response = await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);

    expect(response.status).toBe(200);
    const body = SourceFilePlacedSchema.parse(await response.json());
    expect(body).toMatchObject({ ok: true, itemCount: 7, size: Buffer.byteLength(VALID, 'utf8') });
    expect(body.placedAt).toBe(context.clock.now().toISOString());
    expect(await storedFile(context)).toBe(VALID);
    const audit = AuditLogListResponseSchema.parse(
      await (await context.request('/audit-logs?targetType=ingestion-settings')).json(),
    );
    const entry = audit.items.find((item) => item.targetId === `source-file/equipment/${ROBOT_ID}`);
    expect(entry).toMatchObject({
      operation: 'UPDATE',
      after: { size: Buffer.byteLength(VALID, 'utf8'), observedAt: '2026-10-09T02:00:00.000Z' },
    });
    expect(JSON.stringify(audit)).not.toContain('harvestCount');
  });

  it('同じパスに置き直すと、新しい内容に置き換わる', async () => {
    const context = await setup();
    await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);
    const updated = JSON.stringify({
      ...(JSON.parse(VALID) as Record<string, unknown>),
      timestamp: '2026-10-09T02:01:00Z',
      harvestCount: 140,
    });

    const response = await sendFile(context, 'PUT', putPath(ROBOT_ID), updated);

    expect(response.status).toBe(200);
    expect(await storedFile(context)).toBe(updated);
  });

  it('置けない内容（JSON でない・形式が違う・計測日時がない）は 400。置かず、すでにあるファイルを残す', async () => {
    const context = await setup();
    await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);

    for (const name of ['robot-sample-003-broken.json', 'robot-sample-004-no-timestamp.json']) {
      const response = await sendFile(context, 'PUT', putPath(ROBOT_ID), robotFixture(name));
      expect(response.status, name).toBe(400);
    }
    expect((await sendFile(context, 'PUT', putPath(ROBOT_ID), '')).status).toBe(400);
    expect(await storedFile(context)).toBe(VALID);
  });

  it('警告だけの内容（項目が範囲外）は、置ける', async () => {
    const context = await setup();
    const outOfRange = JSON.stringify({
      ...(JSON.parse(VALID) as Record<string, unknown>),
      harvestCount: -5,
    });

    const response = await sendFile(context, 'PUT', putPath(ROBOT_ID), outOfRange);

    expect(response.status).toBe(200);
    expect(SourceFilePlacedSchema.parse(await response.json()).warnings).toHaveLength(1);
    expect(await storedFile(context)).toBe(outOfRange);
  });

  it('API の本文の上限（1 MiB）を超えるファイルは、413（置かない）', async () => {
    const context = await setup();
    const big = `{"timestamp":"2026-10-09T02:00:00Z","x":"${'a'.repeat(1024 * 1024)}"}`;

    const response = await sendFile(context, 'PUT', putPath(ROBOT_ID), big);

    expect(response.status).toBe(413);
    expect(await storedFile(context)).toBeUndefined();
  });

  it('保管先の障害は 503（内容・パスを含めない）。保管先が設定されていないときも、503（機能が設定されていない旨）。検査は、保管先に依存しない', async () => {
    const failing = createMemoryHostedFileStore();
    failing.failWith(new Error('dummy-storage-down /secret/path'));
    const withFailing = await withEquipment({ hostedFileStore: failing });
    await withSourceFilePaths(withFailing);
    const withoutStore = await withEquipment({ hostedFileStore: null });
    await withSourceFilePaths(withoutStore);

    const failed = await sendFile(withFailing, 'PUT', putPath(ROBOT_ID), VALID);
    const notConfigured = await sendFile(withoutStore, 'PUT', putPath(ROBOT_ID), VALID);
    const checked = await sendFile(withoutStore, 'POST', checkPath(ROBOT_ID), VALID);

    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('dummy-storage-down');
    expect(notConfigured.status).toBe(503);
    expect(JSON.stringify(await notConfigured.json())).toContain('設定されていません');
    expect(checked.status).toBe(200);
  });
});

describe('対象の設備・権限', () => {
  it('ファイルのパスがない設備・ハウス・存在しない設備・削除した設備は、置けない（400・400・404・404）', async () => {
    const context = await withEquipment();
    const facility = (await context.container.repositories.equipment.list()).find(
      (item) => item.equipmentType === 'FACILITY',
    );

    const noPath = await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);
    const facilityResponse = await sendFile(
      context,
      'PUT',
      putPath(facility?.equipmentId ?? 'missing'),
      VALID,
    );
    const unknown = await sendFile(context, 'PUT', putPath('no-such-equipment'), VALID);

    expect(noPath.status).toBe(400);
    expect(JSON.stringify(await noPath.json())).toContain('ファイルのパス');
    expect(facilityResponse.status).toBe(400);
    expect(unknown.status).toBe(404);
    await withSourceFilePaths(context);
    const robot = await context.container.repositories.equipment.get(ROBOT_ID);
    if (robot !== undefined) {
      await context.container.repositories.equipment.save({ ...robot, isDeleted: true });
    }
    const deleted = await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);
    expect(deleted.status).toBe(404);
  });

  it('設定の権限（ingestion:configure）がない利用者（一般）は、検査も置くことも、できない（403）。ログインしていなければ 401', async () => {
    const context = await setup();
    const general = await addUserAndLogin(context, { userId: 'general-1', role: 'general' });

    const check = await sendFile(context, 'POST', checkPath(ROBOT_ID), VALID, general);
    const put = await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID, general);
    const anonymous = await context.app.request(`/api/v1${putPath(ROBOT_ID)}`, {
      method: 'PUT',
      body: VALID,
    });

    expect(check.status).toBe(403);
    expect(put.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(await storedFile(context)).toBeUndefined();
  });
});

describe('置いたファイルを、取り込みが読む（自前のファイルサーバーと同じ場所）', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const closing = server;
    server = undefined;
    if (closing !== undefined) {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => {
        closing.close(() => {
          resolve();
        });
      });
    }
  });

  it('画面から置く（PUT）→ ファイルサーバー（GET・HEAD。Bearer）→ 取り込みが、観測値を保存する', async () => {
    const context = await setup({ HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' });
    // 同じ保管先を、ファイルサーバーの入り口（Lambda のハンドラ）にも渡す
    const store = context.container.hostedFileStore;
    if (store === undefined) {
      throw new Error('テストの前提: 保管先がある');
    }
    const lambda = createHostedFileServerLambdaHandler(
      createHostedFileServer({
        store,
        secrets: createMemorySecretPort({
          [HOSTED_FILE_READ_TOKEN_REFERENCE]: 'dummy-read-token',
          [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: 'dummy-write-token',
        }),
        logger: NULL_LOGGER,
      }),
    );
    const listening = createServer((request, response) => {
      void lambda({
        rawPath: (request.url ?? '').split('?')[0] ?? '',
        requestContext: { http: { method: request.method ?? '' } },
        headers: { ...(request.headers as Record<string, string>) },
      }).then((result) => {
        response.writeHead(result.statusCode, result.headers);
        response.end(request.method === 'HEAD' ? undefined : result.body);
      });
    });
    server = listening;
    const port = await new Promise<number>((resolve) => {
      listening.listen(0, '127.0.0.1', () => {
        resolve((listening.address() as AddressInfo).port);
      });
    });
    await context.container.equipmentConnections.save(
      ROBOT_ID,
      FileServerConnectionSchema.parse({
        type: 'HTTP',
        protocol: 'HTTP',
        host: '127.0.0.1',
        port,
        authMethod: 'BEARER',
      }),
    );
    await context.container.secrets.set(
      fileServerEquipmentSecretReference(ROBOT_ID),
      'dummy-read-token',
    );
    const put = await sendFile(context, 'PUT', putPath(ROBOT_ID), VALID);
    // 書き換えの直後（更新日時が 1 秒以内）のファイルは、次の周期に回すため、時計を進める
    context.clock.advance(5_000);

    const summary = await context.container.ingestionService.runSource('robot');

    expect(put.status).toBe(200);
    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    const observations = await context.container.repositories.observations.query(
      { equipmentIds: [ROBOT_ID], includeDeleted: true },
      { limit: 50 },
    );
    expect(observations.items.length).toBeGreaterThan(0);
  });
});
