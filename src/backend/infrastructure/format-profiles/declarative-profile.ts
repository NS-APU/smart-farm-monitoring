/**
 * 宣言的な FormatProfile（設定で、ファイルのレイアウトと項目名の対応づけを書く。NFR-8.1）。
 * 仮決めと確定の仕様を、並べて比較できる形（設定ファイル）で持つ（FR-1.11, FR-1.12、ADR-0003）。
 * 項目の値の型・範囲の検証は、取り込みの検証（domain/observation-quality.ts）で行う。ここは、構造の読み取りのみ。
 */

import { z } from 'zod';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import { JST_OFFSET_MINUTES, MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  FormatError,
  type FormatProfile,
  type FormatProfileRegistry,
  type ParsedFile,
  type ParsedRecord,
} from '../../application/ports/format-profile.ts';
import environmentSensorCsvConfig from './environment-sensor-csv.profile.json' with { type: 'json' };
import robotJsonConfig from './robot-json.profile.json' with { type: 'json' };

const FieldMappingSchema = z.object({ source: z.string().min(1), itemKey: z.string().min(1) });

const BaseConfigSchema = z.object({
  profileId: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['PROVISIONAL', 'CONFIRMED']),
  /** 仮決めの根拠（資料・ヒアリング・推察の理由。FR-1.11）。 */
  basis: z.string().min(1),
  /**
   * タイムゾーンのない計測日時（例: `2026-10-09T10:00:00`）を解釈する、UTC からの差（分）。既定は日本時間（+09:00）。
   * 実行環境のタイムゾーン（開発 PC は日本時間、Lambda は UTC）に依存させない（仮決め。Q-001）。
   */
  utcOffsetMinutes: z.number().int().min(-720).max(840).default(JST_OFFSET_MINUTES),
  fields: z.array(FieldMappingSchema).min(1),
});

export const FormatProfileConfigSchema = z.discriminatedUnion('format', [
  BaseConfigSchema.extend({
    format: z.literal('JSON'),
    layout: z.object({
      /** 記録の配列のパス（ドット区切り）。 */
      recordsPath: z.string().min(1),
      /** ファイル全体の設備の識別子のパス。 */
      equipmentIdPath: z.string().min(1),
      timestampField: z.string().min(1),
    }),
  }),
  BaseConfigSchema.extend({
    format: z.literal('CSV'),
    layout: z.object({
      delimiter: z.string().length(1),
      equipmentIdColumn: z.string().min(1),
      timestampColumn: z.string().min(1),
    }),
  }),
]);
export type FormatProfileConfig = z.infer<typeof FormatProfileConfigSchema>;

/** オブジェクト（配列を含む）か。キーで値を引ける形に絞り込む。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function valueAtPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

const OFFSET_LESS_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ZONED_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * 計測日時の文字列を、ISO 8601 の UTC の文字列にする。ISO 8601 以外の形式・存在しない日時は undefined（読み取れない記録）。
 * - タイムゾーンの指定（Z・±hh:mm）がある場合は、その指定で解釈する（元の文字列を保つ。区切りが空白なら `T` にする）
 * - ない場合は、utcOffsetMinutes（プロファイルの設定）の時刻として解釈する。実行環境のタイムゾーンは使わない
 */
export function toUtcTimestamp(text: string, utcOffsetMinutes: number): string | undefined {
  const trimmed = text.trim();
  if (ZONED_DATETIME.test(trimmed)) {
    const normalized = trimmed.replace(' ', 'T');
    return Number.isNaN(Date.parse(normalized)) ? undefined : normalized;
  }
  const match = OFFSET_LESS_DATETIME.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const local = new Date(localMs);
  // 存在しない日時（2月31日・25時など）は、読み取れない記録にする
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute
  ) {
    return undefined;
  }
  return new Date(localMs - utcOffsetMinutes * MS_PER_MINUTE).toISOString();
}

