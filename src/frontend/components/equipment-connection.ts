/**
 * 設備ごとのファイルサーバーの接続（Issue #367。ADR-0026）の入力の、純粋な処理: 入力（文字列）と接続（FileServerConnection）の変換・検証・比較、
 * 同じ種別の設備からのコピー、SC-11 の停止中の判定。設備のダイアログ（SC-10）と取り込み設定・状況（SC-11）が使う。
 */

import type { EquipmentType } from '@smart-farm/shared/constants/status';
import {
  DEFAULT_API_KEY_HEADER_NAME,
  FileServerConnectionSchema,
  type EquipmentIngestionStatus,
  type FileServerAuthMethod,
  type FileServerConnection,
  type FileServerProtocol,
  type IngestionSourceStatus,
} from '@smart-farm/shared/schemas/ingestion';
import { fieldErrorsOfZod } from './zod-errors.ts';

/** 接続の入力欄の値（すべて文字列・選択。保存前の状態）。 */
export interface ConnectionDraft {
  readonly protocol: FileServerProtocol;
  readonly host: string;
  readonly port: string;
  readonly authMethod: FileServerAuthMethod;
  readonly apiKeyHeaderName: string;
}

/** 何も入力していない状態（接続が未設定の設備の、入力の初期値）。 */
export const EMPTY_CONNECTION_DRAFT: ConnectionDraft = {
  protocol: 'HTTPS',
  host: '',
  port: '',
  authMethod: 'NONE',
  apiKeyHeaderName: DEFAULT_API_KEY_HEADER_NAME,
};

/** 接続（なければ undefined）を、入力欄の値にする。 */
export function draftOfConnection(connection: FileServerConnection | undefined): ConnectionDraft {
  if (connection === undefined) {
    return EMPTY_CONNECTION_DRAFT;
  }
  return {
    protocol: connection.protocol,
    host: connection.host,
    port: connection.port === undefined ? '' : String(connection.port),
    authMethod: connection.authMethod,
    apiKeyHeaderName: connection.apiKeyHeaderName,
  };
}

/** 接続の内容が同じか（保存済みの接続を変えていないときは、送らない）。 */
export function isSameConnection(
  a: FileServerConnection,
  b: FileServerConnection | undefined,
): boolean {
  return (
    a.protocol === b?.protocol &&
    a.host === b.host &&
    a.port === b.port &&
    a.authMethod === b.authMethod &&
    a.apiKeyHeaderName === b.apiKeyHeaderName
  );
}

/** ポートの入力が、数字でない（空は、省略として、有効）。 */
function portIsInvalid(port: string): boolean {
  return port.trim() !== '' && !/^[0-9]+$/.test(port.trim());
}

export type DraftParseResult =
  | { readonly ok: true; readonly connection: FileServerConnection }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** 入力欄の値を、共有のスキーマで検証する。項目ごとのエラーは、`host`・`port`・`protocol`・`authMethod`・`apiKeyHeaderName` をキーにする。 */
export function parseConnectionDraft(draft: ConnectionDraft): DraftParseResult {
  const portText = draft.port.trim();
  const parsed = FileServerConnectionSchema.safeParse({
    type: 'HTTP',
    protocol: draft.protocol,
    host: draft.host,
    ...(portText === '' ? {} : { port: portIsInvalid(portText) ? Number.NaN : Number(portText) }),
    authMethod: draft.authMethod,
    apiKeyHeaderName: draft.apiKeyHeaderName,
  });
  if (parsed.success) {
    return { ok: true, connection: parsed.data };
  }
  return { ok: false, errors: fieldErrorsOfZod(parsed.error) };
}

/** サーバーが返した項目のエラー（`connection.host` など）を、入力欄のキー（`host`）にそろえる。 */
export function withoutConnectionPrefix(
  errors: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([name, message]) => [name.replace(/^connection\./, ''), message]),
  );
}

/** コピーできる設備（同じ種別で、設備ごとの接続を持つ。自分自身を除く）。 */
export interface CopyCandidate {
  readonly equipmentId: string;
  readonly name: string;
  readonly connection: FileServerConnection;
}

/**
 * 同じ種別（ロボット／センサー）で、設備ごとの接続（出どころが EQUIPMENT）を持つ設備の一覧。
 * 取り込み元（種別 `kind`）ごとの設備から選ぶ。共通の接続（SHARED）の設備は、含めない。
 */
export function copyCandidatesOf(
  sources: readonly IngestionSourceStatus[],
  equipmentType: EquipmentType,
  excludeEquipmentId: string | undefined,
): readonly CopyCandidate[] {
  return sources
    .filter((source) => source.kind === equipmentType)
    .flatMap((source) => source.equipment)
    .flatMap((item) =>
      item.connectionOrigin === 'EQUIPMENT' &&
      item.connection !== undefined &&
      item.equipmentId !== excludeEquipmentId
        ? [{ equipmentId: item.equipmentId, name: item.name, connection: item.connection }]
        : [],
    );
}

/** 取り込み設定・状況の応答から、設備 1 件の状況を探す。 */
export function findEquipmentStatus(
  sources: readonly IngestionSourceStatus[],
  equipmentId: string,
): EquipmentIngestionStatus | undefined {
  return sources
    .flatMap((source) => source.equipment)
    .find((item) => item.equipmentId === equipmentId);
}

export interface StoppedJudgement {
  readonly stopped: boolean;
  /** 停止中の基準（分）。判定の対象でなければ undefined。 */
  readonly thresholdMinutes: number | undefined;
}

/**
 * 設備の取り込みが「停止中」か（ダッシュボードの「データが古い」と同じ基準。ADR-0016 の D-12）。最後にデータが取れた日時（`lastDataAt`）から、
 * サーバーが返す設備ごとの基準（`staleThresholdMinutes`。取得間隔 × 倍数、最低 3 分）を超えていれば、停止中。
 * 基準が来ない設備・自動取り込みが無効な取り込み元・ファイルのパスを持たない設備・まだ 1 件もデータのない設備は、判定しない。
 */
export function judgeStopped(params: {
  readonly isEnabled: boolean;
  readonly sourceFilePath: string | undefined;
  readonly staleThresholdMinutes: number | undefined;
  readonly lastDataAt: string | null;
  readonly now: Date;
}): StoppedJudgement {
  const thresholdMinutes = params.staleThresholdMinutes;
  if (
    !params.isEnabled ||
    params.sourceFilePath === undefined ||
    params.lastDataAt === null ||
    thresholdMinutes === undefined
  ) {
    return { stopped: false, thresholdMinutes: undefined };
  }
  const elapsedMs = params.now.getTime() - new Date(params.lastDataAt).getTime();
  return { stopped: elapsedMs > thresholdMinutes * 60_000, thresholdMinutes };
}
