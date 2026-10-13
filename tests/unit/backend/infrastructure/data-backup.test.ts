import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DataBackupError,
  backupDataFile,
  listBackups,
  restoreDataFile,
  runDataBackupCli,
} from '../../../../src/backend/infrastructure/local/data-backup.ts';

const NOW = new Date('2026-10-09T03:00:00Z');
const VALID = JSON.stringify({ version: 1, collections: { items: [{ id: 'a' }] } });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'smart-farm-backup-'));
  const dataFile = join(directory, 'store.json');
  const backupDirectory = join(directory, 'backups');
  writeFileSync(dataFile, VALID, 'utf8');
  return { directory, dataFile, backupDirectory };
}

describe('データファイルのバックアップ・復元（V-043）', () => {
  it('日時つきの名前で複製し、一覧は新しい順。既定では、何も削除しない', () => {
    const { dataFile, backupDirectory } = setup();

    const first = backupDataFile({ dataFile, backupDirectory, now: NOW });
    backupDataFile({ dataFile, backupDirectory, now: new Date(NOW.getTime() + 60_000) });
    backupDataFile({ dataFile, backupDirectory, now: new Date(NOW.getTime() + 120_000) });

    expect(first.endsWith('store-20261009T030000Z.json')).toBe(true);
    expect(readFileSync(first, 'utf8')).toBe(VALID);
    expect(listBackups(backupDirectory)).toEqual([
      'store-20261009T030200Z.json',
      'store-20261009T030100Z.json',
      'store-20261009T030000Z.json',
    ]);
    expect(listBackups(join(backupDirectory, 'none'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'バックアップは、所有者のみが読み書きできる権限で作る',
    () => {
      const { dataFile, backupDirectory } = setup();

      const created = backupDataFile({ dataFile, backupDirectory, now: NOW });

      expect(statSync(created).mode & 0o777).toBe(0o600);
    },
  );

  it('keep を指定したときだけ、古い世代を削除する（最新の1世代は常に残す）', () => {
    const { dataFile, backupDirectory } = setup();
    for (let minute = 0; minute < 4; minute += 1) {
      backupDataFile({ dataFile, backupDirectory, now: new Date(NOW.getTime() + minute * 60_000) });
    }

    backupDataFile({
      dataFile,
      backupDirectory,
      now: new Date(NOW.getTime() + 5 * 60_000),
      keep: 2,
    });

    expect(listBackups(backupDirectory)).toEqual([
      'store-20261009T030500Z.json',
      'store-20261009T030300Z.json',
    ]);
    backupDataFile({
      dataFile,
      backupDirectory,
      now: new Date(NOW.getTime() + 6 * 60_000),
      keep: 0,
    });
    expect(listBackups(backupDirectory)).toEqual(['store-20261009T030600Z.json']);
  });

  it('壊れたファイル・版が新しいファイル・存在しないファイルは、バックアップしない', () => {
    const { directory, dataFile, backupDirectory } = setup();
    const broken = join(directory, 'broken.json');
    writeFileSync(broken, '{broken', 'utf8');
    const newer = join(directory, 'newer.json');
    writeFileSync(newer, JSON.stringify({ version: 99 }), 'utf8');

    expect(() => backupDataFile({ dataFile: broken, backupDirectory, now: NOW })).toThrow(
      DataBackupError,
    );
    expect(() => backupDataFile({ dataFile: newer, backupDirectory, now: NOW })).toThrow('版');
    expect(() =>
      backupDataFile({ dataFile: join(directory, 'none.json'), backupDirectory, now: NOW }),
    ).toThrow('ファイルがありません');
    expect(existsSync(backupDirectory)).toBe(false);
    expect(dataFile).toBeDefined();
  });

  it('復元: 現在のファイルを退避してから、バックアップで置き換える。現在のファイルがなければ、退避なし', () => {
    const { directory, dataFile, backupDirectory } = setup();
    const backup = backupDataFile({ dataFile, backupDirectory, now: NOW });
    const changed = JSON.stringify({ version: 1, collections: { items: [{ id: 'changed' }] } });
    writeFileSync(dataFile, changed, 'utf8');

    const saved = restoreDataFile({
      backupFile: backup,
      dataFile,
      now: new Date(NOW.getTime() + 1000),
    });

    expect(readFileSync(dataFile, 'utf8')).toBe(VALID);
    expect(saved).not.toBeNull();
    expect(readFileSync(saved ?? '', 'utf8')).toBe(changed);
    const other = join(directory, 'fresh.json');
    expect(restoreDataFile({ backupFile: backup, dataFile: other, now: NOW })).toBeNull();
    expect(readFileSync(other, 'utf8')).toBe(VALID);
  });

  it('復元: 壊れたバックアップでは、現在のファイルに触れない', () => {
    const { directory, dataFile } = setup();
    const broken = join(directory, 'broken.json');
    writeFileSync(broken, 'not json', 'utf8');

    expect(() => restoreDataFile({ backupFile: broken, dataFile, now: NOW })).toThrow(
      DataBackupError,
    );
    expect(readFileSync(dataFile, 'utf8')).toBe(VALID);
    expect(readdirSync(directory).some((name) => name.includes('before-restore'))).toBe(false);
  });
});

describe('コマンド（pnpm data:backup）', () => {
  function run(args: string[], env: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runDataBackupCli(
      args,
      env,
      { info: (m) => out.push(m), error: (m) => err.push(m) },
      NOW,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('backup・list・restore の一連の操作ができる', () => {
    const { dataFile, backupDirectory } = setup();
    const env = { DATA_FILE: dataFile, BACKUP_DIR: backupDirectory };

    expect(run(['list'], env)).toMatchObject({ code: 0, out: 'バックアップはありません' });
    expect(run(['backup'], env)).toMatchObject({ code: 0 });
    expect(run(['backup', '--keep', '3'], env).code).toBe(0);
    const listed = run(['list'], env);
    expect(listed.out).toContain('store-20261009T030000Z.json');
    const restored = run(['restore', 'store-20261009T030000Z.json'], env);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('退避しました');
  });

  it('使い方の誤り（コマンドなし・不正な keep・復元のファイル名の不正）は、終了コード 2。失敗は、終了コード 1', () => {
    const { dataFile, backupDirectory } = setup();
    const env = { DATA_FILE: dataFile, BACKUP_DIR: backupDirectory };

    expect(run([], env)).toMatchObject({ code: 2 });
    expect(run([], env).err).toContain('使い方');
    expect(run(['backup', '--keep', 'x'], env).code).toBe(2);
    expect(run(['backup', '--keep'], env).code).toBe(2);
    expect(run(['restore'], env).code).toBe(2);
    expect(run(['restore', '../x.json'], env).code).toBe(2);
    expect(run(['restore', 'store-20200101T000000Z.json'], env)).toMatchObject({ code: 1 });
    expect(run(['backup'], { ...env, DATA_FILE: join(backupDirectory, 'none.json') }).code).toBe(1);
  });

  it('環境変数がなければ、既定の場所（.local-data）を使う', () => {
    const result = run(['list'], {});

    expect(result.code).toBe(0);
  });
});