/** CSV の値を、項目の型に合わせて数値に変換する。変換できない値は、そのまま渡して検証で不正にする。 */
function convertCsvValue(itemKey: string, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  if (findItemDefinition(itemKey)?.valueType === 'string') {
    return trimmed;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function parseJson(
  config: Extract<FormatProfileConfig, { format: 'JSON' }>,
  content: string,
): ParsedFile {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new FormatError('JSON として読み取れません', { cause: error });
  }
  const rawRecords = valueAtPath(document, config.layout.recordsPath);
  const externalId = valueAtPath(document, config.layout.equipmentIdPath);
  if (!Array.isArray(rawRecords) || typeof externalId !== 'string' || externalId === '') {
    throw new FormatError('ファイルの構造が仕様と異なります');
  }

  const records: ParsedRecord[] = [];
  let rejectedCount = 0;
  for (const rawRecord of rawRecords) {
    const timestamp = isRecord(rawRecord) ? rawRecord[config.layout.timestampField] : undefined;
    const observedAt =
      typeof timestamp === 'string'
        ? toUtcTimestamp(timestamp, config.utcOffsetMinutes)
        : undefined;
    if (!isRecord(rawRecord) || observedAt === undefined) {
      rejectedCount += 1;
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const { source, itemKey } of config.fields) {
      const value = rawRecord[source];
      if (value !== undefined) {
        fields[itemKey] = value;
      }
    }
    records.push({ externalId, observedAt, fields });
  }
  // 項目名が変わり、設定した項目が1つも読み取れない場合は、構造の変更として検出する（0件の「成功」にしない。V-019）
  if (records.length > 0 && records.every((record) => Object.keys(record.fields).length === 0)) {
    throw new FormatError('項目名が仕様と異なります');
  }
  return { records, rejectedCount };
}

/**
 * CSV の1行を、区切り文字で分ける。引用符で囲んだ値（`"a,b"`・`""` で引用符）に対応する（RFC 4180。値の中の改行は未対応）。
 * 引用符の閉じ忘れなど、形式が不正な行は、区切り文字だけで分ける（列の数が合わなければ、読み取れなかった行になる）。
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  if (!line.includes('"')) {
    return line.split(delimiter);
  }
  const columns: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (inQuotes) {
      if (char === '"' && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current === '') {
      inQuotes = true;
    } else if (char === delimiter) {
      columns.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    return line.split(delimiter);
  }
  columns.push(current);
  return columns;
}

/** UTF-8 の BOM（先頭の U+FEFF）を取り除く（Windows のデータロガー・表計算ソフトの出力で付く。見出し名が変わるのを防ぐ）。 */
function stripBom(content: string): string {
  return content.startsWith(String.fromCodePoint(0xfeff)) ? content.slice(1) : content;
}

function parseCsv(
  config: Extract<FormatProfileConfig, { format: 'CSV' }>,
  content: string,
): ParsedFile {
  const lines = stripBom(content)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header =
    lines[0] === undefined
      ? undefined
      : splitCsvLine(lines[0], config.layout.delimiter).map((column) => column.trim());
  if (header === undefined) {
    throw new FormatError('CSV に見出し行がありません');
  }
  const idIndex = header.indexOf(config.layout.equipmentIdColumn);
  const timestampIndex = header.indexOf(config.layout.timestampColumn);
  // 設備ID・計測日時の列がない、または、設定した項目の列が1つもない場合は、構造の変更として検出する（V-019）
  if (
    idIndex < 0 ||
    timestampIndex < 0 ||
    config.fields.every(({ source }) => !header.includes(source))
  ) {
    throw new FormatError('CSV の見出しが仕様と異なります');
  }

  const records: ParsedRecord[] = [];
  let rejectedCount = 0;
  for (const line of lines.slice(1)) {
    const columns = splitCsvLine(line, config.layout.delimiter);
    const externalId = columns[idIndex]?.trim();
    const timestamp = columns[timestampIndex]?.trim();
    const observedAt =
      timestamp === undefined ? undefined : toUtcTimestamp(timestamp, config.utcOffsetMinutes);
    if (columns.length !== header.length || !externalId || observedAt === undefined) {
      rejectedCount += 1;
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const { source, itemKey } of config.fields) {
      const index = header.indexOf(source);
      const text = index < 0 ? undefined : columns[index];
      if (text !== undefined) {
        fields[itemKey] = convertCsvValue(itemKey, text);
      }
    }
    records.push({ externalId, observedAt, fields });
  }
  return { records, rejectedCount };
}

export function createDeclarativeProfile(rawConfig: unknown): FormatProfile {
  const config = FormatProfileConfigSchema.parse(rawConfig);
  return {
    profileId: config.profileId,
    version: config.version,
    status: config.status,
    versionLabel: `${config.profileId}@${config.version}(${config.status})`,
    parse: (content) =>
      config.format === 'JSON' ? parseJson(config, content) : parseCsv(config, content),
  };
}

export function createFormatProfileRegistry(
  profiles: readonly FormatProfile[],
): FormatProfileRegistry {
  const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
  return { get: (profileId) => byId.get(profileId) };
}

/** 仮決めの FormatProfile（ロボットデータ JSON、環境センサー CSV）。確定仕様の提供後に追加・差し替える。 */
export function createDefaultFormatProfileRegistry(): FormatProfileRegistry {
  return createFormatProfileRegistry([
    createDeclarativeProfile(robotJsonConfig),
    createDeclarativeProfile(environmentSensorCsvConfig),
  ]);
}
