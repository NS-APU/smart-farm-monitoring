/**
 * 設備のデータの削除（D-28。Issue #229）に使う、Repository の削除用のメソッドの契約テスト。
 * 実装（メモリ・ファイル永続化・DynamoDB）ごとに、同じ振る舞いを確かめる。削除は、対象の設備のデータだけに作用し、
 * 残すもの（取り込みログ・通知・設備の変更履歴など）と、ほかの設備のデータは、残る。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type { Repositories } from '../../src/backend/application/ports/repositories.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import {
  equipmentSet,
  FACILITY_ID,
  must,
  observation,
  ROBOT_ID,
  SENSOR_ID,
} from '../support/builders.ts';
import {
  createDynamoRepositoriesForTest,
  dropDynamoTestTables,
} from '../support/dynamodb-test-database.ts';

const FACTORIES: readonly { readonly name: string; readonly create: () => Repositories }[] = [
  { name: 'メモリ', create: () => createLocalRepositories().repositories },
  {
    name: 'ファイル永続化',
    create: () =>
      createLocalRepositories({
        filePath: join(mkdtempSync(join(tmpdir(), 'smart-farm-purge-')), 'store.json'),
        flushDelayMs: 0,
      }).repositories,
  },
  { name: 'DynamoDB', create: () => createDynamoRepositoriesForTest() },
];

afterAll(dropDynamoTestTables);

const USER = toUserId('user-1');

const manualEntry = (
  entryId: string,
  equipmentId: ManualEntry['equipmentId'],
  overrides: Partial<ManualEntry> = {},
): ManualEntry => ({
  entryId,
  equipmentId,
  category: 'OPERABILITY',
  observedAt: '2026-10-09T01:00:00.000Z',
  items: { operationMinutes: 5 },
  enteredBy: USER,
  createdAt: '2026-10-09T01:00:00.000Z',
  updatedAt: '2026-10-09T01:00:00.000Z',
  isDeleted: false,
  ...overrides,
});

const federationItem = (
  id: string,
  status: FederationItem['status'],
  equipmentId: string,
  shape: 'evaluation' | 'observations' | 'equipment' = 'evaluation',
): FederationItem => ({
  federationItemId: id,
  targetType:
    shape === 'evaluation' ? 'EVALUATION' : shape === 'equipment' ? 'EQUIPMENT' : 'OBSERVATION',
  targetRef: `${equipmentId}#${id}`,
  payload:
    shape === 'observations'
      ? { observations: [{ equipmentId, itemKey: 'harvestCount' }] }
      : { equipmentId },
  status,
  attempts: 0,
  enqueuedAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  nextAttemptAt: '2026-10-09T00:00:00.000Z',
});

describe.each(FACTORIES)('設備のデータの削除用の Repository（$name）', ({ create }) => {
  it('設備の記録: 物理削除すると、削除済みも含めて、取り出せない。ない設備の削除は、成功する。ほかの設備は、残る', async () => {
    const { equipment } = create();
    for (const item of equipmentSet()) {
      await equipment.save(item);
    }
    await equipment.save({
      ...must(await equipment.get(ROBOT_ID)),
      isDeleted: true,
    });

    await equipment.delete(ROBOT_ID);
    await equipment.delete(ROBOT_ID);

    expect(await equipment.get(ROBOT_ID)).toBeUndefined();
    expect(
      (await equipment.list({ includeDeleted: true })).map((item) => item.equipmentId),
    ).toEqual(expect.arrayContaining([FACILITY_ID, SENSOR_ID]));
    expect(await equipment.list({ includeDeleted: true })).toHaveLength(2);
  });

  it('観測値: 設備の観測値（自動・手動・論理削除済み）と、最終の受信日時を削除する。ほかの設備は、残る', async () => {
    const { observations } = create();
    await observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1 }),
      observation({ equipmentId: ROBOT_ID, itemKey: 'operationMinutes', value: 2 }),
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
        value: 3,
        source: 'MANUAL',
        observedAt: '2026-10-09T03:00:00.000Z',
      }),
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
        value: 4,
        isDeleted: true,
        observedAt: '2026-10-09T04:00:00.000Z',
      }),
      observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 20 }),
    ]);

    const result = await observations.deleteByEquipment(ROBOT_ID);

    expect(result).toEqual({ deleted: 4, completed: true });
    const rest = await observations.query({}, { limit: 100 });
    expect(rest.items.map((item) => item.equipmentId)).toEqual([SENSOR_ID]);
    expect((await observations.query({ equipmentIds: [ROBOT_ID] }, { limit: 100 })).items).toEqual(
      [],
    );
    expect(
      (await observations.query({ equipmentIds: [ROBOT_ID], source: 'MANUAL' }, { limit: 100 }))
        .items,
    ).toEqual([]);
    expect(await observations.latestReceivedAt([ROBOT_ID])).toBeNull();
    expect((await observations.receivedAtByEquipment([ROBOT_ID, SENSOR_ID])).size).toBe(1);
    // 冪等: もう一度削除しても、何も消さず、完了する
    expect(await observations.deleteByEquipment(ROBOT_ID)).toEqual({ deleted: 0, completed: true });
  });

  it('観測値: 中断（shouldStop）しても、もう一度呼ぶと、続きから削除し、最後には、すべて消える', async () => {
    const { observations } = create();
    await observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1 }),
      observation({ equipmentId: ROBOT_ID, itemKey: 'operationMinutes', value: 2 }),
      observation({ equipmentId: ROBOT_ID, itemKey: 'standbyHours', value: 3 }),
    ]);

    const first = await observations.deleteByEquipment(ROBOT_ID, { shouldStop: () => true });
    const second = await observations.deleteByEquipment(ROBOT_ID);

    expect(first.deleted + second.deleted).toBe(3);
    expect(second.completed).toBe(true);
    expect((await observations.query({ equipmentIds: [ROBOT_ID] }, { limit: 10 })).items).toEqual(
      [],
    );
    expect(await observations.latestReceivedAt([ROBOT_ID])).toBeNull();
  });

  it('手動入力: 設備の手動入力（論理削除済みも）を削除し、入力の ID を返す。ほかの設備は、残る', async () => {
    const { manualEntries } = create();
    await manualEntries.save(manualEntry('e-1', ROBOT_ID));
    await manualEntries.save(manualEntry('e-2', ROBOT_ID, { isDeleted: true }));
    await manualEntries.save(
      manualEntry('e-3', ROBOT_ID, { observedAt: '2026-10-09T05:00:00.000Z' }),
    );
    await manualEntries.save(manualEntry('e-4', SENSOR_ID, { category: 'ENVIRONMENT' }));

    const removed = await manualEntries.deleteByEquipment(ROBOT_ID);

    expect([...removed].sort()).toEqual(['e-1', 'e-2', 'e-3']);
    expect(await manualEntries.get('e-1')).toBeUndefined();
    expect(await manualEntries.get('e-2')).toBeUndefined();
    expect(await manualEntries.get('e-4')).toBeDefined();
    expect((await manualEntries.list({}, { limit: 10 })).items.map((item) => item.entryId)).toEqual(
      ['e-4'],
    );
    expect(await manualEntries.deleteByEquipment(ROBOT_ID)).toEqual([]);
  });

  it('変更履歴: 指定した種類・ID の履歴だけを削除し、件数を返す。ほかの種類・ID は、残る', async () => {
    const { auditLogs } = create();
    const entry = (
      auditId: string,
      targetType: 'manual-entry' | 'equipment',
      targetId: string,
    ) => ({
      auditId,
      operation: 'UPDATE' as const,
      actor: USER,
      occurredAt: `2026-10-09T0${auditId.slice(-1)}:00:00.000Z`,
      targetType,
      targetId,
    });
    await auditLogs.add(entry('a-1', 'manual-entry', 'e-1'));
    await auditLogs.add(entry('a-2', 'manual-entry', 'e-2'));
    await auditLogs.add(entry('a-3', 'manual-entry', 'e-9'));
    await auditLogs.add(entry('a-4', 'equipment', 'e-1'));

    const count = await auditLogs.deleteByTargets('manual-entry', ['e-1', 'e-2']);

    expect(count).toBe(2);
    const rest = await auditLogs.list({}, { limit: 10 });
    expect(rest.items.map((item) => item.auditId).sort()).toEqual(['a-3', 'a-4']);
    expect(await auditLogs.deleteByTargets('manual-entry', [])).toBe(0);
  });

  it('評価結果: 設備の最新の評価結果と、ステータスの変化（最終・履歴）を、すべての観点について削除する。ほかの設備は、残る', async () => {
    const { evaluations } = create();
    const result = (equipmentId: typeof ROBOT_ID, viewpointId: 'safety' | 'durability') => ({
      equipmentId,
      viewpointId,
      horizon: 'SHORT' as const,
      periodDays: null,
      status: 'NORMAL' as const,
      metrics: {},
      indicatorStatuses: {},
      statusDetail: null,
      diagnosticMessage: '正常',
      recommendedAction: '維持',
      criteriaVersion: 'DEFAULT',
      isCustomCriteria: false,
      evaluatedFrom: '2026-10-08T03:00:00.000Z',
      evaluatedTo: '2026-10-09T03:00:00.000Z',
      evaluatedAt: '2026-10-09T03:00:00.000Z',
    });
    for (const equipmentId of [ROBOT_ID, SENSOR_ID]) {
      for (const viewpointId of ['safety', 'durability'] as const) {
        await evaluations.saveLatest(result(equipmentId, viewpointId));
        await evaluations.appendStatusChange({
          equipmentId,
          viewpointId,
          status: 'CAUTION',
          changedAt: '2026-10-09T01:00:00.000Z',
        });
      }
    }

    await evaluations.deleteByEquipment(ROBOT_ID);

    expect(await evaluations.listLatest(ROBOT_ID)).toEqual([]);
    for (const viewpointId of ['safety', 'durability'] as const) {
      expect(await evaluations.getLastStatusChange(ROBOT_ID, viewpointId)).toBeUndefined();
      expect(await evaluations.listStatusChanges(ROBOT_ID, viewpointId)).toEqual([]);
    }
    expect(await evaluations.listLatest(SENSOR_ID)).toHaveLength(2);
    expect(await evaluations.listStatusChanges(SENSOR_ID, 'safety')).toHaveLength(1);
    await expect(evaluations.deleteByEquipment(ROBOT_ID)).resolves.toBeUndefined();
  });

  it('取り込み: 設備ごとの最終の実行と、設備のファイルの取り込み済みの記録を削除する。取り込みログ（設備ごと）は残り、一覧から見える', async () => {
    const { ingestion } = create();
    const at = new Date('2026-10-09T01:00:00.000Z');
    await ingestion.recordEquipmentRuns(
      ['ROBOT-T1', 'SENSOR-T1'].map((equipmentId) => ({
        equipmentId,
        startedAt: at,
        finishedAt: at,
        result: 'SUCCESS' as const,
        dataIngested: true,
      })),
    );
    await ingestion.recordFile({
      sourceId: 'robot',
      fileId: 'robot/latest.json',
      contentHash: 'h1',
      fetchedAt: at.toISOString(),
      result: 'SUCCESS',
      recordCount: 1,
    });
    await ingestion.recordFile({
      sourceId: 'environment-sensor',
      fileId: 'sensor/latest.json',
      contentHash: 'h2',
      fetchedAt: at.toISOString(),
      result: 'SUCCESS',
      recordCount: 1,
    });
    await ingestion.addLog({
      logId: 'l-1',
      sourceId: 'robot',
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 1,
      rejectedCount: 0,
      attempts: 1,
      equipmentId: toEquipmentId('ROBOT-T1'),
    });

    await ingestion.deleteEquipmentRecords('ROBOT-T1', {
      sourceId: 'robot',
      fileId: 'robot/latest.json',
    });

    expect([...(await ingestion.listEquipmentRuns()).keys()]).toEqual(['SENSOR-T1']);
    expect(await ingestion.findIngestedFile('robot', 'robot/latest.json', 'h1')).toBeUndefined();
    expect(
      await ingestion.findIngestedFile('environment-sensor', 'sensor/latest.json', 'h2'),
    ).toBeDefined();
    // 設備ごとの取り込みログは残り、設備を指定しない一覧からも見える
    expect((await ingestion.listLogs({}, { limit: 10 })).items.map((log) => log.logId)).toEqual([
      'l-1',
    ]);
    await expect(ingestion.deleteEquipmentRecords('ROBOT-T1')).resolves.toBeUndefined();
  });

  it('連携: 設備の送信していない項目（待機・失敗・保留。評価・観測値・設備の内容）を破棄し、状態ごとの件数を減らす。送信済み・ほかの設備は、残る', async () => {
    const { federation } = create();
    await federation.enqueue(federationItem('f-1', 'PENDING', 'ROBOT-T1'));
    await federation.enqueue(federationItem('f-2', 'HELD', 'ROBOT-T1', 'observations'));
    await federation.enqueue(federationItem('f-3', 'FAILED', 'ROBOT-T1', 'equipment'));
    await federation.enqueue(federationItem('f-4', 'SENT', 'ROBOT-T1'));
    await federation.enqueue(federationItem('f-5', 'FAILED', 'SENSOR-T1'));

    const discarded = await federation.discardUnsentByEquipment('ROBOT-T1');

    expect(discarded).toBe(3);
    expect(await federation.countByStatus()).toEqual({
      PENDING: 0,
      SENT: 1,
      FAILED: 1,
      HELD: 0,
      EXPIRED: 0,
    });
    const due = await federation.listDue(new Date('2026-10-10T00:00:00.000Z'), 10);
    expect(due.map((item) => item.federationItemId)).toEqual(['f-5']);
    expect(await federation.discardUnsentByEquipment('ROBOT-T1')).toBe(0);
  });

  it('設備の削除の要求: 保存・取得・一覧（設備 ID の順）・削除。同じ設備は上書きする', async () => {
    const { equipmentDeletions } = create();
    const deletion = (equipmentId: string, attempts = 0) => ({
      equipmentId: toEquipmentId(equipmentId),
      targets: [{ equipmentId: toEquipmentId(equipmentId), name: '名前', equipmentType: 'ROBOT' }],
      requestedBy: USER,
      requestedAt: '2026-10-09T01:00:00.000Z',
      phase: 'PURGING' as const,
      attempts,
      deleted: { observations: 0, manualEntries: 0, unsentFederationItems: 0 },
    });
    await equipmentDeletions.save(deletion('ROBOT-T2'));
    await equipmentDeletions.save(deletion('ROBOT-T1'));
    await equipmentDeletions.save(deletion('ROBOT-T1', 2));

    expect((await equipmentDeletions.get(toEquipmentId('ROBOT-T1')))?.attempts).toBe(2);
    expect((await equipmentDeletions.list()).map((item) => item.equipmentId)).toEqual([
      'ROBOT-T1',
      'ROBOT-T2',
    ]);
    await equipmentDeletions.delete(toEquipmentId('ROBOT-T1'));
    await equipmentDeletions.delete(toEquipmentId('ROBOT-T1'));
    expect(await equipmentDeletions.get(toEquipmentId('ROBOT-T1'))).toBeUndefined();
    expect(await equipmentDeletions.list()).toHaveLength(1);
  });
});
