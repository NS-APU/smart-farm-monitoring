/**
 * ファイル形式のポート（FormatProfile。ADR-0003、architecture.md 5.1・5.2）。
 * 「どう読むか」を担う。ファイルのレイアウトと項目名の対応づけ（マッピング）を持ち、
 * 版と状態（仮決め／確定）を持つ。取り込んだ観測値には、解釈に使った版を残す（FR-1.11）。
 * 確定仕様の提供後は、新しい FormatProfile を追加して差し替える（FR-1.12）。
 */

import { namedErrorClass } from '../named-error.ts';

export type FormatProfileStatus = 'PROVISIONAL' | 'CONFIRMED';

/** ファイルの1件の記録。値は検証前（型・範囲は取り込みの検証で確認する）。 */
export interface ParsedRecord {
  /** ファイルの中の設備の識別子（機体ID・センサーID）。設備の externalId に対応する。 */
  readonly externalId: string;
  /** 計測日時（検証前の文字列）。 */
  readonly observedAt: string;
  /** 項目の識別子（itemKey）→ 値。値がない場合は null。 */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ParsedFile {
  readonly records: readonly ParsedRecord[];
  /** 構造として読み取れなかった行・記録の数（形式違い。FR-1.6）。 */
  readonly rejectedCount: number;
}

/** ファイル全体が仕様と異なり、読み取れない（形式違い）。 */
export class FormatError extends namedErrorClass('FormatError') {}

export interface FormatProfile {
  readonly profileId: string;
  readonly version: string;
  readonly status: FormatProfileStatus;
  /** 解釈に使った版の表記（観測値に残す。例: `robot-json@0.1.0(PROVISIONAL)`）。 */
  readonly versionLabel: string;
  /** ファイルの内容を読む。読み取れない場合は FormatError を投げる。 */
  parse(content: string): ParsedFile;
}

/** 取り込み元の profileId から FormatProfile を引く。 */
export interface FormatProfileRegistry {
  get(profileId: string): FormatProfile | undefined;
}
