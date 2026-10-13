/**
 * 負荷テストの大量データ（合成データ）の投入。バックエンドの起動時に、Repository へ直接入れる。
 * 規模は scale.ts の定数。実データ・個人情報は使わない。乱数は種つき（同じ種で同じデータ）。
 * 投入の後に、評価（全設備）を1回行い、ダッシュボードなどが、評価済みの状態で始まるようにする（取り込み・手動入力の保存後と同じ）。
 */

import { MANUAL_INPUT_CATEGORIES, itemsOfCategory } from '@smart-farm/shared/constants/items';
import { VIEWPOINT_IDS, viewpointsForEquipmentType } from '@smart-farm/shared/constants/viewpoints';
import {
  NotificationIdSchema,
  toEquipmentId,
  toUserId,
  type EquipmentId,
} from '@smart-farm/shared/schemas/common';
import {
  AUDIT_OPERATIONS,
  AUDIT_TARGET_TYPES,
  type AuditLogEntry,
} from '@smart-farm/shared/schemas/audit';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { Container } from '../../../src/backend/runtime/container.ts';
import { hashPassword } from '../../../src/backend/infrastructure/local/password-hasher.ts';
import {
  buildSeededObservation,
  createRandom,
  generateAutoObservations,
} from '../../../src/backend/infrastructure/local/synthetic-data.ts';
import {
  STRESS_SCALE,
  STRESS_SEED,
  STRESS_USER_PASSWORD,
  robotExternalId,
  robotId,
  sensorExternalId,
  sensorId,
  stressUserId,
  type StressScale,
} from './scale.ts';

/** 投入した件数（結果ログの「データ規模」に記載する）。 */
export interface SeedSummary {
  readonly scale: StressScale;
  readonly equipment: {
    readonly houses: number;
    readonly robots: number;
    readonly sensors: number;
  };
  readonly autoObservations: number;
  readonly manualObservations: number;
  readonly observationsTotal: number;
  readonly statusCodesTotal: number;
  readonly notifications: number;
  readonly unreadNotifications: number;
  readonly auditLogs: number;
  readonly manualEntries: number;
  readonly ingestionLogs: number;
  readonly ingestedFileRecords: number;
  readonly federationItems: number;
  readonly federationLogs: number;
  readonly statusChanges: number;
  readonly users: number;
  readonly historyFrom: string;
  readonly historyTo: string;
  readonly seedSeconds: number;
}

interface SeededEquipment {
  readonly houses: readonly EquipmentId[];
  readonly robots: readonly EquipmentId[];
  readonly sensors: readonly EquipmentId[];
  readonly pairs: readonly {
    readonly robot: EquipmentId;
    readonly sensor: EquipmentId;
    readonly intervalMinutes: number;
  }[];
}

const SAVE_CHUNK = 50_000;
const SOURCES = ['robot', 'environment-sensor'] as const;
/** 通知・ログなど（自動取り込みの観測値以外）の合成データの最も新しい時刻は、現在の2時間前（通知の重複抑制 60分に当たらない）。 */
const RECENT_GUARD_MS = 2 * 3_600_000;

