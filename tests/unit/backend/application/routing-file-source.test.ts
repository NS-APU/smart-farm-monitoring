/**
 * 接続方式で振り分けるファイルソース（Issue #172。ADR-0022）の単体テスト。
 * MOCK は、これまでのファイルソース（モック・S3）へ。HTTP は、秘密情報から認証のヘッダーを組み立て、設備ごとのファイルパス（ADR-0023。Issue #119）で、接続テスト・一覧・取得をする。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '../../../../src/shared/schemas/common.ts';
import type { Equipment } from '../../../../src/shared/schemas/equipment.ts';
import type { IngestionSource } from '../../../../src/shared/schemas/ingestion.ts';
import {
  createRoutingFileSource,
  type HttpFileClient,
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
    isEnabled: true,
  };
}

const HTTP_CONNECTION: IngestionSource['connection'] = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  authMethod: 'BEARER',
  apiKeyHeaderName: 'X-API-Key',
};

function robot(
  id: string,
  sourceFilePath: string | undefined,
  overrides: Partial<Equipment> = {},
): Equipment {
  return {
    equipmentId: toEquipmentId(id),
    equipmentType: 'ROBOT',
    name: id,
    facilityId: toEquipmentId('HOUSE-01'),
    ...(sourceFilePath === undefined ? {} : { sourceFilePath }),
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 既定の設備: ファイルパスが設定されたロボット 1 台。 */
const DEFAULT_EQUIPMENT = [robot('ROBOT-01', '/data/robot-01.json')];

interface Harness {
  readonly calls: string[];
  readonly probes: { headers: Record<string, string>; path: string }[];
  readonly port: FileSourcePort;
}

