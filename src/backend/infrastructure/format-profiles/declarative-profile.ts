/**
 * 宣言的な FormatProfile（設定で、ファイルのレイアウトと項目名の対応づけを書く。NFR-8.1）。
 * 仮決めと確定の仕様を、並べて比較できる形（設定ファイル）で持つ（FR-1.11, FR-1.12、ADR-0003）。
 * 項目の値の型・範囲の検証は、取り込みの検証（domain/observation-quality.ts）で行う。ここは、構造の読み取りのみ。
 *
 * ファイルは、JSON（1 つのファイルを随時更新する。更新のたびに全体が書き換わり、中身は最新の値だけ。ADR-0016 の D-08・ADR-0003 の更新）。
 * ロボットも環境センサーも、同じ形（設備の識別子 + 記録の配列）。CSV は、扱わない（#174 で削除）。
 */

import { z } from 'zod';
import { JST_OFFSET_MINUTES, MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  FormatError,
  type FormatProfile,
  type FormatProfileRegistry,
  type ParsedFile,
  type ParsedRecord,
} from '../../application/ports/format-profile.ts';
import environmentSensorJsonConfig from './environment-sensor-json.profile.json' with { type: 'json' };
import robotJsonConfig from './robot-json.profile.json' with { type: 'json' };

const FieldMappingSchema = z.object({ source: z.string().min(1), itemKey: z.string().min(1) });

export const FormatProfileConfigSchema = z.object({
  profileId: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['PROVISIONAL', 'CONFIRMED']),
  /** 仮決めの根拠（資料・ヒアリング・推察の理由。FR-1.11）。 */
  basis: z.string().min(1),
  format: z.literal('JSON'),
  /**
   * タイムゾーンのない計測日時（例: `2026-10-09T10:00:00`）を解釈する、UTC からの差（分）。既定は日本時間（+09:00）。
   * 実行環境のタイムゾーン（開発 PC は日本時間、Lambda は UTC）に依存させない（仮決め。Q-001）。
   */
  utcOffsetMinutes: z.number().int().min(-720).max(840).default(JST_OFFSET_MINUTES),
  layout: z.object({
    /** 記録の配列のパス（ドット区切り）。 */
    recordsPath: z.string().min(1),
    /** ファイル全体の設備の識別子のパス。 */
    equipmentIdPath: z.string().min(1),
    timestampField: z.string().min(1),
  }),
  fields: z.array(FieldMappingSchema).min(1),
});
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

/** UTF-8 の BOM（先頭の U+FEFF）を取り除く（Windows の道具の出力で付くことがある。JSON として読めなくなるのを防ぐ）。 */
function stripBom(content: string): string {
  return content.startsWith(String.fromCodePoint(0xfeff)) ? content.slice(1) : content;
}

function parseJson(config: FormatProfileConfig, content: string): ParsedFile {
  let document: unknown;
  try {
    document = JSON.parse(stripBom(content));
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

export function createDeclarativeProfile(rawConfig: unknown): FormatProfile {
  const config = FormatProfileConfigSchema.parse(rawConfig);
  return {
    profileId: config.profileId,
    version: config.version,
    status: config.status,
    versionLabel: `${config.profileId}@${config.version}(${config.status})`,
    parse: (content) => parseJson(config, content),
  };
}

export function createFormatProfileRegistry(
  profiles: readonly FormatProfile[],
): FormatProfileRegistry {
  const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
  return { get: (profileId) => byId.get(profileId) };
}

/** 仮決めの FormatProfile（ロボットデータ・環境センサーデータ。どちらも JSON）。確定仕様の提供後に追加・差し替える。 */
export function createDefaultFormatProfileRegistry(): FormatProfileRegistry {
  return createFormatProfileRegistry([
    createDeclarativeProfile(robotJsonConfig),
    createDeclarativeProfile(environmentSensorJsonConfig),
  ]);
}
