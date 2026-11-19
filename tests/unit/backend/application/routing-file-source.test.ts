/**
 * HTTP のファイルサーバーのファイルソース（Issue #172・#367。ADR-0022・ADR-0025・ADR-0026）の単体テスト。
 * 設備ごとの接続・認証情報（秘密情報）から認証のヘッダーを組み立て、設備ごとのファイルパス（ADR-0023。Issue #119）で、
 * 接続テスト・一覧・取得をする。接続のない設備・取り込み元の設定がない場合の扱いも検証する。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '../../../../src/shared/schemas/common.ts';
import type { Equipment } from '../../../../src/shared/schemas/equipment.ts';
import type {
  FileServerConnection,
  IngestionSource,
} from '../../../../src/shared/schemas/ingestion.ts';
import {
  createRoutingFileSource,
  type HttpFileClient,
} from '../../../../src/backend/application/ingestion/routing-file-source.ts';
import {
  FileSourceFailure,
  FileSourceUnavailableError,
  type FileListFailure,
  type FileSourcePort,
} from '../../../../src/backend/application/ports/file-source-port.ts';
import type { SecretPort } from '../../../../src/backend/application/ports/secret-port.ts';
import { fileServerEquipmentSecretReference } from '../../../../src/backend/application/ingestion/file-server-credentials.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';

function source(sourceId: string): IngestionSource {
  return {
    sourceId,
    kind: 'ROBOT',
    profileId: 'robot-json',
    isEnabled: true,
  };
}

const HTTP_CONNECTION: FileServerConnection = {
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
  readonly probes: { headers: Record<string, string>; path: string }[];
  readonly port: FileSourcePort;
}

function build(options: {
  sources: IngestionSource[];
  secrets?: SecretPort;
  equipment?: Equipment[];
  /** 設備ごとの接続（設備 ID → 接続）。省略は、なし（接続のない設備は、NOT_CONFIGURED）。 */
  equipmentConnections?: ReadonlyMap<string, FileServerConnection>;
  /** 設備（`equipment`。省略は、既定の設備）すべてに、同じ接続を持たせる（`equipmentConnections` の指定がないとき）。 */
  connection?: FileServerConnection;
  probe?: HttpFileClient['probe'];
  stat?: HttpFileClient['stat'];
  read?: HttpFileClient['read'];
}): Harness {
  const probes: { headers: Record<string, string>; path: string }[] = [];
  const probe = options.probe ?? (() => Promise.resolve());
  const equipment = options.equipment ?? DEFAULT_EQUIPMENT;
  const { connection } = options;
  const equipmentConnections: ReadonlyMap<string, FileServerConnection> =
    options.equipmentConnections ??
    (connection === undefined
      ? new Map()
      : new Map(equipment.map((item) => [item.equipmentId, connection])));
  const port = createRoutingFileSource({
    ingestionSettings: { listSources: () => Promise.resolve(options.sources) },
    secrets: options.secrets ?? createMemorySecretPort(),
    equipmentConnections: { list: () => Promise.resolve(equipmentConnections) },
    equipment: { list: () => Promise.resolve(equipment) },
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
  return { probes, port };
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

describe('設備に接続がない場合・取り込み元の設定がない場合', () => {
  const UNSET = source('robot');

  it('一覧は、取得の対象の設備（種別が合い、ファイルパスを持つ設備）がなければ、何も問い合わせず、空', async () => {
    let requested = 0;
    const stat = () => {
      requested += 1;
      return Promise.resolve({});
    };
    const noPath = build({ sources: [UNSET], equipment: [robot('ROBOT-01', undefined)], stat });
    const otherKind = build({
      sources: [UNSET],
      equipment: [robot('SENSOR-01', '/data/sensor-01.json', { equipmentType: 'SENSOR' })],
      stat,
    });
    const noMatchPaths = build({ sources: [UNSET], stat });

    expect(await noPath.port.listFiles('robot')).toEqual([]);
    expect(await otherKind.port.listFiles('robot')).toEqual([]);
    // paths で絞った結果、対象がない場合も、空
    expect(await noMatchPaths.port.listFiles('robot', { paths: ['/data/none.json'] })).toEqual([]);
    expect(await noMatchPaths.port.listFiles('robot', { paths: [] })).toEqual([]);
    expect(requested).toBe(0);
  });

  it('一覧は、取得の対象の設備があれば、NOT_CONFIGURED（paths で絞った対象があるときも）', async () => {
    const all = build({ sources: [UNSET] });
    const narrowed = build({ sources: [UNSET] });

    expect((await failureOf(all.port.listFiles('robot'))).reason).toBe('NOT_CONFIGURED');
    expect(
      (await failureOf(narrowed.port.listFiles('robot', { paths: ['/data/robot-01.json'] })))
        .reason,
    ).toBe('NOT_CONFIGURED');
  });

  it('取得は、NOT_FOUND（ファイルが見つかりません）', async () => {
    const { port } = build({ sources: [UNSET] });

    const failure = await failureOf(port.readFile('robot', '/data/robot-01.json'));

    expect(failure.reason).toBe('NOT_FOUND');
  });

  it('取り込み元の設定がない（未知の識別子）は、2 つの操作とも、「取り込み元がありません」で利用できない', async () => {
    const { probes, port } = build({ sources: [] });

    for (const operation of [
      () => port.listFiles('unknown'),
      () => port.readFile('unknown', '/data/robot-01.json'),
    ]) {
      const error: unknown = await operation().then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(FileSourceUnavailableError);
      expect(error).not.toBeInstanceOf(FileSourceFailure);
      expect((error as Error).message).toBe('取り込み元がありません');
    }
    expect(probes).toHaveLength(0);
  });
});

describe('接続方式 HTTP: 設備の接続テスト（testEquipment）', () => {
  const REFERENCE = fileServerEquipmentSecretReference('ROBOT-01');

  it('秘密情報から認証のヘッダーを組み立てて、接続テストをする', async () => {
    const secrets = createMemorySecretPort({ [REFERENCE]: 'dummy-token' });
    const { probes, port } = build({
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets,
    });

    await port.testEquipment('ROBOT-01');

    expect(probes).toEqual([
      { headers: { Authorization: 'Bearer dummy-token' }, path: '/data/robot-01.json' },
    ]);
  });

  it('認証なし（NONE）は、秘密情報を読まずに、接続テストをする', async () => {
    const secrets: SecretPort = {
      get: () => Promise.reject(new Error('読まないはず')),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: false }),
    };
    const { probes, port } = build({
      sources: [source('robot')],
      connection: { ...HTTP_CONNECTION, authMethod: 'NONE' },
      secrets,
    });

    await port.testEquipment('ROBOT-01');

    expect(probes).toEqual([{ headers: {}, path: '/data/robot-01.json' }]);
  });

  it('秘密情報が未設定なら、接続せずに、CREDENTIALS_MISSING', async () => {
    const { probes, port } = build({ sources: [source('robot')], connection: HTTP_CONNECTION });

    const failure = await failureOf(port.testEquipment('ROBOT-01'));

    expect(failure.reason).toBe('CREDENTIALS_MISSING');
    expect(probes).toHaveLength(0);
  });

  it('秘密情報を読み出せないとき（保管先の障害）は、CREDENTIALS_UNAVAILABLE（値・内部の情報を含めない）', async () => {
    const secrets: SecretPort = {
      get: () => Promise.reject(new Error('AccessDeniedException: dummy-internal-detail')),
      set: () => Promise.resolve(),
      status: () => Promise.resolve({ configured: false }),
    };
    const { port } = build({ sources: [source('robot')], connection: HTTP_CONNECTION, secrets });

    const failure = await failureOf(port.testEquipment('ROBOT-01'));

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
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets,
      probe: (input) => {
        attempt += 1;
        return input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve()
          : Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    await port.testEquipment('ROBOT-01');

    expect(attempt).toBe(2);
    expect(reads).toEqual([undefined, true]);
    expect(probes.map((probe) => probe.headers.Authorization)).toEqual([
      'Bearer old-token',
      'Bearer new-token',
    ]);
  });

  it('認証に失敗し、取り直しても値が同じなら、再試行せずに、AUTH_FAILED', async () => {
    const secrets = createMemorySecretPort({ [REFERENCE]: 'dummy-token' });
    let attempt = 0;
    const { port } = build({
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets,
      probe: () => {
        attempt += 1;
        return Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      },
    });

    const failure = await failureOf(port.testEquipment('ROBOT-01'));

    expect(failure.reason).toBe('AUTH_FAILED');
    expect(attempt).toBe(1);
  });

  it('認証以外の失敗は、そのまま伝える（再試行しない）', async () => {
    const secrets = createMemorySecretPort({ [REFERENCE]: 'dummy-token' });
    let attempt = 0;
    const { port } = build({
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets,
      probe: () => {
        attempt += 1;
        return Promise.reject(new FileSourceFailure('NOT_FOUND'));
      },
    });

    expect((await failureOf(port.testEquipment('ROBOT-01'))).reason).toBe('NOT_FOUND');
    expect(attempt).toBe(1);
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
      sources: [source('robot')],
      connection: NONE,
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
      sources: [source('robot')],
      connection: NONE,
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
      sources: [source('robot')],
      connection: NONE,
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

  it('更新日時・大きさを示さないサーバーは、更新日時を 1970 年（書き換え直後とみなさない）、大きさを 0 として返す', async () => {
    const { port } = build({
      sources: [source('robot')],
      connection: NONE,
      stat: () => Promise.resolve({}),
    });

    const [file] = await port.listFiles('robot');

    expect(file?.modifiedAt.getTime()).toBe(0);
    expect(file?.sizeBytes).toBe(0);
  });

  it('ファイルが見つからない設備は、一覧から除く（ほかの設備のファイルは、返す）。それ以外の失敗は、一覧全体の失敗', async () => {
    const equipment = [robot('ROBOT-01', '/data/missing.json'), robot('ROBOT-02', '/data/ok.json')];
    const { port } = build({
      sources: [source('robot')],
      connection: NONE,
      equipment,
      stat: (input) =>
        input.path === '/data/missing.json'
          ? Promise.reject(new FileSourceFailure('NOT_FOUND'))
          : Promise.resolve({ sizeBytes: 1 }),
    });
    const failing = build({
      sources: [source('robot')],
      connection: NONE,
      equipment,
      stat: () => Promise.reject(new FileSourceFailure('SERVER_ERROR')),
    });

    expect((await port.listFiles('robot')).map((file) => file.fileId)).toEqual(['/data/ok.json']);
    expect((await failureOf(failing.port.listFiles('robot'))).reason).toBe('SERVER_ERROR');
  });

  it('ファイルパスが設定された設備がなければ、空の一覧（接続しない）', async () => {
    let requested = 0;
    const { port } = build({
      sources: [source('robot')],
      connection: NONE,
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
    const sensorSource: IngestionSource = { ...source('environment-sensor'), kind: 'SENSOR' };
    const { port } = build({
      sources: [source('robot'), sensorSource],
      connection: NONE,
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
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
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
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
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
      sources: [source('robot')],
      connection: NONE,
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
      sources: [source('robot')],
      connection: NONE,
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
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets,
      read: (input) =>
        input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve('ok')
          : Promise.reject(new FileSourceFailure('AUTH_FAILED')),
    });
    let attempts = 0;
    const same = build({
      sources: [source('robot')],
      connection: HTTP_CONNECTION,
      secrets: createMemorySecretPort({
        [fileServerEquipmentSecretReference('ROBOT-01')]: 'dummy-token',
      }),
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
      sources: [source('robot')],
      connection: NONE,
      read: () => Promise.reject(new FileSourceFailure('TOO_LARGE')),
    });

    expect((await failureOf(port.readFile('robot', '/data/robot-01.json'))).reason).toBe(
      'TOO_LARGE',
    );
  });
});

describe('設備ごとの接続（Issue #367。ADR-0026）', () => {
  const NONE = { ...HTTP_CONNECTION, authMethod: 'NONE' } as const;
  const BEARER = { ...HTTP_CONNECTION, authMethod: 'BEARER' } as const;
  const connectionOf = (
    host: string,
    authMethod: 'NONE' | 'BEARER' = 'NONE',
  ): FileServerConnection => ({ ...HTTP_CONNECTION, authMethod, host });
  const EQUIPMENT = [
    robot('ROBOT-01', '/data/robot-01.json'),
    robot('ROBOT-02', '/data/robot-02.json'),
  ];
  const FIRST = [robot('ROBOT-01', '/data/robot-01.json')];

  describe('接続の解決', () => {
    it('設備ごとに、その設備の接続の接続先を使う（一覧・取得・設備の接続テスト）', async () => {
      const hosts: Record<string, string> = {};
      const reads: Record<string, string> = {};
      const probed: Record<string, string> = {};
      const { port } = build({
        sources: [source('robot')],
        equipment: EQUIPMENT,
        equipmentConnections: new Map([
          ['ROBOT-01', connectionOf('own-01.example.ac.jp')],
          ['ROBOT-02', connectionOf('own-02.example.ac.jp')],
        ]),
        stat: (input) => {
          hosts[input.path] = input.connection.host;
          return Promise.resolve({});
        },
        read: (input) => {
          reads[input.path] = input.connection.host;
          return Promise.resolve('');
        },
        probe: (input) => {
          probed[input.path] = input.connection.host;
          return Promise.resolve();
        },
      });

      await port.listFiles('robot');
      await port.readFile('robot', '/data/robot-01.json');
      await port.readFile('robot', '/data/robot-02.json');
      await port.testEquipment('ROBOT-01');
      await port.testEquipment('ROBOT-02');

      const expected = {
        '/data/robot-01.json': 'own-01.example.ac.jp',
        '/data/robot-02.json': 'own-02.example.ac.jp',
      };
      expect(hosts).toEqual(expected);
      expect(reads).toEqual(expected);
      expect(probed).toEqual(expected);
    });

    it('設備の接続があれば、その設備のファイルを一覧・取得できる', async () => {
      const { port } = build({
        sources: [source('robot')],
        equipment: FIRST,
        equipmentConnections: new Map([['ROBOT-01', NONE]]),
        stat: () => Promise.resolve({ sizeBytes: 5 }),
        read: () => Promise.resolve('{}'),
      });

      expect((await port.listFiles('robot')).map((file) => file.fileId)).toEqual([
        '/data/robot-01.json',
      ]);
      expect(await port.readFile('robot', '/data/robot-01.json')).toBe('{}');
    });

    it('設備に接続がない設備は、NOT_CONFIGURED（指定がなければ、最初の失敗を投げる）。その設備のファイルは、取得しない', async () => {
      const statted: string[] = [];
      const { port } = build({
        sources: [source('robot')],
        equipment: EQUIPMENT,
        equipmentConnections: new Map([['ROBOT-01', NONE]]),
        stat: (input) => {
          statted.push(input.path);
          return Promise.resolve({});
        },
      });

      const failure = await failureOf(port.listFiles('robot'));

      expect(failure.reason).toBe('NOT_CONFIGURED');
      expect(statted).toEqual(['/data/robot-01.json']);
      expect((await failureOf(port.readFile('robot', '/data/robot-02.json'))).reason).toBe(
        'NOT_FOUND',
      );
    });

    it('設備ごとの接続の一覧は、1 回の操作で、1 回だけ読む（設備の数だけ読まない）', async () => {
      let reads = 0;
      const port = createRoutingFileSource({
        ingestionSettings: { listSources: () => Promise.resolve([source('robot')]) },
        equipmentConnections: {
          list: () => {
            reads += 1;
            return Promise.resolve(
              new Map([
                ['ROBOT-01', NONE],
                ['ROBOT-02', NONE],
                ['ROBOT-03', NONE],
              ]),
            );
          },
        },
        equipment: {
          list: () => Promise.resolve([...EQUIPMENT, robot('ROBOT-03', '/data/robot-03.json')]),
        },
        secrets: createMemorySecretPort(),
        maxFileBytes: 1000,
        http: {
          probe: () => Promise.resolve(),
          stat: () => Promise.resolve({}),
          read: () => Promise.resolve(''),
        },
      });

      await port.listFiles('robot');
      expect(reads).toBe(1);
      await port.readFile('robot', '/data/robot-02.json');
      expect(reads).toBe(2);
      await port.testEquipment('ROBOT-01');
      expect(reads).toBe(3);
    });
  });

  describe('認証情報', () => {
    it('設備の接続は、設備ごとの認証情報（設備ごとの参照名）を使う。設備ごとに値が違う', async () => {
      const secrets = createMemorySecretPort({
        [fileServerEquipmentSecretReference('ROBOT-01')]: 'dummy-token-01',
        [fileServerEquipmentSecretReference('ROBOT-02')]: 'dummy-token-02',
        [fileServerEquipmentSecretReference('ROBOT-03')]: 'dummy-token-03',
      });
      const authorizations: Record<string, string | undefined> = {};
      const { port } = build({
        sources: [source('robot')],
        secrets,
        equipment: [...EQUIPMENT, robot('ROBOT-03', '/data/robot-03.json')],
        equipmentConnections: new Map([
          ['ROBOT-01', BEARER],
          ['ROBOT-02', BEARER],
          ['ROBOT-03', BEARER],
        ]),
        stat: (input) => {
          authorizations[input.path] = input.headers.Authorization;
          return Promise.resolve({});
        },
      });

      await port.listFiles('robot');

      expect(authorizations).toEqual({
        '/data/robot-01.json': 'Bearer dummy-token-01',
        '/data/robot-02.json': 'Bearer dummy-token-02',
        '/data/robot-03.json': 'Bearer dummy-token-03',
      });
    });

    it('設備の接続の認証情報が未設定なら、以前の取り込み元の認証情報（file-server/<取り込み元>）にはフォールバックせず、CREDENTIALS_MISSING', async () => {
      let requested = 0;
      const { port } = build({
        sources: [source('robot')],
        secrets: createMemorySecretPort({ 'file-server/robot': 'dummy-shared-token' }),
        equipment: FIRST,
        equipmentConnections: new Map([['ROBOT-01', BEARER]]),
        stat: () => {
          requested += 1;
          return Promise.resolve({});
        },
      });

      expect((await failureOf(port.listFiles('robot'))).reason).toBe('CREDENTIALS_MISSING');
      expect(requested).toBe(0);
    });

    it('認証に失敗したときの取り直しも、設備ごとの参照名で読む（取得・設備の接続テスト）', async () => {
      const reads: { reference: string; refresh: boolean | undefined }[] = [];
      const secrets: SecretPort = {
        get: (reference, options) => {
          reads.push({ reference, refresh: options?.refresh });
          return Promise.resolve(options?.refresh === true ? 'new-token' : 'old-token');
        },
        set: () => Promise.resolve(),
        status: () => Promise.resolve({ configured: true }),
      };
      const accept = (input: { headers: Readonly<Record<string, string>> }) =>
        input.headers.Authorization === 'Bearer new-token'
          ? Promise.resolve()
          : Promise.reject(new FileSourceFailure('AUTH_FAILED'));
      const { port } = build({
        sources: [source('robot')],
        secrets,
        equipment: FIRST,
        equipmentConnections: new Map([['ROBOT-01', BEARER]]),
        probe: accept,
        read: (input) => accept(input).then(() => 'ok'),
      });
      const reference = fileServerEquipmentSecretReference('ROBOT-01');

      await port.testEquipment('ROBOT-01');
      expect(await port.readFile('robot', '/data/robot-01.json')).toBe('ok');

      expect(reads).toEqual([
        { reference, refresh: undefined },
        { reference, refresh: true },
        { reference, refresh: undefined },
        { reference, refresh: true },
      ]);
    });
  });

  describe('一覧: 設備ごとの失敗', () => {
    function failing(failures: Record<string, FileSourceFailure['reason']>) {
      const failed: FileListFailure[] = [];
      const harness = build({
        sources: [source('robot')],
        connection: NONE,
        equipment: [...EQUIPMENT, robot('ROBOT-03', '/data/robot-03.json')],
        stat: (input) => {
          const reason = failures[input.path];
          return reason === undefined
            ? Promise.resolve({ sizeBytes: 1 })
            : Promise.reject(new FileSourceFailure(reason));
        },
      });
      return { ...harness, failed, onFailure: (failure: FileListFailure) => failed.push(failure) };
    }

    it('onFailure があれば、失敗した設備のファイルを一覧から除き、失敗（パス・理由）を渡して、ほかの設備を続ける', async () => {
      const { port, failed, onFailure } = failing({
        '/data/robot-01.json': 'UNREACHABLE',
        '/data/robot-02.json': 'AUTH_FAILED',
      });

      const files = await port.listFiles('robot', { onFailure });

      expect(files.map((file) => file.fileId)).toEqual(['/data/robot-03.json']);
      expect(failed.map((failure) => failure.path)).toEqual([
        '/data/robot-01.json',
        '/data/robot-02.json',
      ]);
      expect(failed.map((failure) => failure.error)).toEqual([
        expect.objectContaining({ reason: 'UNREACHABLE' }),
        expect.objectContaining({ reason: 'AUTH_FAILED' }),
      ]);
    });

    it('見つからないファイルは、失敗として渡さない（一覧から除くだけ）。onFailure がなければ、最初の失敗を投げる', async () => {
      const { port, failed, onFailure } = failing({
        '/data/robot-01.json': 'NOT_FOUND',
        '/data/robot-02.json': 'SERVER_ERROR',
      });

      expect((await port.listFiles('robot', { onFailure })).map((file) => file.fileId)).toEqual([
        '/data/robot-03.json',
      ]);
      expect(failed.map((failure) => failure.path)).toEqual(['/data/robot-02.json']);
      expect((await failureOf(port.listFiles('robot'))).reason).toBe('SERVER_ERROR');
    });

    it('接続が解決できない設備（NOT_CONFIGURED）も、設備ごとの失敗として渡す。paths で絞ったときは、その設備だけ', async () => {
      const failed: FileListFailure[] = [];
      const { port } = build({
        sources: [source('robot')],
        equipment: EQUIPMENT,
        equipmentConnections: new Map([['ROBOT-01', NONE]]),
      });

      const all = await port.listFiles('robot', { onFailure: (failure) => failed.push(failure) });
      const narrowed = await port.listFiles('robot', {
        paths: ['/data/robot-01.json'],
        onFailure: (failure) => failed.push(failure),
      });

      expect(all.map((file) => file.fileId)).toEqual(['/data/robot-01.json']);
      expect(narrowed.map((file) => file.fileId)).toEqual(['/data/robot-01.json']);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        path: '/data/robot-02.json',
        error: { reason: 'NOT_CONFIGURED' },
      });
    });

    it('FileSourceUnavailableError でない想定外のエラーは、onFailure があっても、投げる（握りつぶさない）', async () => {
      const { port } = build({
        sources: [source('robot')],
        connection: NONE,
        stat: () => Promise.reject(new Error('想定外')),
      });

      await expect(port.listFiles('robot', { onFailure: () => undefined })).rejects.toThrow(
        '想定外',
      );
    });
  });

  describe('設備の接続テスト（testEquipment）', () => {
    it('その設備のファイルパスに、設備の接続・認証情報で、接続する。ほかの設備には、接続しない', async () => {
      const { probes, port } = build({
        sources: [source('robot')],
        secrets: createMemorySecretPort({
          [fileServerEquipmentSecretReference('ROBOT-02')]: 'dummy-token-02',
        }),
        equipment: EQUIPMENT,
        equipmentConnections: new Map([['ROBOT-02', BEARER]]),
      });

      await port.testEquipment('ROBOT-02');

      expect(probes).toEqual([
        { headers: { Authorization: 'Bearer dummy-token-02' }, path: '/data/robot-02.json' },
      ]);
    });

    it('設備に接続がなければ、接続せずに、NOT_CONFIGURED（取り込み元の設定がない場合も）', async () => {
      const unset = build({ sources: [source('robot')], equipment: EQUIPMENT });
      const noSource = build({ sources: [], equipment: EQUIPMENT });

      expect((await failureOf(unset.port.testEquipment('ROBOT-01'))).reason).toBe('NOT_CONFIGURED');
      expect((await failureOf(noSource.port.testEquipment('ROBOT-01'))).reason).toBe(
        'NOT_CONFIGURED',
      );
      expect(unset.probes).toHaveLength(0);
      expect(noSource.probes).toHaveLength(0);
    });

    it('ファイルパスのない設備・ロボットでもセンサーでもない設備は、接続せずに、NO_FILE_PATH', async () => {
      const { probes, port } = build({
        sources: [source('robot')],
        equipment: [
          robot('ROBOT-01', undefined),
          robot('HOUSE-01', '/data/house.json', { equipmentType: 'FACILITY' }),
        ],
        equipmentConnections: new Map([
          ['ROBOT-01', NONE],
          ['HOUSE-01', NONE],
        ]),
      });

      expect((await failureOf(port.testEquipment('ROBOT-01'))).reason).toBe('NO_FILE_PATH');
      expect((await failureOf(port.testEquipment('HOUSE-01'))).reason).toBe('NO_FILE_PATH');
      expect(probes).toHaveLength(0);
    });

    it('設備がない・削除済みの設備は、「設備がありません」で利用できない（理由つきの失敗ではない）', async () => {
      const { probes, port } = build({
        sources: [source('robot')],
        equipment: [robot('ROBOT-01', '/data/robot-01.json', { isDeleted: true })],
        equipmentConnections: new Map([['ROBOT-01', NONE]]),
      });

      for (const equipmentId of ['ROBOT-01', 'ROBOT-99']) {
        const error: unknown = await port.testEquipment(equipmentId).then(
          () => undefined,
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(FileSourceUnavailableError);
        expect(error).not.toBeInstanceOf(FileSourceFailure);
        expect((error as Error).message).toBe('設備がありません');
      }
      expect(probes).toHaveLength(0);
    });

    it('認証に失敗し、取り直しても値が同じなら、AUTH_FAILED（センサーも、その設備の接続・認証情報を使う）', async () => {
      const sensorSource: IngestionSource = { ...source('environment-sensor'), kind: 'SENSOR' };
      const { port } = build({
        sources: [source('robot'), sensorSource],
        secrets: createMemorySecretPort({
          [fileServerEquipmentSecretReference('SENSOR-01')]: 'dummy-sensor-token',
        }),
        equipment: [robot('SENSOR-01', '/data/sensor-01.json', { equipmentType: 'SENSOR' })],
        equipmentConnections: new Map([['SENSOR-01', BEARER]]),
        probe: () => Promise.reject(new FileSourceFailure('AUTH_FAILED')),
      });

      expect((await failureOf(port.testEquipment('SENSOR-01'))).reason).toBe('AUTH_FAILED');
    });
  });
});
