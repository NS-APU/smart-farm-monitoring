/**
 * 接続方式で振り分けるファイルソース（Issue #172。ADR-0022）の単体テスト。
 * MOCK は、これまでのファイルソース（モック・S3）へ。HTTP は、秘密情報から認証のヘッダーを組み立て、接続テストをする。
 * HTTP の一覧・取得は、Issue #119 で実装する（それまでは、「まだ使えません」）。
 */

import { describe, expect, it } from 'vitest';
import type { IngestionSource } from '../../../../src/shared/schemas/ingestion.ts';
import {
  createRoutingFileSource,
  type HttpFileProbe,
} from '../../../../src/backend/application/ingestion/routing-file-source.ts';
import {
  FileSourceFailure,
  type FileSourcePort,
} from '../../../../src/backend/application/ports/file-source-port.ts';
import type { SecretPort } from '../../../../src/backend/application/ports/secret-port.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';

function source(sourceId: string, connection: IngestionSource['connection']): IngestionSource {
  return {
    sourceId,
    kind: 'ROBOT',
    profileId: 'robot-json',
    connectionRef: 'FILE_SERVER_MOCK',
    connection,
    intervalMinutes: 30,
    isEnabled: true,
  };
}

const HTTP_CONNECTION: IngestionSource['connection'] = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  filePath: '/data/robot/latest.json',
  authMethod: 'BEARER',
  apiKeyHeaderName: 'X-API-Key',
};

interface Harness {
  readonly calls: string[];
  readonly probes: { headers: Record<string, string> }[];
  readonly port: FileSourcePort;
}

function build(options: {
  sources: IngestionSource[];
  secrets?: SecretPort;
  probe?: HttpFileProbe;
}): Harness {
  const calls: string[] = [];
  const probes: { headers: Record<string, string> }[] = [];
  const base: FileSourcePort = {
    testConnection: (sourceId) => {
      calls.push(`base.test:${sourceId}`);
      return Promise.resolve();
    },
    listFiles: (sourceId) => {
      calls.push(`base.list:${sourceId}`);
      return Promise.resolve([]);
    },
    readFile: (sourceId, fileId) => {
      calls.push(`base.read:${sourceId}:${fileId}`);
      return Promise.resolve('content');
    },
  };
  const probe: HttpFileProbe = options.probe ?? (() => Promise.resolve());
  const port = createRoutingFileSource({
    base,
    ingestionSettings: { listSources: () => Promise.resolve(options.sources) },
    secrets: options.secrets ?? createMemorySecretPort(),
    probe: (input) => {
      probes.push({ headers: { ...input.headers } });
      return probe(input);
    },
  });
  return { calls, probes, port };
}

async function failureOf(promise: Promise<unknown>): Promise<FileSourceFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileSourceFailure);
    return error as FileSourceFailure;
  }
  throw new Error('失敗するはずの処理が、成功した');
}

describe('接続方式 MOCK', () => {
  it('テスト・一覧・取得を、これまでのファイルソースへ渡す', async () => {
    const { calls, probes, port } = build({ sources: [source('robot', { type: 'MOCK' })] });

    await port.testConnection('robot');
    await port.listFiles('robot');
    await port.readFile('robot', 'a.json');

    expect(calls).toEqual(['base.test:robot', 'base.list:robot', 'base.read:robot:a.json']);
    expect(probes).toHaveLength(0);
  });

  it('設定にない取り込み元も、これまでのファイルソースへ渡す（これまでの動作を保つ）', async () => {
    const { calls, port } = build({ sources: [] });

    await port.listFiles('unknown');

    expect(calls).toEqual(['base.list:unknown']);
  });
});

