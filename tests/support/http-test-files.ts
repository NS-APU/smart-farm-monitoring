/**
 * 取り込みのテストの、HTTP のファイルサーバー（Issue #344。ADR-0025）の準備。モックのファイルサーバー（`context.placeFile`・`placeFixture`・
 * `faults.fileServer`）の置き換え。
 * - `useHttpFileServer(context)`: テスト用の HTTP サーバー（http-file-server.ts）を立てる。接続は、**設備ごと**（ADR-0026。共通の接続はない）で、
 *   ファイルのパスを設備に設定するとき（`files.*`）に、その設備の接続を、そのサーバー（127.0.0.1。HTTP・認証なし）にする。コンテキストは、`HTTP_FILE_SOURCE_ALLOW_PRIVATE=true` で作る（`HTTP_FILES_ENV`。
 *   `withHttpFiles()` が、設備の一式〔withEquipment〕と合わせて、作る。内部のアドレスを、既定で拒否することを確かめるテストのため、既定にはしない）
 * - `files.placeFile`・`files.placeFixture`: ファイルを置き、**その取り込み元の種別の設備の `sourceFilePath` を、そのパスにし、その設備の接続を保存する**
 *   （HTTP は、1 設備 = 1 ファイル。ADR-0023）。パスは `/<取り込み元>/<名前>`。設備は、`equipmentId` で指定する（省略は、その種別の
 *   最初の設備）。**同じ設備に、別の名前のファイルを置こうとするとエラー**（モックの「1 つの取り込み元に複数のファイル」を、
 *   同じパスの上書き・別の設備への配置に言い換える。意図しない言い換えを避ける）
 * - `files.faults`: 停止（DOWN。接続を切る）・遅延（SLOW）・拒否（REJECT。503）・復旧（UP）。モックの `faults.fileServer` と同じ指定
 * サーバーは、テストの終了を妨げない（unref）。置くのは、合成データだけ。
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { FaultController } from '../../src/backend/infrastructure/local/faults.ts';
import { FIXTURES_DIRECTORY } from './fixtures-path.ts';
import { startHttpFileServer, type HttpFileServer } from './http-file-server.ts';
import { withEquipment, type TestContext, type TestContextOptions } from './test-context.ts';

/** HTTP のテスト用ファイルサーバー（127.0.0.1）に接続できるようにする設定（APP_MODE=test のときだけ有効）。 */
export const HTTP_FILES_ENV = { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } as const;

export type FileSourceId = 'robot' | 'environment-sensor';

const EQUIPMENT_TYPE_OF: Readonly<Record<FileSourceId, Equipment['equipmentType']>> = {
  robot: 'ROBOT',
  'environment-sensor': 'SENSOR',
};

export interface PlaceOptions {
  /** 置く先の設備。省略は、取り込み元の種別（ロボット・センサー）の、最初の設備（設備 ID の順）。 */
  readonly equipmentId?: EquipmentId | undefined;
  /** 更新日時（`Last-Modified`。秒の精度）。省略は、置いた時刻。 */
  readonly modifiedAt?: Date | undefined;
  /** `Last-Modified` を返さない。 */
  readonly omitLastModified?: boolean | undefined;
}

export interface HttpTestFiles {
  readonly server: HttpFileServer;
  readonly faults: FaultController;
  /** 任意の内容のファイルを置き、設備の `sourceFilePath` を `/<取り込み元>/<名前>` にする。 */
  placeFile(
    sourceId: FileSourceId,
    name: string,
    content: string,
    options?: PlaceOptions,
  ): Promise<void>;
  /** 合成データのフィクスチャ（tests/fixtures/file-server/）を置く。名前は、フィクスチャの名前（`asName` で変えられる）。 */
  placeFixture(
    sourceId: FileSourceId,
    fixtureRelativePath: string,
    options?: PlaceOptions & { readonly asName?: string },
  ): Promise<void>;
  /** 設備の `sourceFilePath` と接続を設定する（ファイルは置かない。ファイルが、まだ置かれていない状態の確認用）。 */
  assignPath(equipmentId: EquipmentId, path: string): Promise<void>;
}

