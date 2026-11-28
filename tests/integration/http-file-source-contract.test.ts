/**
 * FileSourcePort の契約テストを、HTTP のファイルサーバー（手元の HTTP サーバー。設備ごとのファイルパス）に適用する（Issue #119。ADR-0023）。
 * 取り込み元がない（未知の識別子）場合は、利用できない旨の失敗（FileSourceUnavailableError）になること。HTTP では、ファイルの識別子は、ファイルパス（`/` + 名前）。
 * 設備（ロボット）ごとに 1 ファイル。ファイルを置くたびに、その名前のファイルパスを持つロボットを登録し、その設備の接続（手元の HTTP サーバー）を持たせる（ADR-0026）。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { HttpFileServerConnection } from '@smart-farm/shared/schemas/ingestion';
import { createRoutingFileSource } from '../../src/backend/application/ingestion/routing-file-source.ts';
import {
  readHttpFile,
  statHttpFile,
} from '../../src/backend/infrastructure/http/http-file-reader.ts';
import { probeHttpFile } from '../../src/backend/infrastructure/http/http-probe.ts';
import { createMemorySecretPort } from '../../src/backend/infrastructure/local/env-secret.ts';
import { describeFileSourceContract } from '../support/file-source-contract.ts';

describeFileSourceContract('HTTP のファイルサーバー（手元の HTTP サーバー）', () => {
  const files = new Map<string, { content: string; modifiedAt: Date }>();
  const equipment: Equipment[] = [];
  const connections = new Map<string, HttpFileServerConnection>();
  const server = createServer((request, response) => {
    const file = files.get(request.url ?? '');
    if (file === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = Buffer.from(file.content, 'utf8');
    response.writeHead(200, {
      'Content-Length': String(body.length),
      'Last-Modified': file.modifiedAt.toUTCString(),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  // 待ち受けの開始（ポートの確定）を待てるようにする（停止のあとは、address() が null になるため、最初に控える）
  const port = new Promise<number>((resolve) => {
    server.once('listening', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  server.listen(0, '127.0.0.1');
  server.unref();
  // 停止の指示は、待ち受けの開始の前にも来る。ポートを返す前に、停止の指示を反映する（停止後の接続は、拒否される）
  let isDown = false;
  async function portAfterApplyingDown(): Promise<number> {
    const listeningPort = await port;
    if (isDown && server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    return listeningPort;
  }

  const allowPrivateAddresses = true;
  const source = createRoutingFileSource({
    ingestionSettings: {
      listSources: () =>
        Promise.resolve([
          {
            sourceId: 'robot',
            kind: 'ROBOT' as const,
            profileId: 'robot-json',
            isEnabled: true,
          },
        ]),
    },
    equipmentConnections: {
      list: async () => {
        // 停止の指示を反映してから、設備ごとの接続（手元の HTTP サーバー）を返す
        const listeningPort = await portAfterApplyingDown();
        return new Map(
          [...connections].map(([equipmentId, connection]) => [
            equipmentId,
            { ...connection, port: listeningPort },
          ]),
        );
      },
    },
    equipment: { list: () => Promise.resolve(equipment) },
    secrets: createMemorySecretPort(),
    maxFileBytes: 1_000_000,
    http: {
      probe: (input) => probeHttpFile({ ...input, allowPrivateAddresses }),
      stat: (input) => statHttpFile({ ...input, allowPrivateAddresses }),
      read: (input) => readHttpFile({ ...input, allowPrivateAddresses }),
    },
  });

  return {
    source,
    fileIdOf: (name) => `/${name}`,
    putFile(_sourceId, name, content, modifiedAt) {
      files.set(`/${name}`, { content, modifiedAt });
      const equipmentId = toEquipmentId(`ROBOT-${String(equipment.length + 1)}`);
      connections.set(equipmentId, {
        type: 'HTTP',
        protocol: 'HTTP',
        host: '127.0.0.1',
        authMethod: 'NONE',
        apiKeyHeaderName: 'X-API-Key',
      });
      equipment.push({
        equipmentId,
        equipmentType: 'ROBOT',
        name,
        facilityId: toEquipmentId('HOUSE-01'),
        sourceFilePath: `/${name}`,
        isDeleted: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
    },
    equipmentIdOf: (name) => {
      const found = equipment.find((item) => item.name === name);
      if (found === undefined) {
        throw new Error(`テストの前提: ファイルを置いた設備がある: ${name}`);
      }
      return found.equipmentId;
    },
    setDown() {
      isDown = true;
    },
  };
});
