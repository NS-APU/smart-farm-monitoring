/**
 * FileSourcePort の契約テストを、HTTP のファイルサーバー（手元の HTTP サーバー。設備ごとのファイルパス）に適用する（Issue #119。ADR-0023）。
 * モック・S3 と同じ契約に合格すること。HTTP では、ファイルの識別子は、ファイルパス（`/` + 名前）。
 * 設備（ロボット）ごとに 1 ファイル。ファイルを置くたびに、その名前のファイルパスを持つロボットを登録する。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { createRoutingFileSource } from '../../src/backend/application/ingestion/routing-file-source.ts';
import {
  FileSourceUnavailableError,
  type FileSourcePort,
} from '../../src/backend/application/ports/file-source-port.ts';
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

  // 取り込み元がない（未知の識別子）場合は、これまでのファイルソース（base）へ渡る。契約: 失敗する
  const unknownSource: FileSourcePort = {
    testConnection: () => Promise.reject(new FileSourceUnavailableError('取り込み元がありません')),
    listFiles: () => Promise.reject(new FileSourceUnavailableError('取り込み元がありません')),
    readFile: () => Promise.reject(new FileSourceUnavailableError('取り込み元がありません')),
  };
  const allowPrivateAddresses = true;
  const source = createRoutingFileSource({
    base: unknownSource,
    ingestionSettings: {
      listSources: async () => [
        {
          sourceId: 'robot',
          kind: 'ROBOT' as const,
          profileId: 'robot-json',
          connectionRef: 'FILE_SERVER_MOCK',
          connection: {
            type: 'HTTP' as const,
            protocol: 'HTTP' as const,
            host: '127.0.0.1',
            port: await portAfterApplyingDown(),
            authMethod: 'NONE' as const,
            apiKeyHeaderName: 'X-API-Key',
          },
          intervalMinutes: 15 as const,
          isEnabled: true,
        },
      ],
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
      equipment.push({
        equipmentId: toEquipmentId(`ROBOT-${String(equipment.length + 1)}`),
        equipmentType: 'ROBOT',
        name,
        facilityId: toEquipmentId('HOUSE-01'),
        sourceFilePath: `/${name}`,
        isDeleted: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
    },
    setDown() {
      isDown = true;
    },
  };
});
