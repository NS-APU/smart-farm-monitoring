/**
 * 負荷テストの、HTTP のファイルサーバー（Issue #344。ADR-0025）。取り込み（JB-01）の HTTP アダプタが接続する先を、テストのプロセスの中
 * （127.0.0.1。空きポート。tests/support/http-file-server.ts）に立てる。バックエンドは、別のプロセス（stress-server.ts。
 * `HTTP_FILE_SOURCE_ALLOW_PRIVATE=true`）で、そのサーバーに接続する。
 * - `useHttpFiles`: サーバーを立て（なければ）、取り込み元の接続を、そのサーバー（HTTP・認証なし）にする（サーバーごとに 1 回）
 * - 設備ごとに 1 ファイル（ADR-0023）。シードの設備（ロボット・センサー）は、`putSeededFiles` が、設備の `sourceFilePath` を設定して置く
 * - 大量の取り込みは、専用のハウスの配下に、設備を追加して（`createBulkEquipment`）、設備ごとに 1 ファイルを置く。ハウスごと削除して戻す
 *   （`removeBulkEquipment`。ほかの負荷テストの計測に、影響させない）
 * 置くのは、合成データだけ。
 */

import { expect, type APIRequestContext } from '@playwright/test';
import { startHttpFileServer, type HttpFileServer } from '../../support/http-file-server.ts';
import { robotFileContent, sensorFileContent } from './files.ts';
import { STRESS_SCALE, robotExternalId, robotId, sensorExternalId, sensorId } from './scale.ts';
import { api } from './ui.ts';

type Source = 'robot' | 'environment-sensor';

interface EquipmentItem {
  readonly equipmentId: string;
  readonly name: string;
  readonly facilityId?: string;
  readonly externalId?: string;
  readonly sourceFilePath?: string;
  readonly intervalMinutes?: number;
}

let serverPromise: Promise<HttpFileServer> | undefined;
let configuredFor: HttpFileServer | undefined;
/** 設備のファイルのパスを、設定済みの設備（API の呼び出しを、繰り返さない）。 */
const assigned = new Set<string>();

/** サーバーを立て（なければ）、取り込み元の接続を、そのサーバーにする（サーバーごとに 1 回）。置いたファイルは、消さない。 */
async function ensureServer(request: APIRequestContext, userId: string): Promise<HttpFileServer> {
  serverPromise ??= startHttpFileServer();
  const server = await serverPromise;
  if (configuredFor !== server) {
    const current = await api(request, userId, 'GET', '/ingestion/settings');
    expect(current.ok(), `GET /ingestion/settings: ${String(current.status())}`).toBe(true);
    const { sources } = (await current.json()) as {
      sources: { sourceId: string; connectionRef: string; isEnabled: boolean }[];
    };
    const update = await api(request, userId, 'PUT', '/ingestion/settings', {
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        connectionRef: source.connectionRef,
        isEnabled: source.isEnabled,
        connection: {
          type: 'HTTP',
          protocol: 'HTTP',
          host: '127.0.0.1',
          port: server.port,
          authMethod: 'NONE',
        },
      })),
    });
    expect(update.ok(), `PUT /ingestion/settings: ${String(update.status())}`).toBe(true);
    configuredFor = server;
  }
  return server;
}

/** サーバーを、空（ファイルなし・停止なし）にして返す（なければ立て、取り込み元の接続を、そのサーバーにする）。 */
export async function useHttpFiles(
  request: APIRequestContext,
  userId: string,
): Promise<HttpFileServer> {
  const server = await ensureServer(request, userId);
  server.reset();
  return server;
}

/** ファイルサーバーの状態を切り替える（停止〔DOWN。接続を切る〕・復旧〔UP〕など）。 */
export async function setFileServerMode(
  request: APIRequestContext,
  userId: string,
  mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT',
): Promise<void> {
  (await ensureServer(request, userId)).faults.set({ mode });
}

async function equipmentList(request: APIRequestContext, userId: string): Promise<EquipmentItem[]> {
  const response = await api(request, userId, 'GET', '/equipment');
  expect(response.ok(), `GET /equipment: ${String(response.status())}`).toBe(true);
  const tree = (await response.json()) as {
    facilities: { facility: EquipmentItem; children: EquipmentItem[] }[];
  };
  return tree.facilities.flatMap((entry) => [entry.facility, ...entry.children]);
}

/** 設備のファイルのパスを、API で設定する（修正は、設備の項目を置き換えるため、現在の値を読み、パスだけを変えて、送る）。 */
async function assignFilePath(
  request: APIRequestContext,
  userId: string,
  item: EquipmentItem,
  path: string,
): Promise<void> {
  const response = await api(request, userId, 'PUT', `/equipment/${item.equipmentId}`, {
    name: item.name,
    ...(item.facilityId === undefined ? {} : { facilityId: item.facilityId }),
    ...(item.externalId === undefined ? {} : { externalId: item.externalId }),
    sourceFilePath: path,
    ...(item.intervalMinutes === undefined ? {} : { intervalMinutes: item.intervalMinutes }),
  });
  expect(response.ok(), `PUT /equipment/${item.equipmentId}: ${String(response.status())}`).toBe(
    true,
  );
}

