/**
 * 観測値と DynamoDB のアイテムの変換（ADR-0007）。変換は、ここだけで行う（属性名を短くしているため）。
 *
 * 属性: `v` 値、`q` 品質、`r` 受信日時（エポックミリ秒）、`d` 論理削除（ある場合だけ）、`f` 取り込み元ファイル、
 * `fv` FormatProfile の版、`e` 入力者、`n` メモ、`m` 手動入力の ID、`ot` 計測日時の元の文字列（正規化した形と違うときだけ）、
 * `c` カテゴリ（項目カタログから導けないときだけ）。手動入力だけ、疎な GSI のキー `g2`・`g2s` を持つ。
 */

import { findItemDefinition, type Category } from '@smart-farm/shared/constants/items';
import type { ObservationSource } from '@smart-farm/shared/constants/status';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { instantKey } from './keys.ts';
import type { Item } from './operations.ts';

const SOURCE_CODES: Readonly<Record<ObservationSource, string>> = {
  AUTO_IMPORT: 'A',
  MANUAL: 'M',
};
const SOURCES_BY_CODE: Readonly<Record<string, ObservationSource>> = {
  A: 'AUTO_IMPORT',
  M: 'MANUAL',
};

export function observationPartitionKey(equipmentId: string, itemKey: string): string {
  return `${equipmentId}#${itemKey}`;
}

/** 日時を、ミリ秒つきの UTC に正規化する。日時として解釈できなければ undefined。 */
export function normalizedInstant(iso: string): string | undefined {
  return Number.isNaN(Date.parse(iso)) ? undefined : instantKey(iso);
}

export function observationSortKey(instant: string, source: ObservationSource): string {
  return `${instant}#${SOURCE_CODES[source]}`;
}

/** 手動入力の GSI のソートキー（`g2s`）。 */
export function manualIndexSortKey(instant: string, itemKey: string): string {
  return `${instant}#${itemKey}`;
}

function requireInstant(iso: string, what: string): string {
  const normalized = normalizedInstant(iso);
  if (normalized === undefined) {
    throw new RangeError(`${what}が日時として解釈できません`);
  }
  return normalized;
}

export function toObservationItem(observation: Observation): Item {
  const instant = requireInstant(observation.observedAt, '計測日時');
  const item: Item = {
    pk: observationPartitionKey(observation.equipmentId, observation.itemKey),
    sk: observationSortKey(instant, observation.source),
    v: observation.value,
    q: observation.quality,
    r: Date.parse(requireInstant(observation.receivedAt, '受信日時')),
    ...(observation.isDeleted ? { d: true } : {}),
    f: observation.sourceFileId,
    fv: observation.formatProfileVersion,
    e: observation.enteredBy,
    n: observation.note,
    m: observation.manualEntryId,
  };
  if (observation.observedAt !== instant) {
    item.ot = observation.observedAt;
  }
  if (findItemDefinition(observation.itemKey)?.category !== observation.category) {
    item.c = observation.category;
  }
  if (observation.source === 'MANUAL') {
    item.g2 = observation.equipmentId;
    item.g2s = manualIndexSortKey(instant, observation.itemKey);
  }
  return item;
}

function optionalString(item: Item, name: string): string | undefined {
  const value = item[name];
  return typeof value === 'string' ? value : undefined;
}

export function fromObservationItem(item: Item): Observation {
  const partition = String(item.pk);
  const separator = partition.indexOf('#');
  const equipmentId = partition.slice(0, separator);
  const itemKey = partition.slice(separator + 1);
  const sortKey = String(item.sk);
  const sourceSeparator = sortKey.lastIndexOf('#');
  const source = SOURCES_BY_CODE[sortKey.slice(sourceSeparator + 1)];
  const category =
    (optionalString(item, 'c') as Category | undefined) ?? findItemDefinition(itemKey)?.category;
  if (source === undefined || category === undefined) {
    throw new Error('観測値のアイテムの形式が不正です');
  }
  const value = item.v;
  const sourceFileId = optionalString(item, 'f');
  const formatProfileVersion = optionalString(item, 'fv');
  const enteredBy = optionalString(item, 'e');
  const note = optionalString(item, 'n');
  const manualEntryId = optionalString(item, 'm');
  return {
    // 保存時に検証済みの値。1 件ずつスキーマで検証しない（評価で、数万件を読むため）
    equipmentId: equipmentId as EquipmentId,
    category,
    itemKey,
    observedAt: optionalString(item, 'ot') ?? sortKey.slice(0, sourceSeparator),
    value: typeof value === 'number' || typeof value === 'string' ? value : null,
    source,
    quality: item.q as Observation['quality'],
    receivedAt: new Date(Number(item.r)).toISOString(),
    ...(sourceFileId === undefined ? {} : { sourceFileId }),
    ...(formatProfileVersion === undefined ? {} : { formatProfileVersion }),
    ...(enteredBy === undefined ? {} : { enteredBy: enteredBy as Observation['enteredBy'] }),
    ...(note === undefined ? {} : { note }),
    ...(manualEntryId === undefined ? {} : { manualEntryId }),
    isDeleted: item.d === true,
  };
}
