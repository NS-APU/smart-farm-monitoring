/**
 * 設備のダイアログ（SC-10）の「取り込み元の接続」の状態と操作（Issue #367。ADR-0026）。入力欄の値・検証・保存済みの接続（サーバーの状態）・
 * 認証情報の登録・設備だけの接続テスト・コピー・解除。設備の保存（親のフォーム）と、接続の保存を、親が順に呼ぶ（設備 → 接続）。
 * 認証情報の値は、このフックで保持せず、登録のときに受け取って送るだけにする（書き込み専用）。
 */

import { useState } from 'react';
import type {
  EquipmentIngestionStatus,
  FileServerConnection,
  IngestionCredentialStatus,
  IngestionCredentialsInput,
} from '@smart-farm/shared/schemas/ingestion';
import {
  deleteEquipmentConnection,
  saveEquipmentConnection,
  saveEquipmentCredentials,
  testEquipmentConnection,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import {
  draftOfConnection,
  isSameConnection,
  parseConnectionDraft,
  withoutConnectionPrefix,
  type ConnectionDraft,
  type CopyCandidate,
} from './equipment-connection.ts';

const TEXT = MESSAGES.equipment.connection;

/** サーバーに保存されている、設備の接続の状態。 */
export interface ConnectionServerState {
  /** 設備の接続。未設定なら、undefined。 */
  readonly connection: FileServerConnection | undefined;
  readonly credentials: IngestionCredentialStatus;
}

/** 接続がまだない設備（新規の登録・取り込み元に載っていない設備）の状態。 */
export const NO_CONNECTION_STATE: ConnectionServerState = {
  connection: undefined,
  credentials: { state: 'NOT_REQUIRED' },
};

export function serverStateOf(
  status: Pick<EquipmentIngestionStatus, 'connection' | 'credentials'>,
): ConnectionServerState {
  return {
    connection: status.connection,
    credentials: status.credentials,
  };
}

/** 操作（認証情報の登録・接続テスト・解除）の結果の表示。 */
export interface ConnectionNotice {
  readonly ok: boolean;
  readonly text: string;
}

export type PrepareResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly connection: FileServerConnection | undefined };

export interface EquipmentConnectionController {
  /** 保存済みの状態を読み込んだ（入力欄を使える）。 */
  readonly ready: boolean;
  readonly server: ConnectionServerState;
  readonly draft: ConnectionDraft;
  readonly setDraft: (patch: Partial<ConnectionDraft>) => void;
  /** 保存していない変更がある。 */
  readonly dirty: boolean;
  /** 項目ごとのエラー（入力の検証・サーバーの応答。キーは host・port など）。 */
  readonly errors: Readonly<Record<string, string>>;
  /** 接続の保存の失敗など、画面全体のエラーのメッセージ。 */
  readonly formMessage: string | undefined;
  readonly notice: ConnectionNotice | undefined;
  readonly copiedFrom: string | undefined;
  readonly busy: boolean;
  /** 入力を検証する。保存が必要な接続があれば、その接続を返す（なければ undefined）。エラーは、項目に表示する。 */
  readonly prepare: () => PrepareResult;
  /** 接続を保存する（設備の保存のあと）。成功したら true。失敗は、formMessage・errors に残す。 */
  readonly commit: (equipmentId: string, connection: FileServerConnection) => Promise<boolean>;
  readonly copyFrom: (candidate: CopyCandidate) => void;
  readonly saveCredentials: (
    equipmentId: string,
    input: IngestionCredentialsInput,
  ) => Promise<boolean>;
  readonly test: (equipmentId: string) => Promise<void>;
  readonly remove: (equipmentId: string) => Promise<boolean>;
  readonly clearError: () => void;
}

/**
 * @param initial 保存済みの状態。まだ読み込めていないときは undefined（読み込めたら、入力欄に反映する）
 * @param onChanged 接続・認証情報を変更したあとに、画面の表示を更新する
 */