export type HttpTestContext = TestContext & { readonly files: HttpTestFiles };

/** HTTP のテスト用サーバーを立てる（設備の接続は、ファイルのパスを設定するとき〔`files.*`〕に、設備ごとに、それにする）。 */
export async function useHttpFileServer(context: TestContext): Promise<HttpTestContext> {
  if (!context.config.httpFileSourceAllowPrivate) {
    throw new Error(
      'テストの前提: HTTP_FILE_SOURCE_ALLOW_PRIVATE=true でコンテキストを作る（HTTP_FILES_ENV。または withHttpFiles を使う）',
    );
  }
  const server = await startHttpFileServer();
  const { equipmentConnections, repositories } = context.container;

  /** 設備のファイルのパスを設定し、その設備の接続（テスト用サーバー。HTTP・127.0.0.1・認証なし）を保存する（ADR-0026。共通の接続はない）。 */
  async function assign(equipment: Equipment, path: string): Promise<void> {
    if (equipment.sourceFilePath !== path) {
      await repositories.equipment.save({ ...equipment, sourceFilePath: path });
    }
    await equipmentConnections.save(equipment.equipmentId, {
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port: server.port,
      authMethod: 'NONE',
      apiKeyHeaderName: 'X-API-Key',
    });
  }

  async function equipmentFor(
    sourceId: FileSourceId,
    equipmentId: EquipmentId | undefined,
  ): Promise<Equipment> {
    const type = EQUIPMENT_TYPE_OF[sourceId];
    const candidates = (await repositories.equipment.list())
      .filter(
        (item) =>
          item.equipmentType === type &&
          (equipmentId === undefined || item.equipmentId === equipmentId),
      )
      .sort((left, right) => left.equipmentId.localeCompare(right.equipmentId));
    const [found] = candidates;
    if (found === undefined) {
      throw new Error(
        `テストの前提: ${type} の設備があります（withEquipment で設備を登録する）${equipmentId === undefined ? '' : `: ${equipmentId}`}`,
      );
    }
    return found;
  }

  async function placeFile(
    sourceId: FileSourceId,
    name: string,
    content: string,
    options: PlaceOptions = {},
  ): Promise<void> {
    const path = `/${sourceId}/${name}`;
    const equipment = await equipmentFor(sourceId, options.equipmentId);
    if (equipment.sourceFilePath !== undefined && equipment.sourceFilePath !== path) {
      throw new Error(
        `HTTP のファイルサーバーは、1 設備 = 1 ファイル（設備 ${equipment.equipmentId} は、すでに ${equipment.sourceFilePath} を持つ。${path} は置けない）。同じパスの上書き、または、別の設備（equipmentId を指定）に言い換える`,
      );
    }
    await assign(equipment, path);
    server.put(path, content, {
      modifiedAt: options.modifiedAt,
      omitLastModified: options.omitLastModified,
    });
  }

  const files: HttpTestFiles = {
    server,
    faults: server.faults,
    placeFile,
    placeFixture(sourceId, fixtureRelativePath, options = {}) {
      const name = options.asName ?? basename(fixtureRelativePath);
      const content = readFileSync(
        join(FIXTURES_DIRECTORY, 'file-server', fixtureRelativePath),
        'utf8',
      );
      return placeFile(sourceId, name, content, options);
    },
    async assignPath(equipmentId, path) {
      const equipment = await repositories.equipment.get(equipmentId);
      if (equipment === undefined) {
        throw new Error(`テストの前提: 設備があります: ${equipmentId}`);
      }
      await assign(equipment, path);
    },
  };
  return Object.assign(context, { files });
}

/** 設備の一式（ハウス・ロボット・センサー）を登録し、HTTP のテスト用ファイルサーバーに接続した、テストの組み立て。 */
export async function withHttpFiles(options: TestContextOptions = {}): Promise<HttpTestContext> {
  return useHttpFileServer(
    await withEquipment({ ...options, env: { ...HTTP_FILES_ENV, ...options.env } }),
  );
}
