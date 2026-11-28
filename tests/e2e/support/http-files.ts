/**
 * E2E の、HTTP のファイルサーバー（Issue #344。ADR-0025）の補助。取り込み（JB-01）の HTTP アダプタが接続する先を、テストのプロセスの中（127.0.0.1。空きポート。tests/support/http-file-server.ts）に立てる。
 * バックエンドは、別のプロセス（playwright.config.ts の webServer。`HTTP_FILE_SOURCE_ALLOW_PRIVATE=true`）で、そのサーバーに接続する。
 * - `prepareApp`・`prepare`（`/dev/reset`）は、設備ごとの接続を消す（設備も、デモの設備に戻る）。そのため、このファイルの関数は、**呼ばれた時点で、前回の
 *   `prepare` のあとに設定していなければ**、サーバーを空（ファイルなし・停止なし）にする
 * - 接続は、**設備ごと**（Issue #367。ADR-0026）: 設備のファイルのパスを設定するときに、その設備の接続（HTTP・127.0.0.1・このサーバーのポート・
 *   認証なし）も、`PUT /ingestion/equipment/:id/connection` で保存する（`prepare` のたびに消えるため、設備ごとに、その回に保存したかを覚える）
 * - `placeFile`・`placeFixture`: ファイルを置き、**その種別（ロボット・センサー）の設備の `sourceFilePath` を、`/<取り込み元>/<名前>` にする**
 *   （API で設備を修正する）。HTTP は、**1 設備 = 1 ファイル**（ADR-0023）。同じ設備に、別の名前のファイルを置こうとすると、エラー
 *   （「1 つの取り込み元に複数のファイル」は、同じパスの上書き・別の設備〔`equipmentId`〕への配置に言い換える）
 * - `setFileServerMode`: 停止（DOWN。接続を切る）・遅延（SLOW）・拒否（REJECT。503）・復旧（UP）。停止などを指定したとき、ファイルのパスを持たない
 *   ロボット・センサーには、**仮のパス**を割り当てる（HTTP は、ファイルのパスを持つ設備だけが、取得の対象。
 *   仮のパスは、あとで `placeFile` が、本来のパスに付け替える）。ファイルのパスを持つ設備は、すべて、このサーバーに接続する
 * - `saveEquipmentConnection`: 設備の接続を、任意のサーバー（ポート）に向けて保存する（別のサーバーに接続する設備の用意）
 * 置くのは、合成データだけ。ワーカーは 1 つ（playwright.config.ts）のため、サーバーは、ワーカーごとに 1 つ。
 */

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { startHttpFileServer, type HttpFileServer } from '../../support/http-file-server.ts';
import { apiOk } from './app.ts';
import { preparedEpoch } from './viewpoint-scenarios.ts';

export type FileSourceId = 'robot' | 'environment-sensor';

const FIXTURES_ROOT = resolve('tests/fixtures/file-server');

const EQUIPMENT_TYPE_OF: Readonly<Record<FileSourceId, string>> = {
  robot: 'ROBOT',
  'environment-sensor': 'SENSOR',
};

export interface PlaceOptions {
  /** 置く先の設備。省略は、その種別の、最初の設備（設備 ID の順）。 */
  readonly equipmentId?: string | undefined;
  /** 更新日時（`Last-Modified`。秒の精度）。省略は、置いた時刻。 */
  readonly modifiedAt?: Date | undefined;
  /** `Last-Modified` を返さない。 */
  readonly omitLastModified?: boolean | undefined;
  /** 設備が、別のパスを持っているとき、エラーにせず、このパスに付け替える（設備のファイルのパスの修正）。 */
  readonly reassign?: boolean | undefined;
}

interface EquipmentItem {
  readonly equipmentId: string;
  readonly equipmentType: string;
  readonly name: string;
  readonly facilityId?: string;
  readonly externalId?: string;
  readonly sourceFilePath?: string;
  readonly intervalMinutes?: number;
}