export function useEquipmentConnection(
  initial: ConnectionServerState | undefined,
  onChanged: () => void,
): EquipmentConnectionController {
  const { api } = useAuth();
  const submit = useSubmit();
  const [seeded, setSeeded] = useState(initial !== undefined);
  const [server, setServer] = useState<ConnectionServerState>(initial ?? NO_CONNECTION_STATE);
  const [draft, setDraftState] = useState<ConnectionDraft>(draftOfConnection(initial?.connection));
  const [copiedFrom, setCopiedFrom] = useState<string | undefined>(undefined);
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<ConnectionNotice | undefined>(undefined);

  // 保存済みの状態が、あとから読み込めたときに、入力欄へ反映する（描画中の状態の調整）
  if (!seeded && initial !== undefined) {
    setSeeded(true);
    setServer(initial);
    setDraftState(draftOfConnection(initial.connection));
  }

  // 接続があるときは、その接続の値を基準にする。未設定のときは、空の入力が基準
  const baseline = draftOfConnection(server.connection);
  const dirty =
    draft.protocol !== baseline.protocol ||
    draft.host !== baseline.host ||
    draft.port !== baseline.port ||
    draft.authMethod !== baseline.authMethod ||
    draft.apiKeyHeaderName !== baseline.apiKeyHeaderName;

  function setDraft(patch: Partial<ConnectionDraft>): void {
    setDraftState((current) => ({ ...current, ...patch }));
    setClientErrors({});
    setNotice(undefined);
  }

  function prepare(): PrepareResult {
    if (!seeded || !dirty) {
      setClientErrors({});
      return { ok: true, connection: undefined };
    }
    const parsed = parseConnectionDraft(draft);
    if (!parsed.ok) {
      setClientErrors(parsed.errors);
      return { ok: false };
    }
    setClientErrors({});
    // 保存済みの接続を変えていないとき（空白・大文字小文字の違いだけ）は、送らない
    if (isSameConnection(parsed.connection, server.connection)) {
      return { ok: true, connection: undefined };
    }
    return { ok: true, connection: parsed.connection };
  }

  async function commit(equipmentId: string, connection: FileServerConnection): Promise<boolean> {
    setNotice(undefined);
    const result = await submit.run(() => saveEquipmentConnection(api, equipmentId, connection));
    if (!result.ok) {
      return false;
    }
    const saved = result.value;
    setServer({
      connection: saved.connection ?? connection,
      credentials: saved.credentials,
    });
    setDraftState(draftOfConnection(saved.connection ?? connection));
    setCopiedFrom(undefined);
    onChanged();
    return true;
  }

  function copyFrom(candidate: CopyCandidate): void {
    // 接続の項目だけを写す（認証情報は、写さない）
    setDraftState(draftOfConnection(candidate.connection));
    setCopiedFrom(candidate.name);
    setClientErrors({});
    setNotice(undefined);
  }

  async function saveCredentials(
    equipmentId: string,
    input: IngestionCredentialsInput,
  ): Promise<boolean> {
    setNotice(undefined);
    const result = await submit.run(() => saveEquipmentCredentials(api, equipmentId, input));
    if (!result.ok) {
      return false;
    }
    setServer((current) => ({ ...current, credentials: result.value }));
    setNotice({ ok: true, text: TEXT.credentialsSaved });
    onChanged();
    return true;
  }

  async function test(equipmentId: string): Promise<void> {
    setNotice(undefined);
    const tested = await submit.run(() => testEquipmentConnection(api, equipmentId));
    if (tested.ok) {
      setNotice({ ok: tested.value.ok, text: tested.value.message });
    }
  }

  async function remove(equipmentId: string): Promise<boolean> {
    setNotice(undefined);
    const result = await submit.run(() => deleteEquipmentConnection(api, equipmentId));
    if (!result.ok) {
      return false;
    }
    const cleared = result.value;
    setServer({
      connection: cleared.connection,
      credentials: cleared.credentials,
    });
    setDraftState(draftOfConnection(cleared.connection));
    setCopiedFrom(undefined);
    setClientErrors({});
    setNotice({ ok: true, text: TEXT.removed });
    onChanged();
    return true;
  }

  return {
    ready: seeded,
    server,
    draft,
    setDraft,
    dirty,
    errors: { ...clientErrors, ...withoutConnectionPrefix(submit.fieldErrors) },
    formMessage: submit.formMessage,
    notice,
    copiedFrom,
    busy: submit.busy,
    prepare,
    commit,
    copyFrom,
    saveCredentials,
    test,
    remove,
    clearError: submit.clearError,
  };
}
