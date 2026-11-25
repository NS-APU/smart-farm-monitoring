/**
 * 負荷テストの、HTTP のファイルサーバー（Issue #344。ADR-0025）。取り込み（JB-01）の HTTP アダプタが接続する先を、テストのプロセスの中
 * （127.0.0.1。空きポート。tests/support/http-file-server.ts）に立てる。バックエンドは、別のプロセス（stress-server.ts。
 * `HTTP_FILE_SOURCE_ALLOW_PRIVATE=true`）で、そのサーバーに接続する。
 * - `useHttpFiles`: サーバーを立て（なければ）、空（ファイルなし・停止なし）にする
 * - 接続は、設備ごと（Issue #367。ADR-0026）: 設備に、その接続（HTTP・127.0.0.1・このサーバーのポート・認証なし）を、`PUT /ingestion/equipment/:id/connection` で保存する
 *   シードの設備は、初めて置くときに 1 回、大量の取り込み用の設備は、作るときに保存する
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
/** 設備のファイルのパスと、設備ごとの接続を、設定済みの設備（API の呼び出しを、繰り返さない）。 */
const assigned = new Set<string>();

/** サーバーを立てる（なければ）。置いたファイルは、消さない。 */
async function ensureServer(): Promise<HttpFileServer> {
  serverPromise ??= startHttpFileServer();
  return serverPromise;
}

/** 設備の接続（HTTP・127.0.0.1・テスト用サーバーのポート・認証なし）を、API で保存する（設備ごとの接続。Issue #367）。 */
async function connectEquipment(
  request: APIRequestContext,
  userId: string,
  server: HttpFileServer,
  equipmentId: string,
): Promise<void> {
  const response = await api(
    request,
    userId,
    'PUT',
    `/ingestion/equipment/${equipmentId}/connection`,
    {
      connection: {
        type: 'HTTP',
        protocol: 'HTTP',
        host: '127.0.0.1',
        port: server.port,
        authMethod: 'NONE',
      },
    },
  );
  expect(
    response.ok(),
    `PUT /ingestion/equipment/${equipmentId}/connection: ${String(response.status())}`,
  ).toBe(true);
}

/** サーバーを、空（ファイルなし・停止なし）にして返す（なければ立てる）。 */
export async function useHttpFiles(): Promise<HttpFileServer> {
  const server = await ensureServer();
  server.reset();
  return server;
}

/** ファイルサーバーの状態を切り替える（停止〔DOWN。接続を切る〕・復旧〔UP〕など）。 */
export async function setFileServerMode(mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT'): Promise<void> {
  (await ensureServer()).faults.set({ mode });
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
  options: { readonly startIndex: number },
): Promise<number> {
  const server = await ensureServer();
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
      // 取得には、設備ごとの接続が要る（Issue #367）
      await connectEquipment(request, userId, server, target.equipmentId);
      assigned.add(target.equipmentId);
    }
    const content =
      source === 'robot'
        ? robotFileContent({ index: options.startIndex + offset })
        : sensorFileContent({ index: options.startIndex + offset });
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

/** 大量の取り込み用に、専用のハウスと、その配下のロボット・センサーを作る（設備ごとに、ファイルのパスと、接続を持つ）。 */
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
  const server = await ensureServer();
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
      await connectEquipment(request, userId, server, id);
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
  source: Source,
  options: {
    readonly count: number;
    readonly startIndex: number;
    readonly brokenCount?: number;
  },
): Promise<number> {
  const server = await ensureServer();
  for (let index = 0; index < options.count; index += 1) {
    const id = bulkId(source, index);
    const fileOptions = {
      index: options.startIndex + index,
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