/** 停止などの再現で、ファイルのパスを持たない設備に割り当てる、仮のパス（ファイルは置かない。`placeFile` が付け替える）。 */
const placeholderPath = (sourceId: FileSourceId, equipmentId: string): string =>
  `/${sourceId}/not-placed-${equipmentId}.json`;
/** 仮のパスか（パスは、同じ種別の中で一意のため、設備ごとに違う）。 */
const isPlaceholderPath = (sourceId: FileSourceId, path: string): boolean =>
  path.startsWith(`/${sourceId}/not-placed-`);

let serverPromise: Promise<HttpFileServer> | undefined;
let configuredEpoch = -1;
/** 設備ごとの接続（このサーバー）を、保存した回（`prepare` の回数）。`prepare` で、設備ごとの接続は消えるため、回が変われば、保存し直す。 */
const connectedEpoch = new Map<string, number>();

/** テスト用サーバー（なければ、立てる）。前回の `prepare` のあとに、設定していなければ、空にする。 */
async function ensure(): Promise<HttpFileServer> {
  serverPromise ??= startHttpFileServer();
  const server = await serverPromise;
  if (configuredEpoch !== preparedEpoch()) {
    server.reset();
    configuredEpoch = preparedEpoch();
  }
  return server;
}

/** 設備の接続（HTTP・127.0.0.1・指定のポート・認証なし）を、API で保存する。別のサーバーに向ける設備の用意にも使う。 */
export async function saveEquipmentConnection(
  request: APIRequestContext,
  equipmentId: string,
  port: number,
): Promise<void> {
  await apiOk(request, 'PUT', `/ingestion/equipment/${equipmentId}/connection`, {
    connection: { type: 'HTTP', protocol: 'HTTP', host: '127.0.0.1', port, authMethod: 'NONE' },
  });
  // 明示した接続は、補助が、テスト用サーバーに上書きしない
  connectedEpoch.set(equipmentId, preparedEpoch());
}

/** 設備の接続を、API で削除する（補助は、その設備の接続を、保存し直さない）。 */
export async function removeEquipmentConnection(
  request: APIRequestContext,
  equipmentId: string,
): Promise<void> {
  await apiOk(request, 'DELETE', `/ingestion/equipment/${equipmentId}/connection`);
  connectedEpoch.set(equipmentId, preparedEpoch());
}

/** 設備の接続を、テスト用サーバーにする（前回の `prepare` のあとに、保存していなければ）。 */
async function connectToServer(
  request: APIRequestContext,
  server: HttpFileServer,
  equipmentId: string,
): Promise<void> {
  if (connectedEpoch.get(equipmentId) === preparedEpoch()) {
    return;
  }
  await saveEquipmentConnection(request, equipmentId, server.port);
}

async function equipmentList(request: APIRequestContext): Promise<EquipmentItem[]> {
  const tree = await apiOk<{
    facilities: { facility: EquipmentItem; children: EquipmentItem[] }[];
  }>(request, 'GET', '/equipment');
  return tree.facilities.flatMap((entry) => [entry.facility, ...entry.children]);
}

/** 設備のファイルのパスを、API で設定する（修正は、設備の項目を置き換えるため、現在の値を読み、パスだけを変えて、送る）。 */
export async function assignFilePath(
  request: APIRequestContext,
  equipmentId: string,
  path: string,
): Promise<void> {
  const item = (await equipmentList(request)).find(
    (candidate) => candidate.equipmentId === equipmentId,
  );
  if (item === undefined) {
    throw new Error(`設備が見つかりません: ${equipmentId}`);
  }
  await apiOk(request, 'PUT', `/equipment/${equipmentId}`, {
    name: item.name,
    ...(item.facilityId === undefined ? {} : { facilityId: item.facilityId }),
    ...(item.externalId === undefined ? {} : { externalId: item.externalId }),
    sourceFilePath: path,
    ...(item.intervalMinutes === undefined ? {} : { intervalMinutes: item.intervalMinutes }),
  });
}

