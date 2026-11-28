/**
 * 設備の削除（D-28。Issue #229）のジョブ（JB-05）の本体: 設備のデータを削除し、残すものを残す。
 * 削除が終わるまで（削除中）、設備の記録は削除済みで残る。取り込み・評価の実行中の書き込みを掃除するため、
 * 一度削除したあと、待ってから、もう一度削除して、設備の記録を消す。
 */

import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { createAuditService } from '../../../../src/backend/application/audit/audit-service.ts';
import { createEquipmentDeletionService } from '../../../../src/backend/application/equipment/equipment-deletion-service.ts';
import { fileServerEquipmentSecretReference } from '../../../../src/backend/application/ingestion/file-server-credentials.ts';
import { NULL_LOGGER } from '../../../../src/backend/application/ports/logger-port.ts';
import type { Repositories } from '../../../../src/backend/application/ports/repositories.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import { createSequentialIdGenerator } from '../../../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import {
  equipmentSet,
  FACILITY_ID,
  must,
  observation,
  ROBOT_ID,
  SENSOR_ID,
} from '../../../support/builders.ts';

const ADMIN = toUserId('admin-1');
const SWEEP_DELAY_MS = 6 * 60_000;
const NOW = new Date('2026-11-20T00:00:00.000Z');

interface Setup {
  readonly repositories: Repositories;
  readonly clock: ReturnType<typeof createControllableClock>;
  readonly secrets: ReturnType<typeof createMemorySecretPort>;
  readonly service: ReturnType<typeof createEquipmentDeletionService>;
}

