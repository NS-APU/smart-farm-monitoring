/**
 * 接続方式で振り分けるファイルソース（Issue #172。ADR-0022）。
 * 取り込み元の接続設定（connection）が MOCK のときは、これまでのファイルソース（モック・S3）へ渡す。
 * HTTP のときは、秘密情報（SecretPort）から認証のヘッダーを組み立て、接続テストをする。
 * HTTP のファイルの一覧・取得は、Issue #119 で実装する（それまでは、NOT_IMPLEMENTED の失敗）。
 */

import type { HttpFileServerConnection } from '@smart-farm/shared/schemas/ingestion';
import { FileSourceFailure, type FileSourcePort } from '../ports/file-source-port.ts';
import type { SecretPort } from '../ports/secret-port.ts';
import { buildAuthHeaders, fileServerSecretReference } from './file-server-credentials.ts';
import type { IngestionSettings } from './ingestion-settings.ts';

/** HTTP の接続テスト（インフラの実装を、差し込む）。失敗は、FileSourceFailure。 */
export type HttpFileProbe = (input: {
  readonly connection: HttpFileServerConnection;
  readonly headers: Readonly<Record<string, string>>;
}) => Promise<void>;

export interface RoutingFileSourceDeps {
  /** 接続方式が MOCK の取り込み元、および、設定にない取り込み元の、ファイルソース。 */
  readonly base: FileSourcePort;
  readonly ingestionSettings: Pick<IngestionSettings, 'listSources'>;
  readonly secrets: SecretPort;
  readonly probe: HttpFileProbe;
}

export function createRoutingFileSource(deps: RoutingFileSourceDeps): FileSourcePort {
  const { base, ingestionSettings, secrets, probe } = deps;

  async function httpConnectionOf(sourceId: string): Promise<HttpFileServerConnection | undefined> {
    const sources = await ingestionSettings.listSources();
    const connection = sources.find((source) => source.sourceId === sourceId)?.connection;
    return connection?.type === 'HTTP' ? connection : undefined;
  }

  /** 認証情報を読む。保管先の障害は、理由だけを伝える（内部の情報を、利用者に見せない）。 */
  async function readSecret(sourceId: string, refresh: boolean): Promise<string | undefined> {
    try {
      return await secrets.get(
        fileServerSecretReference(sourceId),
        refresh ? { refresh } : undefined,
      );
    } catch (cause) {
      throw new FileSourceFailure('CREDENTIALS_UNAVAILABLE', { cause });
    }
  }

  async function testHttp(sourceId: string, connection: HttpFileServerConnection): Promise<void> {
    if (connection.authMethod === 'NONE') {
      await probe({ connection, headers: {} });
      return;
    }
    const value = await readSecret(sourceId, false);
    try {
      await probe({ connection, headers: buildAuthHeaders(connection, value) });
    } catch (error) {
      if (!(error instanceof FileSourceFailure) || error.reason !== 'AUTH_FAILED') {
        throw error;
      }
      // 認証に失敗したときは、キャッシュを使わずに取り直し、値が変わっていれば、1 度だけ再試行する
      // （認証情報の更新が、キャッシュの期間（5 分）の間に、反映されないのを避ける）
      const fresh = await readSecret(sourceId, true);
      if (fresh === value) {
        throw error;
      }
      await probe({ connection, headers: buildAuthHeaders(connection, fresh) });
    }
  }

  return {
    async testConnection(sourceId) {
      const connection = await httpConnectionOf(sourceId);
      if (connection === undefined) {
        return base.testConnection(sourceId);
      }
      return testHttp(sourceId, connection);
    },

    async listFiles(sourceId) {
      if ((await httpConnectionOf(sourceId)) === undefined) {
        return base.listFiles(sourceId);
      }
      throw new FileSourceFailure('NOT_IMPLEMENTED');
    },

    async readFile(sourceId, fileId) {
      if ((await httpConnectionOf(sourceId)) === undefined) {
        return base.readFile(sourceId, fileId);
      }
      throw new FileSourceFailure('NOT_IMPLEMENTED');
    },
  };
}