function pick<Value>(values: readonly Value[], random: () => number): Value {
  return values[Math.floor(random() * values.length)] as Value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 過去の時刻（現在の2時間前から、保存期間の範囲）を、分単位でランダムに選ぶ。 */
function randomPastMs(now: Date, scale: StressScale, random: () => number): number {
  return (
    now.getTime() -
    RECENT_GUARD_MS -
    Math.floor(random() * scale.historyDays * 24 * 60) * MS_PER_MINUTE
  );
}

async function saveObservations(
  container: Container,
  observations: readonly Observation[],
): Promise<void> {
  for (let start = 0; start < observations.length; start += SAVE_CHUNK) {
    await container.repositories.observations.saveMany(
      observations.slice(start, start + SAVE_CHUNK),
    );
  }
}

/** ハウス・ロボット・センサー（設備）を登録する。 */
async function seedEquipment(
  container: Container,
  now: Date,
  scale: StressScale,
): Promise<SeededEquipment> {
  const createdAt = iso(now.getTime() - scale.historyDays * MS_PER_DAY);
  const robots: EquipmentId[] = [];
  const sensors: EquipmentId[] = [];
  const houses: EquipmentId[] = [];
  const pairs: { robot: EquipmentId; sensor: EquipmentId; intervalMinutes: number }[] = [];
  for (const [houseIndex, house] of scale.houses.entries()) {
    const houseId = toEquipmentId(house.houseId);
    houses.push(houseId);
    const items: Equipment[] = [
      {
        equipmentId: houseId,
        equipmentType: 'FACILITY',
        name: house.name,
        isDeleted: false,
        createdAt,
      },
    ];
    for (let unit = 0; unit < house.units; unit += 1) {
      const robot = toEquipmentId(robotId(houseIndex, unit));
      const sensor = toEquipmentId(sensorId(houseIndex, unit));
      robots.push(robot);
      sensors.push(sensor);
      pairs.push({ robot, sensor, intervalMinutes: house.intervalMinutes });
      items.push(
        {
          equipmentId: robot,
          equipmentType: 'ROBOT',
          name: `負荷試験ロボット${String(houseIndex + 1)}-${String(unit + 1)}`,
          facilityId: houseId,
          externalId: robotExternalId(houseIndex, unit),
          isDeleted: false,
          createdAt,
        },
        {
          equipmentId: sensor,
          equipmentType: 'SENSOR',
          name: `負荷試験センサー${String(houseIndex + 1)}-${String(unit + 1)}`,
          facilityId: houseId,
          externalId: sensorExternalId(houseIndex, unit),
          isDeleted: false,
          createdAt,
        },
      );
    }
    for (const equipment of items) {
      await container.repositories.equipment.save(equipment);
    }
  }
  return { houses, robots, sensors, pairs };
}

/** 2人目以降の利用者を追加する（1人目は、起動時に作成済みの初期ユーザー。同じダミーのパスワード）。 */
async function seedUsers(container: Container, now: Date, scale: StressScale): Promise<void> {
  const passwordHash = hashPassword(STRESS_USER_PASSWORD);
  for (let index = 1; index < scale.users; index += 1) {
    await container.repositories.users.save({
      userId: toUserId(stressUserId(index)),
      userName: `負荷試験ユーザー${String(index + 1).padStart(2, '0')}`,
      role: 'worker',
      passwordHash,
      createdAt: iso(now.getTime()),
    });
  }
}

async function seedStatusCodes(container: Container, scale: StressScale): Promise<void> {
  const categories = ['NORMAL', 'CAUTION', 'ERROR'] as const;
  for (let index = 0; index < scale.statusCodes; index += 1) {
    await container.repositories.statusCodes.save({
      code: `STRESS_CODE_${String(index + 1).padStart(4, '0')}`,
      name: `負荷試験コード${String(index + 1)}`,
      category: categories[index % categories.length] ?? 'NORMAL',
      description: '負荷試験用の合成データ',
      isDeleted: false,
    });
  }
}

/** 手動入力（1回の入力）と、その観測値。観測値の件数を返す。 */
async function seedManualEntries(
  container: Container,
  now: Date,
  scale: StressScale,
  targets: readonly EquipmentId[],
  random: () => number,
): Promise<number> {
  const user = toUserId(stressUserId(0));
  const observations: Observation[] = [];
  const usedKeys = new Set<string>();
  for (let index = 0; index < scale.manualEntries; index += 1) {
    const category = pick(MANUAL_INPUT_CATEGORIES, random);
    const equipmentId = pick(targets, random);
    // 分単位で一意にする（同じ設備・項目・計測日時の重複を避ける）
    let observedMs = randomPastMs(now, scale, random);
    while (usedKeys.has(`${equipmentId}#${category}#${String(observedMs)}`)) {
      observedMs -= MS_PER_MINUTE;
    }
    usedKeys.add(`${equipmentId}#${category}#${String(observedMs)}`);
    const items: Record<string, number> = {};
    for (const item of itemsOfCategory(category).filter((candidate) =>
      candidate.origins.includes('MANUAL'),
    )) {
      const min = item.min ?? 0;
      const max = Math.min(item.max ?? min + 20, min + 20);
      const value = min + random() * (max - min);
      items[item.itemKey] =
        item.valueType === 'integer' ? Math.round(value) : Math.round(value * 10) / 10;
    }
    const entryId = `seed-entry-${String(index + 1).padStart(5, '0')}`;
    const entry: ManualEntry = {
      entryId,
      equipmentId,
      category,
      observedAt: iso(observedMs),
      items,
      ...(index % 3 === 0 ? { note: `負荷試験の合成データ ${String(index + 1)}` } : {}),
      enteredBy: user,
      createdAt: iso(observedMs),
      updatedAt: iso(observedMs),
      isDeleted: false,
    };
    await container.repositories.manualEntries.save(entry);
    for (const [itemKey, value] of Object.entries(items)) {
      observations.push({
        ...buildSeededObservation({
          equipmentId,
          itemKey,
          observedAt: new Date(observedMs),
          value,
          source: 'MANUAL',
          quality: 'VALID',
        }),
        enteredBy: user,
        manualEntryId: entryId,
      });
    }
  }
  await saveObservations(container, observations);
  return observations.length;
}

async function seedNotifications(
  container: Container,
  now: Date,
  scale: StressScale,
  targets: readonly EquipmentId[],
  random: () => number,
): Promise<{ total: number; unread: number }> {
  const readUser = toUserId(stressUserId(0));
  let unread = 0;
  for (let index = 0; index < scale.notifications; index += 1) {
    const createdMs = randomPastMs(now, scale, random);
    const isIngestion = random() < 0.2;
    const viewpointId = pick(VIEWPOINT_IDS, random);
    const status = random() < 0.6 ? 'CAUTION' : 'ERROR';
    const equipmentId = pick(targets, random);
    const sourceId = pick(SOURCES, random);
    const number = String(index + 1);
    const notification: Notification = {
      notificationId: NotificationIdSchema.parse(`seed-notification-${number.padStart(5, '0')}`),
      kind: isIngestion ? 'INGESTION_FAILURE' : 'STATUS_CHANGE',
      ...(isIngestion ? { sourceId } : { viewpointId, equipmentId, status }),
      message: isIngestion
        ? `${sourceId}の取り込みに失敗しました（負荷試験の合成データ ${number}）`
        : `${viewpointId}が${status === 'ERROR' ? '異常' : '注意'}になりました（負荷試験の合成データ ${number}）`,
      createdAt: iso(createdMs),
      dedupKey: `seed:${number}`,
      deliveries: [
        { channel: 'IN_APP', result: 'SUCCESS', attempts: 1, updatedAt: iso(createdMs) },
      ],
    };
    await container.repositories.notifications.add(notification);
    // 約3割を、1人目の利用者が既読にしている（残りは未読）
    if (random() < 0.3) {
      await container.repositories.notifications.markRead(
        notification.notificationId,
        readUser,
        new Date(createdMs + MS_PER_MINUTE),
      );
    } else {
      unread += 1;
    }
  }
  return { total: scale.notifications, unread };
}

async function seedAuditLogs(
  container: Container,
  now: Date,
  scale: StressScale,
  random: () => number,
): Promise<void> {
  for (let index = 0; index < scale.auditLogs; index += 1) {
    const entry: AuditLogEntry = {
      auditId: `seed-audit-${String(index + 1).padStart(5, '0')}`,
      occurredAt: iso(randomPastMs(now, scale, random)),
      operation: pick(AUDIT_OPERATIONS, random),
      targetType: pick(AUDIT_TARGET_TYPES, random),
      targetId: `seed-target-${String(Math.floor(random() * 500))}`,
      actor: toUserId(stressUserId(Math.floor(random() * scale.users))),
      before: { value: Math.round(random() * 100) },
      after: { value: Math.round(random() * 100) },
    };
    await container.repositories.auditLogs.add(entry);
  }
}

/** 取り込み済みファイルの記録と、取り込みのログ。 */
async function seedIngestion(
  container: Container,
  now: Date,
  scale: StressScale,
  random: () => number,
): Promise<void> {
  const repository = container.repositories.ingestion;
  for (let index = 0; index < scale.ingestedFileRecords; index += 1) {
    const sourceId = SOURCES[index % SOURCES.length] ?? 'robot';
    await repository.recordFile({
      sourceId,
      fileId: `${sourceId}-seed-${String(index + 1).padStart(6, '0')}.dat`,
      contentHash: `seed-hash-${String(index + 1)}`,
      fetchedAt: iso(now.getTime() - RECENT_GUARD_MS - index * 15 * MS_PER_MINUTE),
      result: 'SUCCESS',
      recordCount: 96,
    });
  }
  for (let index = 0; index < scale.ingestionLogs; index += 1) {
    const sourceId = SOURCES[index % SOURCES.length] ?? 'robot';
    const startedMs = now.getTime() - RECENT_GUARD_MS - index * 30 * MS_PER_MINUTE;
    const failed = random() < 0.05;
    await repository.addLog({
      logId: `seed-ingestion-${String(index + 1).padStart(6, '0')}`,
      sourceId,
      startedAt: iso(startedMs),
      finishedAt: iso(startedMs + 2000),
      result: failed ? 'FAILURE' : 'SUCCESS',
      filesProcessed: failed ? 0 : 1 + Math.floor(random() * 3),
      recordCount: failed ? 0 : 96,
      rejectedCount: 0,
      attempts: failed ? 3 : 1,
      ...(failed ? { errorMessage: '接続できませんでした（負荷試験の合成データ）' } : {}),
    });
  }
}

/** 連携キューの項目と、連携のログ。 */
async function seedFederation(
  container: Container,
  now: Date,
  scale: StressScale,
  random: () => number,
): Promise<void> {
  const repository = container.repositories.federation;
  for (let index = 0; index < scale.federationItems; index += 1) {
    const rate = random();
    const status = rate < 0.9 ? 'SENT' : rate < 0.93 ? 'FAILED' : rate < 0.96 ? 'HELD' : 'PENDING';
    const enqueuedAt = iso(now.getTime() - RECENT_GUARD_MS - index * 5 * MS_PER_MINUTE);
    await repository.enqueue({
      federationItemId: `seed-federation-${String(index + 1).padStart(6, '0')}`,
      targetType: index % 5 === 0 ? 'EVALUATION' : 'OBSERVATION',
      targetRef: `seed-target-${String(index + 1)}`,
      payload: { synthetic: true, index },
      status,
      attempts: status === 'SENT' ? 1 : 2,
      enqueuedAt,
      updatedAt: enqueuedAt,
      nextAttemptAt: enqueuedAt,
    });
  }
  const results = ['SENT', 'FAILED', 'HELD'] as const;
  for (let index = 0; index < scale.federationLogs; index += 1) {
    await repository.addLog({
      logId: `seed-federation-log-${String(index + 1).padStart(6, '0')}`,
      occurredAt: iso(now.getTime() - RECENT_GUARD_MS - index * 30 * MS_PER_MINUTE),
      result: results[index % 7 === 0 ? 1 : index % 11 === 0 ? 2 : 0],
      itemCount: 10 + (index % 50),
    });
  }
}

/** 観点のステータスの変化の履歴（ステータスの推移の表示のため）。評価の前に入れる。件数を返す。 */
async function seedStatusChanges(
  container: Container,
  now: Date,
  scale: StressScale,
  equipment: SeededEquipment,
  random: () => number,
): Promise<number> {
  let total = 0;
  const targets = [
    ...equipment.houses.map((id) => [id, 'FACILITY'] as const),
    ...equipment.robots.map((id) => [id, 'ROBOT'] as const),
    ...equipment.sensors.map((id) => [id, 'SENSOR'] as const),
  ];
  const statuses = ['NORMAL', 'CAUTION', 'ERROR', 'UNKNOWN'] as const;
  const stepMs = Math.floor((scale.historyDays * MS_PER_DAY) / scale.statusChangesPerViewpoint);
  for (const [equipmentId, equipmentType] of targets) {
    for (const viewpoint of viewpointsForEquipmentType(equipmentType)) {
      for (let index = 0; index < scale.statusChangesPerViewpoint; index += 1) {
        await container.repositories.evaluations.appendStatusChange({
          equipmentId,
          viewpointId: viewpoint.id,
          status: pick(statuses, random),
          changedAt: iso(
            now.getTime() - RECENT_GUARD_MS - (scale.statusChangesPerViewpoint - index) * stepMs,
          ),
        });
        total += 1;
      }
    }
  }
  return total;
}

/** 負荷テストの大量データを投入し、評価する。投入した件数を返す。 */
export async function seedStressData(
  container: Container,
  scale: StressScale = STRESS_SCALE,
): Promise<SeedSummary> {
  const startedAt = performance.now();
  const now = container.clock.now();
  const random = createRandom(STRESS_SEED);
  const equipment = await seedEquipment(container, now, scale);
  await seedUsers(container, now, scale);
  await seedStatusCodes(container, scale);

  // 1年分の自動取り込み（計測と同時に受信）。最新は、現在の10分前（テストの手動入力の値が、最新の値になるように）
  const to = new Date(now.getTime() - 10 * MS_PER_MINUTE);
  const from = new Date(now.getTime() - scale.historyDays * MS_PER_DAY);
  let autoObservations = 0;
  for (const [index, pair] of equipment.pairs.entries()) {
    const observations = generateAutoObservations({
      robotId: pair.robot,
      sensorId: pair.sensor,
      from,
      to,
      intervalMinutes: pair.intervalMinutes,
      seed: STRESS_SEED + index,
      temperatureBaseCelsius: 20,
    });
    autoObservations += observations.length;
    await saveObservations(container, observations);
  }
  const allTargets = [...equipment.houses, ...equipment.robots, ...equipment.sensors];
  const manualObservations = await seedManualEntries(container, now, scale, allTargets, random);
  const notifications = await seedNotifications(container, now, scale, allTargets, random);
  await seedAuditLogs(container, now, scale, random);
  await seedIngestion(container, now, scale, random);
  await seedFederation(container, now, scale, random);
  const statusChanges = await seedStatusChanges(container, now, scale, equipment, random);
  await container.evaluationService.evaluateAll('SEED');

  const statusCodes = await container.repositories.statusCodes.list({ includeDeleted: true });
  return {
    scale,
    equipment: {
      houses: equipment.houses.length,
      robots: equipment.robots.length,
      sensors: equipment.sensors.length,
    },
    autoObservations,
    manualObservations,
    observationsTotal: autoObservations + manualObservations,
    statusCodesTotal: statusCodes.length,
    notifications: notifications.total,
    unreadNotifications: notifications.unread,
    auditLogs: scale.auditLogs,
    manualEntries: scale.manualEntries,
    ingestionLogs: scale.ingestionLogs,
    ingestedFileRecords: scale.ingestedFileRecords,
    federationItems: scale.federationItems,
    federationLogs: scale.federationLogs,
    statusChanges,
    users: scale.users,
    historyFrom: from.toISOString(),
    historyTo: to.toISOString(),
    seedSeconds: (performance.now() - startedAt) / 1000,
  };
}