async function setup(options: { budgetMs?: number } = {}): Promise<Setup> {
  const { repositories } = createLocalRepositories();
  const clock = createControllableClock(NOW);
  clock.freeze();
  const secrets = createMemorySecretPort();
  const ids = createSequentialIdGenerator('audit');
  const audit = createAuditService({
    auditLogs: repositories.auditLogs,
    users: repositories.users,
    clock,
    ids,
  });
  for (const equipment of equipmentSet()) {
    await repositories.equipment.save({
      ...equipment,
      ...(equipment.equipmentType === 'FACILITY'
        ? {}
        : { sourceFilePath: `/${equipment.equipmentId}.json` }),
    });
  }
  const service = createEquipmentDeletionService({
    repositories,
    secrets,
    listSources: () =>
      Promise.resolve([
        { sourceId: 'robot', kind: 'ROBOT' },
        { sourceId: 'environment-sensor', kind: 'SENSOR' },
      ]),
    audit,
    clock,
    logger: NULL_LOGGER,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  return { repositories, clock, secrets, service };
}

/** 設備を削除済みにして、削除の要求を出す（EquipmentService.delete と同じ状態にする）。 */
async function requestDeletion(subject: Setup, equipmentId: string): Promise<void> {
  const all = await subject.repositories.equipment.list();
  const target = must(all.find((item) => item.equipmentId === equipmentId));
  const children = all.filter((item) => item.facilityId === equipmentId);
  for (const item of [target, ...children]) {
    await subject.repositories.equipment.save({ ...item, isDeleted: true });
  }
  await subject.service.request(target, children, ADMIN);
}

/** ロボットのデータ（残すもの・削除するもの）を、一通り作る。 */
async function populate(subject: Setup): Promise<void> {
  const { repositories } = subject;
  await repositories.observations.saveMany([
    observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1 }),
    observation({ equipmentId: ROBOT_ID, itemKey: 'operationMinutes', value: 2, source: 'MANUAL' }),
    observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 20 }),
  ]);
  await repositories.manualEntries.save({
    entryId: 'e-1',
    equipmentId: ROBOT_ID,
    category: 'OPERABILITY',
    observedAt: '2026-10-09T01:00:00.000Z',
    items: { operationMinutes: 5 },
    enteredBy: ADMIN,
    createdAt: '2026-10-09T01:00:00.000Z',
    updatedAt: '2026-10-09T01:00:00.000Z',
    isDeleted: false,
  });
  await repositories.auditLogs.add({
    auditId: 'a-entry',
    operation: 'UPDATE',
    actor: ADMIN,
    occurredAt: '2026-10-09T02:00:00.000Z',
    targetType: 'manual-entry',
    targetId: 'e-1',
  });
  await repositories.auditLogs.add({
    auditId: 'a-equipment',
    operation: 'UPDATE',
    actor: ADMIN,
    occurredAt: '2026-10-09T02:00:00.000Z',
    targetType: 'equipment',
    targetId: ROBOT_ID,
  });
  await repositories.evaluations.appendStatusChange({
    equipmentId: ROBOT_ID,
    viewpointId: 'safety',
    status: 'CAUTION',
    changedAt: '2026-10-09T01:00:00.000Z',
  });
  await repositories.ingestion.recordEquipmentRuns([
    {
      equipmentId: ROBOT_ID,
      startedAt: NOW,
      finishedAt: NOW,
      result: 'SUCCESS',
      dataIngested: true,
    },
  ]);
  await repositories.ingestion.recordFile({
    sourceId: 'robot',
    fileId: `/${ROBOT_ID}.json`,
    contentHash: 'h1',
    fetchedAt: NOW.toISOString(),
    result: 'SUCCESS',
    recordCount: 1,
  });
  await repositories.ingestion.addLog({
    logId: 'l-1',
    sourceId: 'robot',
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    result: 'SUCCESS',
    filesProcessed: 1,
    recordCount: 1,
    rejectedCount: 0,
    attempts: 1,
    equipmentId: ROBOT_ID,
  });
  const federationBase = {
    targetType: 'EVALUATION' as const,
    payload: { equipmentId: ROBOT_ID },
    attempts: 0,
    enqueuedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    nextAttemptAt: NOW.toISOString(),
  };
  await repositories.federation.enqueue({
    ...federationBase,
    federationItemId: 'f-unsent',
    targetRef: 'unsent',
    status: 'PENDING',
  });
  await repositories.federation.enqueue({
    ...federationBase,
    federationItemId: 'f-sent',
    targetRef: 'sent',
    status: 'SENT',
  });
  await subject.secrets.set(fileServerEquipmentSecretReference(ROBOT_ID), 'dummy-token');
}