/** シードの設備（ハウスごとの、ロボット・センサーの組）。 */
export function seededUnits(): {
  readonly robot: { readonly equipmentId: string; readonly externalId: string };
  readonly sensor: { readonly equipmentId: string; readonly externalId: string };
}[] {
  return STRESS_SCALE.houses.flatMap((house, houseIndex) =>
    Array.from({ length: house.units }, (_, unit) => ({
      robot: {
        equipmentId: robotId(houseIndex, unit),
        externalId: robotExternalId(houseIndex, unit),
      },
      sensor: {
        equipmentId: sensorId(houseIndex, unit),
        externalId: sensorExternalId(houseIndex, unit),
      },
    })),
  );
}

/**
 * シードの設備の、ファイルを置く（設備ごとに 1 ファイル）。設備のファイルのパスは、初めて置くときに、設定する。
 * `startIndex` を変えると、内容（計測日時・値）が、前に置いたものと変わる（新しいデータとして取り込まれる）。
 * 置いたファイルの数（設備の数）を返す。
 */
export async function putSeededFiles(
  request: APIRequestContext,
  userId: string,
  source: Source,
  options: { readonly startIndex: number; readonly recordsPerFile: number },
): Promise<number> {
  const server = await ensureServer(request, userId);
  const units = seededUnits();
  const items = units.some(
    (unit) => !assigned.has(source === 'robot' ? unit.robot.equipmentId : unit.sensor.equipmentId),
  )
    ? await equipmentList(request, userId)
    : [];
  for (const [offset, unit] of units.entries()) {
    const target = source === 'robot' ? unit.robot : unit.sensor;
    const path = `/${source}/stress-${target.equipmentId}.json`;
    if (!assigned.has(target.equipmentId)) {
      const item = items.find((candidate) => candidate.equipmentId === target.equipmentId);
      if (item === undefined) {
        throw new Error(`設備が見つかりません: ${target.equipmentId}`);
      }
      await assignFilePath(request, userId, item, path);
      assigned.add(target.equipmentId);
    }
    const content =
      source === 'robot'
        ? robotFileContent({
            externalId: target.externalId,
            index: options.startIndex + offset,
            recordsPerFile: options.recordsPerFile,
          })
        : sensorFileContent({
            externalId: target.externalId,
            index: options.startIndex + offset,
            recordsPerFile: options.recordsPerFile,
          });
    // 更新日時は、1 分前（更新から 1 秒以内のファイルは、書き換えの最中かもしれないため、読まずに次の周期に回す。ADR-0016 の D-08）
    server.put(path, content, { modifiedAt: new Date(Date.now() - 60_000) });
  }
  return units.length;
}

/** 大量の取り込み用の、専用のハウス。配下の設備ごと、削除して戻す。 */
export const BULK_HOUSE_ID = 'HOUSE-BULK';

function bulkId(source: Source, index: number): string {
  return `${source === 'robot' ? 'ROBOT' : 'SENSOR'}-BULK-${String(index + 1).padStart(3, '0')}`;
}

/** 大量の取り込み用に、専用のハウスと、その配下のロボット・センサーを作る（設備ごとに、ファイルのパスを持つ）。 */
export async function createBulkEquipment(
  request: APIRequestContext,
  userId: string,
  counts: { readonly robots: number; readonly sensors: number },
): Promise<void> {
  const post = async (body: Record<string, unknown>): Promise<void> => {
    const response = await api(request, userId, 'POST', '/equipment', body);
    expect(
      response.ok(),
      `POST /equipment ${String(body.equipmentId)}: ${String(response.status())}`,
    ).toBe(true);
  };
  await post({
    equipmentId: BULK_HOUSE_ID,
    equipmentType: 'FACILITY',
    name: '負荷試験の大量取り込み用ハウス',
  });
  for (const [source, equipmentType, count] of [
    ['robot', 'ROBOT', counts.robots],
    ['environment-sensor', 'SENSOR', counts.sensors],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      const id = bulkId(source, index);
      await post({
        equipmentId: id,
        equipmentType,
        name: `負荷試験の大量取り込み用${equipmentType === 'ROBOT' ? 'ロボット' : 'センサー'}${String(index + 1)}`,
        facilityId: BULK_HOUSE_ID,
        externalId: id,
        sourceFilePath: `/${source}/${id.toLowerCase()}.json`,
      });
    }
  }
}

/** 大量の取り込み用の専用のハウスを、配下の設備ごと削除する（なければ、何もしない）。 */
export async function removeBulkEquipment(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  await api(request, userId, 'DELETE', `/equipment/${BULK_HOUSE_ID}`);
}

/**
 * 大量の取り込み用の設備ごとに、ファイルを置く。`brokenCount` は、末尾から数えた、形式違い（壊れた内容）のファイルの数。
 * `startIndex` を変えると、内容が、前に置いたものと変わる。置いたファイルの数（設備の数）を返す。
 */
export async function putBulkFiles(
  request: APIRequestContext,
  userId: string,
  source: Source,
  options: {
    readonly count: number;
    readonly startIndex: number;
    readonly recordsPerFile: number;
    readonly brokenCount?: number;
  },
): Promise<number> {
  const server = await ensureServer(request, userId);
  for (let index = 0; index < options.count; index += 1) {
    const id = bulkId(source, index);
    const fileOptions = {
      externalId: id,
      index: options.startIndex + index,
      recordsPerFile: options.recordsPerFile,
      broken: index >= options.count - (options.brokenCount ?? 0),
    };
    server.put(
      `/${source}/${id.toLowerCase()}.json`,
      source === 'robot' ? robotFileContent(fileOptions) : sensorFileContent(fileOptions),
      { modifiedAt: new Date(Date.now() - 60_000) },
    );
  }
  return options.count;
}
