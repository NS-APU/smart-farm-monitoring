/**
 * ファイル形式のポート（FormatProfile。ADR-0003、architecture.md 5.1・5.2）。
 * 「どう読むか」を担う。ファイルのレイアウトと項目名の対応づけ（マッピング）を持ち、
 * 版と状態（仮決め／確定）を持つ。取り込んだ観測値には、解釈に使った版を残す（FR-1.11）。
 * 確定仕様の提供後は、新しい FormatProfile を追加して差し替える（FR-1.12）。
 */

import { namedErrorClass } from '../named-error.ts';

export type FormatProfileStatus = 'PROVISIONAL' | 'CONFIRMED';

/**
 * ファイルの記録（その時点のスナップショット 1 つ）。値は検証前（型・範囲は取り込みの検証で確認する）。
 * ファイルの中に、設備の識別子は持たない（設備は、ファイルのパスで決める。設備ごとに 1 ファイル）。
 */
export interface ParsedRecord {
  /** 計測日時（検証前の文字列）。 */
  readonly observedAt: string;
  /** 項目の識別子（itemKey）→ 値。値がない場合は null。 */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ParsedFile {
  /** 読み取れた記録。計測日時が読み取れなければ、なし。 */
  readonly record: ParsedRecord | undefined;
  /** 読み取れなかった記録の数（0 または 1。計測日時がない・読めない。FR-1.6）。 */
  readonly rejectedCount: number;
}

/** ファイル全体が仕様と異なり、読み取れない（形式違い）。 */
export class FormatError extends namedErrorClass('FormatError') {}

export interface FormatProfile {
  readonly profileId: string;
  readonly version: string;
  readonly status: FormatProfileStatus;
  /** 解釈に使った版の表記（観測値に残す。例: `robot-json@0.2.0(PROVISIONAL)`）。 */
  readonly versionLabel: string;
  /** ファイルの内容を読む。読み取れない場合は FormatError を投げる。 */
  parse(content: string): ParsedFile;
}

/** 取り込み元の profileId から FormatProfile を引く。 */
export interface FormatProfileRegistry {
  get(profileId: string): FormatProfile | undefined;
}