describe('設備の削除ジョブ', () => {
  it('削除の要求で、削除中の記録（データの削除中）が残り、画面に出す一覧に、設備の名前が出る', async () => {
    const subject = await setup();

    await requestDeletion(subject, ROBOT_ID);

    const items = await subject.service.list();
    expect(items).toEqual([
      expect.objectContaining({
        equipmentId: ROBOT_ID,
        status: 'DELETING',
        childNames: [],
      }),
    ]);
    expect(await subject.repositories.equipmentDeletions.get(ROBOT_ID)).toMatchObject({
      phase: 'PURGING',
      attempts: 0,
    });
  });

  it('1 回目: 設備のデータを削除し、残すものを残す。設備の記録は、削除済みのまま残り、掃除の待ちになる', async () => {
    const subject = await setup();
    await populate(subject);
    await requestDeletion(subject, ROBOT_ID);

    const summary = await subject.service.run();

    const { repositories } = subject;
    expect(summary).toMatchObject({ processed: 1, finalized: 0, failed: 0 });
    // 削除したもの
    expect(
      (await repositories.observations.query({ equipmentIds: [ROBOT_ID] }, { limit: 10 })).items,
    ).toEqual([]);
    expect(await repositories.manualEntries.get('e-1')).toBeUndefined();
    expect(
      (await repositories.auditLogs.list({ targetType: 'manual-entry' }, { limit: 10 })).items,
    ).toEqual([]);
    expect(await repositories.evaluations.listStatusChanges(ROBOT_ID, 'safety')).toEqual([]);
    expect([...(await repositories.ingestion.listEquipmentRuns()).keys()]).toEqual([]);
    expect(
      await repositories.ingestion.findIngestedFile('robot', `/${ROBOT_ID}.json`, 'h1'),
    ).toBeUndefined();
    expect(await repositories.federation.countByStatus()).toMatchObject({ PENDING: 0, SENT: 1 });
    expect(await subject.secrets.get(fileServerEquipmentSecretReference(ROBOT_ID))).toBeUndefined();
    // 残すもの
    expect(
      (await repositories.observations.query({ equipmentIds: [SENSOR_ID] }, { limit: 10 })).items,
    ).toHaveLength(1);
    expect(
      (await repositories.auditLogs.list({ targetType: 'equipment' }, { limit: 10 })).items,
    ).toHaveLength(1);
    expect((await repositories.ingestion.listLogs({}, { limit: 10 })).items).toHaveLength(1);
    // 設備の記録は、削除済みのまま残る。要求は、掃除の待ち
    expect(await repositories.equipment.get(ROBOT_ID)).toMatchObject({ isDeleted: true });
    expect(await repositories.equipmentDeletions.get(ROBOT_ID)).toMatchObject({
      phase: 'SWEEPING',
      sweepAfter: new Date(NOW.getTime() + SWEEP_DELAY_MS).toISOString(),
      deleted: { observations: 2, manualEntries: 1, unsentFederationItems: 1 },
    });
  });

  it('掃除の待ちの間は、何もしない。待ちを過ぎたら、もう一度削除し（実行中の書き込みを掃除）、設備の記録と要求を消して、削除の記録（件数）を残す', async () => {
    const subject = await setup();
    await populate(subject);
    await requestDeletion(subject, ROBOT_ID);
    await subject.service.run();
    // 削除のあとに、実行中だった取り込みが書いたもの
    await subject.repositories.observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 9 }),
    ]);
    await subject.repositories.ingestion.recordEquipmentRuns([
      {
        equipmentId: ROBOT_ID,
        startedAt: NOW,
        finishedAt: NOW,
        result: 'SUCCESS',
        dataIngested: true,
      },
    ]);

    subject.clock.advance(SWEEP_DELAY_MS - 1);
    const waiting = await subject.service.run();
    expect(waiting).toMatchObject({ processed: 0, finalized: 0 });
    expect(await subject.repositories.equipment.get(ROBOT_ID)).toBeDefined();

    subject.clock.advance(1);
    const finished = await subject.service.run();

    const { repositories } = subject;
    expect(finished).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
    expect(
      (await repositories.observations.query({ equipmentIds: [ROBOT_ID] }, { limit: 10 })).items,
    ).toEqual([]);
    expect([...(await repositories.ingestion.listEquipmentRuns()).keys()]).toEqual([]);
    expect(await repositories.equipment.get(ROBOT_ID)).toBeUndefined();
    expect(await repositories.equipmentDeletions.get(ROBOT_ID)).toBeUndefined();
    expect(await subject.service.list()).toEqual([]);
    // 削除の記録: 設備の変更履歴に、削除した設備と件数を残す
    const history = (
      await repositories.auditLogs.list(
        { targetType: 'equipment', targetId: ROBOT_ID, operation: 'DELETE' },
        { limit: 10 },
      )
    ).items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actor: ADMIN,
      before: {
        equipmentIds: [ROBOT_ID],
        deleted: { observations: 3, manualEntries: 1, unsentFederationItems: 1 },
      },
    });
  });

  it('ハウスの削除: 配下のロボット・センサーも削除し、ハウスの閲覧の割り当ても削除する', async () => {
    const subject = await setup();
    await subject.repositories.facilityAccess.save({ facilityId: FACILITY_ID, userIds: [ADMIN] });
    await subject.repositories.observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1 }),
      observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 20 }),
    ]);
    await requestDeletion(subject, FACILITY_ID);

    await subject.service.run();
    subject.clock.advance(SWEEP_DELAY_MS);
    await subject.service.run();

    const { repositories } = subject;
    expect((await repositories.observations.query({}, { limit: 10 })).items).toEqual([]);
    expect(await repositories.facilityAccess.get(FACILITY_ID)).toBeUndefined();
    expect(await repositories.equipment.list({ includeDeleted: true })).toEqual([]);
    expect(await repositories.equipmentDeletions.list()).toEqual([]);
  });

  it('途中で失敗したら、エラーの種類だけを記録して、次の実行で続きから削除する（再実行できる）', async () => {
    const subject = await setup();
    await populate(subject);
    await requestDeletion(subject, ROBOT_ID);
    const original = subject.repositories.evaluations.deleteByEquipment.bind(
      subject.repositories.evaluations,
    );
    let fail = true;
    (subject.repositories.evaluations as { deleteByEquipment: typeof original }).deleteByEquipment =
      (equipmentId) => {
        if (fail) {
          return Promise.reject(
            Object.assign(new Error('arn:aws:dynamodb:dummy 詳細'), {
              name: 'ThrottlingException',
            }),
          );
        }
        return original(equipmentId);
      };

    const failedRun = await subject.service.run();

    expect(failedRun).toMatchObject({ processed: 1, failed: 1 });
    const failed = await subject.repositories.equipmentDeletions.get(ROBOT_ID);
    expect(failed).toMatchObject({
      phase: 'PURGING',
      attempts: 1,
      lastError: 'ThrottlingException',
    });
    expect(JSON.stringify(failed)).not.toContain('arn:aws');
    expect(await subject.service.list()).toEqual([
      expect.objectContaining({ equipmentId: ROBOT_ID, status: 'FAILED' }),
    ]);

    fail = false;
    const retried = await subject.service.run();

    expect(retried).toMatchObject({ processed: 1, failed: 0 });
    expect(await subject.repositories.equipmentDeletions.get(ROBOT_ID)).toMatchObject({
      phase: 'SWEEPING',
      attempts: 2,
    });
    expect(
      (await subject.repositories.equipmentDeletions.get(ROBOT_ID))?.lastError,
    ).toBeUndefined();
  });

  it('1 回の実行の時間の上限を超えたら、途中で止め、次の実行で、続きから削除する（観測値が多いとき）', async () => {
    const subject = await setup({ budgetMs: 0 });
    await populate(subject);
    await requestDeletion(subject, ROBOT_ID);
    const original = subject.repositories.observations.deleteByEquipment.bind(
      subject.repositories.observations,
    );
    let stopped = 0;
    (
      subject.repositories.observations as { deleteByEquipment: typeof original }
    ).deleteByEquipment = (equipmentId, budget) => {
      if (budget?.shouldStop() === true && stopped === 0) {
        // 上限に達したため、途中で止めた（1 件だけ削除した）
        stopped += 1;
        return Promise.resolve({ deleted: 1, completed: false });
      }
      return original(equipmentId, budget);
    };

    const first = await subject.service.run();

    expect(first).toMatchObject({ processed: 1, finalized: 0, failed: 0 });
    // 掃除の待ちには、進まない。それまでに削除した件数は、記録する
    expect(await subject.repositories.equipmentDeletions.get(ROBOT_ID)).toMatchObject({
      phase: 'PURGING',
      attempts: 1,
      deleted: { observations: 1 },
    });

    // 上限は、実行ごとに数える。次の実行で、続きから削除する（ここでは、上限が 0 のため、止まらないのは、止めた回数で制御）
    const second = await subject.service.run();

    expect(second).toMatchObject({ processed: 1, failed: 0 });
    expect(await subject.repositories.equipmentDeletions.get(ROBOT_ID)).toMatchObject({
      phase: 'SWEEPING',
    });
  });
});