describe('接続方式 HTTP: 接続テスト', () => {
  it('秘密情報から認証のヘッダーを組み立てて、接続テストをする', async () => {
    const secrets = createMemorySecretPort({ 'file-server/robot': 'dummy-token' });
    const { calls, probes, port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
    });

    await port.testConnection('robot');

    expect(probes).toEqual([{ headers: { Authorization: 'Bearer dummy-token' } }]);
    expect(calls).toEqual([]);
  });

  it('認証なし（NONE）は、秘密情報を読まずに、接続テストをする', async () => {
    const secrets: SecretPort = {
      get: () => Promise.reject(new Error('読まないはず')),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: false }),
    };
    const { probes, port } = build({
      sources: [source('robot', { ...HTTP_CONNECTION, authMethod: 'NONE' })],
      secrets,
    });

    await port.testConnection('robot');

    expect(probes).toEqual([{ headers: {} }]);
  });

  it('秘密情報が未設定なら、接続せずに、CREDENTIALS_MISSING', async () => {
    const { probes, port } = build({ sources: [source('robot', HTTP_CONNECTION)] });

    const failure = await failureOf(port.testConnection('robot'));

    expect(failure.reason).toBe('CREDENTIALS_MISSING');
    expect(probes).toHaveLength(0);
  });

  it('秘密情報を読み出せないとき（保管先の障害）は、CREDENTIALS_UNAVAILABLE（値・内部の情報を含めない）', async () => {
    const secrets: SecretPort = {
      get: () => Promise.reject(new Error('AccessDeniedException: dummy-internal-detail')),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: false }),
    };
    const { port } = build({ sources: [source('robot', HTTP_CONNECTION)], secrets });

    const failure = await failureOf(port.testConnection('robot'));

    expect(failure.reason).toBe('CREDENTIALS_UNAVAILABLE');
    expect(failure.message).not.toContain('dummy-internal-detail');
  });

  it('認証に失敗したら、秘密情報を取り直して（キャッシュを使わない）、値が変わっていれば、1 度だけ再試行する', async () => {
    let attempt = 0;
    const reads: (boolean | undefined)[] = [];
    const secrets: SecretPort = {
      get: (_reference, options) => {
        reads.push(options?.refresh);
        return Promise.resolve(options?.refresh === true ? 'new-token' : 'old-token');
      },
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: true }),
    };
    const { probes, port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
      probe: (input) => {
        attempt += 1;
        return input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve()
          : Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    await port.testConnection('robot');

    expect(attempt).toBe(2);
    expect(reads).toEqual([undefined, true]);
    expect(probes.map((probe) => probe.headers.Authorization)).toEqual([
      'Bearer old-token',
      'Bearer new-token',
    ]);
  });

  it('認証に失敗し、取り直しても値が同じなら、再試行せずに、AUTH_FAILED', async () => {
    const secrets = createMemorySecretPort({ 'file-server/robot': 'dummy-token' });
    let attempt = 0;
    const { port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
      probe: () => {
        attempt += 1;
        return Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    const failure = await failureOf(port.testConnection('robot'));

    expect(failure.reason).toBe('AUTH_FAILED');
    expect(attempt).toBe(1);
  });

  it('認証以外の失敗は、そのまま伝える（再試行しない）', async () => {
    const secrets = createMemorySecretPort({ 'file-server/robot': 'dummy-token' });
    let attempt = 0;
    const { port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
      probe: () => {
        attempt += 1;
        return Promise.reject(new FileSourceFailure('NOT_FOUND'));
      },
    });

    expect((await failureOf(port.testConnection('robot'))).reason).toBe('NOT_FOUND');
    expect(attempt).toBe(1);
  });

  it('接続テストへ渡す接続設定は、保存されている設定（取り込み元ごと）', async () => {
    const inputs: string[] = [];
    const { port } = build({
      sources: [
        source('robot', { ...HTTP_CONNECTION, authMethod: 'NONE', host: 'robot.example.ac.jp' }),
        source('environment-sensor', {
          ...HTTP_CONNECTION,
          authMethod: 'NONE',
          host: 'sensor.example.ac.jp',
        }),
      ],
      probe: (input) => {
        inputs.push(input.connection.host);
        return Promise.resolve();
      },
    });

    await port.testConnection('environment-sensor');

    expect(inputs).toEqual(['sensor.example.ac.jp']);
  });
});

describe('接続方式 HTTP: 一覧・取得（Issue #119 で実装）', () => {
  it('一覧・取得は、NOT_IMPLEMENTED（取り込みは、失敗として記録される）', async () => {
    const { calls, port } = build({ sources: [source('robot', HTTP_CONNECTION)] });

    expect((await failureOf(port.listFiles('robot'))).reason).toBe('NOT_IMPLEMENTED');
    expect((await failureOf(port.readFile('robot', 'a.json'))).reason).toBe('NOT_IMPLEMENTED');
    expect(calls).toEqual([]);
  });
});