function build(options: {
  sources: IngestionSource[];
  secrets?: SecretPort;
  equipment?: Equipment[];
  probe?: HttpFileClient['probe'];
  stat?: HttpFileClient['stat'];
  read?: HttpFileClient['read'];
}): Harness {
  const calls: string[] = [];
  const probes: { headers: Record<string, string>; path: string }[] = [];
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
  const probe = options.probe ?? (() => Promise.resolve());
  const port = createRoutingFileSource({
    base,
    ingestionSettings: { listSources: () => Promise.resolve(options.sources) },
    secrets: options.secrets ?? createMemorySecretPort(),
    equipment: { list: () => Promise.resolve(options.equipment ?? DEFAULT_EQUIPMENT) },
    maxFileBytes: 1000,
    http: {
      probe: (input) => {
        probes.push({ headers: { ...input.headers }, path: input.path });
        return probe(input);
      },
      stat: options.stat ?? (() => Promise.resolve({})),
      read: options.read ?? (() => Promise.resolve('')),
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

    expect(probes).toEqual([
      { headers: { Authorization: 'Bearer dummy-token' }, path: '/data/robot-01.json' },
    ]);
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

    expect(probes).toEqual([{ headers: {}, path: '/data/robot-01.json' }]);
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

describe('接続方式 HTTP: 接続テスト（設備のファイル）', () => {
  it('ファイルパスが設定された最初の設備（設備 ID の順）のファイルで、接続テストをする。ファイルパスのない設備・削除済みの設備・別の種別の設備は、使わない', async () => {
    const { probes, port } = build({
      sources: [source('robot', { ...HTTP_CONNECTION, authMethod: 'NONE' })],
      equipment: [
        robot('ROBOT-09', '/data/robot-09.json'),
        robot('ROBOT-00', undefined),
        robot('ROBOT-03', '/data/deleted.json', { isDeleted: true }),
        robot('SENSOR-01', '/data/sensor-01.json', { equipmentType: 'SENSOR' }),
        robot('ROBOT-02', '/data/robot-02.json'),
      ],
    });

    await port.testConnection('robot');

    expect(probes.map((probe) => probe.path)).toEqual(['/data/robot-02.json']);
  });

  it('ファイルパスが設定された設備がなければ、接続せずに、NO_FILE_PATH', async () => {
    const { probes, port } = build({
      sources: [source('robot', { ...HTTP_CONNECTION, authMethod: 'NONE' })],
      equipment: [robot('ROBOT-01', undefined)],
    });

    const failure = await failureOf(port.testConnection('robot'));

    expect(failure.reason).toBe('NO_FILE_PATH');
    expect(probes).toHaveLength(0);
  });
});

describe('接続方式 HTTP: 一覧', () => {
  const NONE = { ...HTTP_CONNECTION, authMethod: 'NONE' } as const;
  const T = (iso: string): Date => new Date(iso);

  it('ファイルパスが設定された設備ごとに、ファイル（識別子はファイルパス・名前は最後の区間）を、更新日時の古い順に返す。同じ更新日時は、識別子の順', async () => {
    const stats: Record<string, { sizeBytes?: number; modifiedAt?: Date }> = {
      '/data/a/robot-b.json': { sizeBytes: 20, modifiedAt: T('2026-10-09T01:00:00Z') },
      '/data/a/robot-a.json': { sizeBytes: 10, modifiedAt: T('2026-10-09T01:00:00Z') },
      '/data/robot-new.json': { sizeBytes: 30, modifiedAt: T('2026-10-09T02:00:00Z') },
    };
    const { port } = build({
      sources: [source('robot', NONE)],
      equipment: [
        robot('ROBOT-01', '/data/robot-new.json'),
        robot('ROBOT-02', '/data/a/robot-b.json'),
        robot('ROBOT-03', '/data/a/robot-a.json'),
      ],
      stat: (input) => Promise.resolve(stats[input.path] ?? {}),
    });

    const files = await port.listFiles('robot');

    expect(files.map((file) => file.fileId)).toEqual([
      '/data/a/robot-a.json',
      '/data/a/robot-b.json',
      '/data/robot-new.json',
    ]);
    expect(files[0]).toMatchObject({ name: 'robot-a.json', sizeBytes: 10 });
    expect(files[2]?.modifiedAt.toISOString()).toBe('2026-10-09T02:00:00.000Z');
  });

  it('ファイルパスを指定すると、その設備のファイルだけを問い合わせて、返す（設備ごとの取得間隔のため。#197）。指定のない設備のファイルは、問い合わせない', async () => {
    const statted: string[] = [];
    const { port } = build({
      sources: [source('robot', NONE)],
      equipment: [
        robot('ROBOT-01', '/data/robot-01.json'),
        robot('ROBOT-02', '/data/robot-02.json'),
        robot('ROBOT-03', '/data/robot-03.json'),
      ],
      stat: (input) => {
        statted.push(input.path);
        return Promise.resolve({ sizeBytes: 1, modifiedAt: T('2026-10-09T01:00:00Z') });
      },
    });

    const files = await port.listFiles('robot', {
      paths: ['/data/robot-03.json', '/data/robot-01.json'],
    });

    expect(files.map((file) => file.fileId)).toEqual([
      '/data/robot-01.json',
      '/data/robot-03.json',
    ]);
    expect(statted.sort()).toEqual(['/data/robot-01.json', '/data/robot-03.json']);
  });

  it('ファイルパスの指定が空なら、何も問い合わせず、空の一覧。設備にないパスは、無視する', async () => {
    const statted: string[] = [];
    const { port } = build({
      sources: [source('robot', NONE)],
      equipment: [robot('ROBOT-01', '/data/robot-01.json')],
      stat: (input) => {
        statted.push(input.path);
        return Promise.resolve({});
      },
    });

    const none = await port.listFiles('robot', { paths: [] });
    const unknown = await port.listFiles('robot', { paths: ['/data/other.json'] });

    expect(none).toEqual([]);
    expect(unknown).toEqual([]);
    expect(statted).toEqual([]);
  });

  it('モック・S3（接続方式 MOCK）は、ファイルパスの指定を使わず、これまでどおり、一覧を返す', async () => {
    const { port, calls } = build({ sources: [source('robot', { type: 'MOCK' })] });

    await port.listFiles('robot', { paths: ['/data/robot-01.json'] });

    expect(calls).toEqual(['base.list:robot']);
  });

  it('更新日時・大きさを示さないサーバーは、更新日時を 1970 年（書き換え直後とみなさない）、大きさを 0 として返す', async () => {
    const { port } = build({ sources: [source('robot', NONE)], stat: () => Promise.resolve({}) });

    const [file] = await port.listFiles('robot');

    expect(file?.modifiedAt.getTime()).toBe(0);
    expect(file?.sizeBytes).toBe(0);
  });

  it('ファイルが見つからない設備は、一覧から除く（ほかの設備のファイルは、返す）。それ以外の失敗は、一覧全体の失敗', async () => {
    const equipment = [robot('ROBOT-01', '/data/missing.json'), robot('ROBOT-02', '/data/ok.json')];
    const { port } = build({
      sources: [source('robot', NONE)],
      equipment,
      stat: (input) =>
        input.path === '/data/missing.json'
          ? Promise.reject(new FileSourceFailure('NOT_FOUND'))
          : Promise.resolve({ sizeBytes: 1 }),
    });
    const failing = build({
      sources: [source('robot', NONE)],
      equipment,
      stat: () => Promise.reject(new FileSourceFailure('SERVER_ERROR')),
    });

    expect((await port.listFiles('robot')).map((file) => file.fileId)).toEqual(['/data/ok.json']);
    expect((await failureOf(failing.port.listFiles('robot'))).reason).toBe('SERVER_ERROR');
  });

  it('ファイルパスが設定された設備がなければ、空の一覧（接続しない）', async () => {
    let requested = 0;
    const { port } = build({
      sources: [source('robot', NONE)],
      equipment: [robot('ROBOT-01', undefined)],
      stat: () => {
        requested += 1;
        return Promise.resolve({});
      },
    });

    expect(await port.listFiles('robot')).toEqual([]);
    expect(requested).toBe(0);
  });

  it('取り込み元の種別（ロボット・センサー）に合う設備だけを対象にする', async () => {
    const paths: string[] = [];
    const sensorSource: IngestionSource = { ...source('environment-sensor', NONE), kind: 'SENSOR' };
    const { port } = build({
      sources: [source('robot', NONE), sensorSource],
      equipment: [
        robot('ROBOT-01', '/data/robot-01.json'),
        robot('SENSOR-01', '/data/sensor-01.json', { equipmentType: 'SENSOR' }),
      ],
      stat: (input) => {
        paths.push(input.path);
        return Promise.resolve({});
      },
    });

    await port.listFiles('environment-sensor');

    expect(paths).toEqual(['/data/sensor-01.json']);
  });

  it('認証のヘッダーを付ける。認証に失敗したら、秘密情報を取り直して、値が変わっていれば、1 度だけ再試行する', async () => {
    const secrets: SecretPort = {
      get: (_reference, options) =>
        Promise.resolve(options?.refresh === true ? 'new-token' : 'old-token'),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: true }),
    };
    const used: (string | undefined)[] = [];
    const { port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
      stat: (input) => {
        used.push(input.headers.Authorization);
        return input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve({ sizeBytes: 1 })
          : Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    await port.listFiles('robot');

    expect(used).toEqual(['Bearer old-token', 'Bearer new-token']);
  });

  it('秘密情報が未設定なら、接続せずに、CREDENTIALS_MISSING', async () => {
    let requested = 0;
    const { port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      stat: () => {
        requested += 1;
        return Promise.resolve({});
      },
    });

    expect((await failureOf(port.listFiles('robot'))).reason).toBe('CREDENTIALS_MISSING');
    expect(requested).toBe(0);
  });
});

describe('接続方式 HTTP: 取得', () => {
  const NONE = { ...HTTP_CONNECTION, authMethod: 'NONE' } as const;

  it('一覧に出るファイルの識別子（ファイルパス）で、内容を取得する。大きさの上限と、接続設定を渡す', async () => {
    const inputs: { path: string; maxBytes: number; host: string }[] = [];
    const { port } = build({
      sources: [source('robot', NONE)],
      read: (input) => {
        inputs.push({ path: input.path, maxBytes: input.maxBytes, host: input.connection.host });
        return Promise.resolve('{"a":1}');
      },
    });

    expect(await port.readFile('robot', '/data/robot-01.json')).toBe('{"a":1}');
    expect(inputs).toEqual([
      { path: '/data/robot-01.json', maxBytes: 1000, host: 'fileserver.example.ac.jp' },
    ]);
  });

  it('設備のファイルパスにない識別子は、取得せずに、NOT_FOUND（任意のパスを取得させない）', async () => {
    let requested = 0;
    const { port } = build({
      sources: [source('robot', NONE)],
      read: () => {
        requested += 1;
        return Promise.resolve('');
      },
    });

    expect((await failureOf(port.readFile('robot', '/etc/passwd'))).reason).toBe('NOT_FOUND');
    expect((await failureOf(port.readFile('robot', '/data/../robot-01.json'))).reason).toBe(
      'NOT_FOUND',
    );
    expect(requested).toBe(0);
  });

  it('認証に失敗したら、秘密情報を取り直して、値が変わっていれば、1 度だけ再試行する。値が同じなら、再試行せずに AUTH_FAILED', async () => {
    const secrets: SecretPort = {
      get: (_reference, options) =>
        Promise.resolve(options?.refresh === true ? 'new-token' : 'old-token'),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: true }),
    };
    const { port } = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets,
      read: (input) =>
        input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve('ok')
          : Promise.reject(new FileSourceFailure('AUTH_FAILED')),
    });
    let attempts = 0;
    const same = build({
      sources: [source('robot', HTTP_CONNECTION)],
      secrets: createMemorySecretPort({ 'file-server/robot': 'dummy-token' }),
      read: () => {
        attempts += 1;
        return Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    expect(await port.readFile('robot', '/data/robot-01.json')).toBe('ok');
    expect((await failureOf(same.port.readFile('robot', '/data/robot-01.json'))).reason).toBe(
      'AUTH_FAILED',
    );
    expect(attempts).toBe(1);
  });

  it('取得の失敗（大きすぎる・見つからない）は、そのまま伝える', async () => {
    const { port } = build({
      sources: [source('robot', NONE)],
      read: () => Promise.reject(new FileSourceFailure('TOO_LARGE')),
    });

    expect((await failureOf(port.readFile('robot', '/data/robot-01.json'))).reason).toBe(
      'TOO_LARGE',
    );
  });
});
