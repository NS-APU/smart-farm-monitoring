/**
 * ローカル実行のデータファイル（`PERSISTENCE=file` の JSON）のバックアップ・復元（NFR-4.2・4.3。V-043）。
 * 本番の DynamoDB は、サービスのバックアップ（PITR）を使う（docs/40_operations/backup-restore.md）。
 * - バックアップ: 内容を検証（JSON として読め、版が扱える範囲であること）してから、日時つきの名前で複製する（権限は所有者のみ）
 * - 復元: バックアップを検証してから、現在のファイルを `.before-restore-<日時>` として退避し、置き換える。
 *   サーバーを止めてから実行する（動作中のサーバーは、メモリ上のデータを、あとから書き戻すため）
 * - 世代の削除は、`keep` を指定したときだけ行う（既定では、何も消さない）
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FILE_FORMAT_VERSION } from './local-store.ts';

const BACKUP_FILE_PATTERN = /^store-\d{8}T\d{6}Z\.json$/;
/** バックアップの権限（所有者のみ）。パスワードのハッシュを含む全データのため（Windows では、OS の制約で無効）。 */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const BackupContentSchema = z.object({
  version: z.number().int().optional(),
  collections: z.record(z.string(), z.array(z.unknown())).optional(),
});

export class DataBackupError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DataBackupError';
  }
}

/** バックアップ・復元の対象として読めるデータファイルか確認する（壊れたファイルを、バックアップ・復元しない）。 */
function assertValidDataFile(path: string): void {
  if (!existsSync(path)) {
    throw new DataBackupError(`ファイルがありません: ${path}`);
  }
  let version: number | undefined;
  try {
    version = BackupContentSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).version;
  } catch (error) {
    throw new DataBackupError(`データファイルとして読めません: ${path}`, { cause: error });
  }
  if (version !== undefined && version > FILE_FORMAT_VERSION) {
    throw new DataBackupError(
      `データファイルの版（${String(version)}）が、このアプリより新しいため、扱えません`,
    );
  }
}

/** ファイル名に使う日時（例: 20261009T030000Z）。 */
function timestampOf(now: Date): string {
  return now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** バックアップの一覧（日時の新しい順）。ディレクトリがなければ空。 */
export function listBackups(backupDirectory: string): string[] {
  if (!existsSync(backupDirectory)) {
    return [];
  }
  return readdirSync(backupDirectory)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse();
}

export interface BackupOptions {
  readonly dataFile: string;
  readonly backupDirectory: string;
  readonly now: Date;
  /** 残す世代数。指定したときだけ、古い世代を削除する（省略すると、何も削除しない）。 */
  readonly keep?: number;
}

/** バックアップを作り、そのパスを返す。 */
export function backupDataFile(options: BackupOptions): string {
  assertValidDataFile(options.dataFile);
  mkdirSync(options.backupDirectory, { recursive: true, mode: DIRECTORY_MODE });
  const target = join(options.backupDirectory, `store-${timestampOf(options.now)}.json`);
  copyFileSync(options.dataFile, target);
  chmodSync(target, FILE_MODE);
  if (options.keep !== undefined) {
    // 新しい順に並んでいる。最新の1世代は、常に残す
    for (const old of listBackups(options.backupDirectory).slice(Math.max(1, options.keep))) {
      rmSync(join(options.backupDirectory, old));
    }
  }
  return target;
}

export interface RestoreOptions {
  readonly backupFile: string;
  readonly dataFile: string;
  readonly now: Date;
}

/** バックアップから復元する。現在のファイルがあれば、退避したパスを返す（なければ null）。 */
export function restoreDataFile(options: RestoreOptions): string | null {
  assertValidDataFile(options.backupFile);
  let saved: string | null = null;
  if (existsSync(options.dataFile)) {
    saved = `${options.dataFile}.before-restore-${timestampOf(options.now)}`;
    copyFileSync(options.dataFile, saved);
  }
  copyFileSync(options.backupFile, options.dataFile);
  return saved;
}

/** 実行結果を表示する出力（テストで差し替える）。 */
export interface CliOutput {
  info(message: string): void;
  error(message: string): void;
}

const USAGE = [
  '使い方: pnpm data:backup <backup|list|restore> [引数]',
  '  backup [--keep N]        データファイルを、バックアップのディレクトリへ複製する（N 世代だけ残す。省略時は削除しない）',
  '  list                     バックアップの一覧（新しい順）',
  '  restore <バックアップのファイル名>  バックアップから復元する（サーバーを止めてから実行する）',
  '環境変数: DATA_FILE（既定 .local-data/store.json）、BACKUP_DIR（既定 .local-data/backups）',
].join('\n');

/** コマンドラインの実行。終了コード（0: 成功、1: 失敗、2: 使い方の誤り）を返す。 */
export function runDataBackupCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: CliOutput,
  now: Date,
): number {
  const dataFile = env.DATA_FILE ?? '.local-data/store.json';
  const backupDirectory = env.BACKUP_DIR ?? '.local-data/backups';
  const [command, ...rest] = args;
  try {
    if (command === 'backup') {
      const keepIndex = rest.indexOf('--keep');
      const keepText = keepIndex >= 0 ? rest[keepIndex + 1] : undefined;
      const keep = keepText === undefined ? undefined : Number(keepText);
      if (keepIndex >= 0 && (keep === undefined || !Number.isInteger(keep) || keep < 1)) {
        output.error('--keep には、1 以上の整数を指定してください');
        return 2;
      }
      const created = backupDataFile({
        dataFile,
        backupDirectory,
        now,
        ...(keep === undefined ? {} : { keep }),
      });
      output.info(`バックアップを作成しました: ${created}`);
      return 0;
    }
    if (command === 'list') {
      const backups = listBackups(backupDirectory);
      output.info(backups.length === 0 ? 'バックアップはありません' : backups.join('\n'));
      return 0;
    }
    if (command === 'restore') {
      const name = rest[0];
      if (name === undefined || !BACKUP_FILE_PATTERN.test(name)) {
        output.error('復元するバックアップのファイル名（store-<日時>.json）を指定してください');
        return 2;
      }
      const saved = restoreDataFile({ backupFile: join(backupDirectory, name), dataFile, now });
      output.info(
        `復元しました: ${dataFile}${saved === null ? '' : `（元のファイルは ${saved} に退避しました）`}`,
      );
      return 0;
    }
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  output.error(USAGE);
  return 2;
}