/** 任意の内容のファイルを置き、設備の `sourceFilePath` を `/<取り込み元>/<名前>` にする。 */
export async function placeFile(
  request: APIRequestContext,
  sourceId: FileSourceId,
  name: string,
  content: string,
  options: PlaceOptions = {},
): Promise<void> {
  const server = await ensure();
  const path = `/${sourceId}/${name}`;
  const type = EQUIPMENT_TYPE_OF[sourceId];
  const [equipment] = (await equipmentList(request))
    .filter(
      (item) =>
        item.equipmentType === type &&
        (options.equipmentId === undefined || item.equipmentId === options.equipmentId),
    )
    .sort((left, right) => left.equipmentId.localeCompare(right.equipmentId));
  if (equipment === undefined) {
    throw new Error(
      `テストの前提: ${type} の設備があります${options.equipmentId === undefined ? '' : `: ${options.equipmentId}`}`,
    );
  }
  if (
    equipment.sourceFilePath !== undefined &&
    equipment.sourceFilePath !== path &&
    !isPlaceholderPath(sourceId, equipment.sourceFilePath) &&
    options.reassign !== true
  ) {
    throw new Error(
      `HTTP のファイルサーバーは、1 設備 = 1 ファイル（設備 ${equipment.equipmentId} は、すでに ${equipment.sourceFilePath} を持つ。${path} は置けない）。同じパスの上書き、または、別の設備（equipmentId を指定）に言い換える`,
    );
  }
  if (equipment.sourceFilePath !== path) {
    await assignFilePath(request, equipment.equipmentId, path);
  }
  // 取得には、設備ごとの接続が要る（Issue #367）
  await connectToServer(request, server, equipment.equipmentId);
  server.put(path, content, {
    modifiedAt: options.modifiedAt,
    omitLastModified: options.omitLastModified,
  });
}

/** 合成データのフィクスチャ（tests/fixtures/file-server/ からの相対パス）を置く。名前は、フィクスチャの名前（`asName` で変えられる）。 */
export function placeFixture(
  request: APIRequestContext,
  sourceId: FileSourceId,
  fixture: string,
  options: PlaceOptions & { readonly asName?: string } = {},
): Promise<void> {
  const content = readFileSync(join(FIXTURES_ROOT, fixture), 'utf8');
  return placeFile(request, sourceId, options.asName ?? basename(fixture), content, options);
}

/**
 * ファイルのパスを持たない設備（ロボット・センサー）に、仮のパスを割り当てる（ファイルは置かない）。
 * 自動取り込みの対象（ファイルのパスを持つ設備。ADR-0023）にして、データの鮮度・停止の判定などを、自動取り込みの運用として確かめる。
 */
export async function assignPlaceholderPaths(request: APIRequestContext): Promise<void> {
  const server = await ensure();
  for (const item of await equipmentList(request)) {
    const sourceId = (Object.keys(EQUIPMENT_TYPE_OF) as FileSourceId[]).find(
      (candidate) => EQUIPMENT_TYPE_OF[candidate] === item.equipmentType,
    );
    if (sourceId === undefined) {
      continue;
    }
    if (item.sourceFilePath === undefined) {
      await assignFilePath(request, item.equipmentId, placeholderPath(sourceId, item.equipmentId));
    }
    // ファイルのパスを持つ設備は、すべて、このサーバーに接続する（設備ごとの接続。Issue #367）
    await connectToServer(request, server, item.equipmentId);
  }
}

/** ファイルサーバーの状態を切り替える（停止〔DOWN。接続を切る〕・遅延〔SLOW〕・拒否〔REJECT。503〕・復旧〔UP〕）。 */
export async function setFileServerMode(
  request: APIRequestContext,
  mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT',
  delayMs?: number,
): Promise<void> {
  const server = await ensure();
  if (mode !== 'UP') {
    // 停止などを効かせるため、取得の対象にする
    await assignPlaceholderPaths(request);
  }
  server.faults.set({ mode, ...(delayMs === undefined ? {} : { delayMs }) });
}

/** ファイルサーバーが受け取ったリクエスト（`HEAD`・`GET`。停止中のものも含む）。 */
export async function fileServerRequests(): Promise<readonly { method: string; path: string }[]> {
  return (await ensure()).requests;
}
