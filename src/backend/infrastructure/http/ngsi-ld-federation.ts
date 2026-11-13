/**
 * 農業情報基盤への連携のアダプタ（FederationPort。NGSI-LD の upsert。ADR-0024。Issue #177）。
 * 連携キューの項目を、NGSI-LD のエンティティに変換し（domain/ngsi-ld-mapping.ts）、
 * `POST {接続先}/entityOperations/upsert?options=update` で送る（送った属性だけを更新し、ほかの属性を消さない）。
 * 認証は、設けない（ADR-0024）。接続先・テナント・context の URL は、設定（federation-connection-store.ts）から読む。
 *
 * 結果の対応:
 * - 2xx（207 は、本文のエラーが空のとき） → 成功
 * - 接続できない・時間切れ・408・429・5xx → FederationUnavailableError（保留。あとで再試行する）
 * - 連携先が未設定・無効 → FederationUnavailableError（積んだ項目は、期限の判定のため、保留として扱う）
 * - そのほかの状態コード・207 のエラー・内部のアドレス・証明書・暗号化の失敗 → FederationRejectedError（失敗）
 * 失敗のメッセージに、接続先・応答の本文・データを含めない。
 */

import {
  fragmentsOfItem,
  requestsOf,
  type EquipmentTypeLookup,
} from '../../domain/ngsi-ld-mapping.ts';
import type { FederationConnection } from '../../application/federation/federation-connection-store.ts';
import {
  FederationRejectedError,
  FederationUnavailableError,
  type FederationPort,
} from '../../application/ports/federation-port.ts';
import type { EquipmentRepository } from '../../application/ports/repositories.ts';
import { NgsiLdTransportError, type NgsiLdTransport } from './ngsi-ld-http-transport.ts';

/** 1 回の要求に含めるエンティティの上限。 */
export const MAX_ENTITIES_PER_REQUEST = 100;

export interface NgsiLdFederationDeps {
  /** 連携に使う接続（接続先が未設定のときは、undefined）。 */
  readonly connection: () => Promise<FederationConnection | undefined>;
  readonly transport: NgsiLdTransport;
  /** 設備の種別を引く（refDevice・refEquipment のため）。 */
  readonly equipment: Pick<EquipmentRepository, 'list'>;
  readonly timeoutMs?: number;
}

const NOT_CONFIGURED_MESSAGE = '農業情報基盤への連携が設定されていません';
const UNAVAILABLE_MESSAGE = '農業情報基盤が利用できません';

function rejected(status?: number): FederationRejectedError {
  return new FederationRejectedError(
    status === undefined
      ? '農業情報基盤がデータを受け付けませんでした'
      : `農業情報基盤がデータを受け付けませんでした（HTTP ${String(status)}）`,
  );
}

/** 207（一部の失敗を含みうる）の本文に、エラーがあるか。読めない本文は、エラーとみなさない（2xx のため）。 */
function hasPartialErrors(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('errors' in parsed)) {
      return false;
    }
    return Array.isArray(parsed.errors) && parsed.errors.length > 0;
  } catch {
    return false;
  }
}

/** 連携の Link ヘッダー（context）。 */
function linkHeaderOf(contextUrl: string): string {
  return `<${contextUrl}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
}

export interface NgsiLdProbeResult {
  readonly ok: boolean;
  /** 利用者に示す文言（接続先・応答の本文を含めない）。 */
  readonly message: string;
}

/**
 * 接続の確認（SC-11）: テナント・context つきで、読み取りだけ（`GET /entities?type=Greenhouse&limit=1`）を送る。書き込みはしない。
 * 結果は、成功か、理由だけ（状態コード・固定の文言）。接続先・応答の本文は、含めない。
 */
export async function probeNgsiLd(
  connection: FederationConnection,
  transport: NgsiLdTransport,
  timeoutMs?: number,
): Promise<NgsiLdProbeResult> {
  const { endpoint } = connection;
  try {
    const response = await transport({
      protocol: endpoint.protocol,
      host: endpoint.host,
      ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
      method: 'GET',
      path: `${endpoint.basePath}/entities?type=Greenhouse&limit=1`,
      headers: { 'NGSILD-Tenant': connection.tenant, Link: linkHeaderOf(connection.contextUrl) },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return response.status >= 200 && response.status < 300
      ? { ok: true, message: '農業情報基盤に接続できました（読み取りだけを確認しました）' }
      : {
          ok: false,
          message: `農業情報基盤は応答しましたが、確認の要求が成功しませんでした（HTTP ${String(response.status)}）`,
        };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof NgsiLdTransportError
          ? error.message
          : '農業情報基盤に接続できませんでした',
    };
  }
}

export function createNgsiLdFederation(deps: NgsiLdFederationDeps): FederationPort {
  const { connection: readConnection, transport, equipment, timeoutMs } = deps;

  async function equipmentTypeLookup(): Promise<EquipmentTypeLookup> {
    const types = new Map(
      (await equipment.list({ includeDeleted: true })).map((item) => [
        item.equipmentId as string,
        item.equipmentType,
      ]),
    );
    return (equipmentId) => types.get(equipmentId);
  }

  return {
    async send(items) {
      const connection = await readConnection();
      if (connection?.enabled !== true) {
        throw new FederationUnavailableError(NOT_CONFIGURED_MESSAGE);
      }
      const typeOf = await equipmentTypeLookup();
      const requests = requestsOf(
        items.flatMap((item) => fragmentsOfItem(item, typeOf)),
        MAX_ENTITIES_PER_REQUEST,
      );
      const { endpoint } = connection;
      const headers = {
        'Content-Type': 'application/json',
        'NGSILD-Tenant': connection.tenant,
        Link: linkHeaderOf(connection.contextUrl),
      };
      for (const entities of requests) {
        let response;
        try {
          response = await transport({
            protocol: endpoint.protocol,
            host: endpoint.host,
            ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
            path: `${endpoint.basePath}/entityOperations/upsert?options=update`,
            headers,
            body: JSON.stringify(entities),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
        } catch (error) {
          if (
            error instanceof NgsiLdTransportError &&
            (error.reason === 'UNREACHABLE' || error.reason === 'TIMEOUT')
          ) {
            throw new FederationUnavailableError(error.message);
          }
          throw new FederationRejectedError(
            error instanceof NgsiLdTransportError
              ? error.message
              : '農業情報基盤への送信に失敗しました',
          );
        }
        const { status } = response;
        if (status === 408 || status === 429 || status >= 500) {
          throw new FederationUnavailableError(UNAVAILABLE_MESSAGE);
        }
        if (status < 200 || status >= 300) {
          throw rejected(status);
        }
        if (status === 207 && hasPartialErrors(response.body)) {
          throw rejected(status);
        }
      }
    },
  };
}
