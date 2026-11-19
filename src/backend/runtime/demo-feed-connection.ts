/**
 * デモの取り込みを、デモ用の HTTP 配信（Issue #344。ADR-0025）に向ける（`pnpm demo-data use-http-feed`・`seed --url`）。
 * - 接続先の URL（HTTP 配信の Function URL。SfmEvaluation の出力 `DemoFeedUrl`）を、デモの設備（ロボット・環境センサー）ごとの
 *   接続（Issue #367。ADR-0026。HTTP。認証なし）にする
 * - デモの設備（ロボット・環境センサー）に、取得するファイルのパス（`sourceFilePath`）を設定する（すでにあれば、そのまま）
 * 何度実行しても、同じ結果になる。接続先は、リポジトリに書かない（運用者が、環境変数・引数で渡す）。
 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { FileServerConnectionSchema } from '@smart-farm/shared/schemas/ingestion';
import type { HttpFileServerConnection } from '@smart-farm/shared/schemas/ingestion';
import { DEMO_FEED_FILE_PATHS } from '../application/demo/demo-feed-schedule.ts';
import { DEMO_ROBOT_ID, DEMO_SENSOR_ID } from '../infrastructure/local/synthetic-data.ts';
import { ConfigError } from './config.ts';
import type { Container } from './container.ts';

const URL_MESSAGE =
  '接続先の URL が正しくありません（例: https://<ホスト名>/ 。パス・クエリ・認証情報は、指定できません）';

/** デモの設備と、取得するファイルのパス（取り込み元ごと）。 */
const DEMO_FILE_EQUIPMENT = [
  { equipmentId: DEMO_ROBOT_ID, path: DEMO_FEED_FILE_PATHS.robot },
  { equipmentId: DEMO_SENSOR_ID, path: DEMO_FEED_FILE_PATHS['environment-sensor'] },
] as const;

/** 接続先の URL（スキーム・ホスト・ポートだけ）を、接続設定（HTTP。認証なし）にする。 */
export function parseDemoFeedUrl(text: string): HttpFileServerConnection {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new ConfigError(URL_MESSAGE);
  }
  const hasExtra =
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '';
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || hasExtra) {
    throw new ConfigError(URL_MESSAGE);
  }
  const parsed = FileServerConnectionSchema.safeParse({
    type: 'HTTP',
    protocol: url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    authMethod: 'NONE',
  });
  if (!parsed.success) {
    throw new ConfigError(URL_MESSAGE);
  }
  return parsed.data;
}

export interface DemoFeedApplied {
  /** 設備ごとの接続を設定した設備の数。 */
  readonly connections: number;
  /** ファイルのパスを設定した設備の数（すでに設定のある設備は、数えない）。 */
  readonly equipment: number;
}

/** デモの取り込みを、HTTP 配信に向ける。デモの設備がなければ、先に seed を実行するよう、エラーにする（何も変えない）。 */
export async function applyDemoFeed(
  container: Pick<Container, 'repositories' | 'equipmentConnections'>,
  connection: HttpFileServerConnection,
): Promise<DemoFeedApplied> {
  const found: { equipment: Equipment; path: string }[] = [];
  for (const { equipmentId, path } of DEMO_FILE_EQUIPMENT) {
    const equipment = await container.repositories.equipment.get(equipmentId);
    if (equipment === undefined) {
      throw new ConfigError(
        `デモの設備（${DEMO_FILE_EQUIPMENT.map((item) => item.equipmentId).join('・')}）がありません。先に pnpm demo-data seed を実行してください`,
      );
    }
    found.push({ equipment, path });
  }
  let configured = 0;
  for (const { equipment, path } of found) {
    if (equipment.sourceFilePath === undefined) {
      await container.repositories.equipment.save({ ...equipment, sourceFilePath: path });
      configured += 1;
    }
  }
  // 設備ごとの接続（デモの設備。上書きするため、何度実行しても、同じ）
  for (const { equipment } of found) {
    await container.equipmentConnections.save(equipment.equipmentId, { ...connection });
  }
  return { connections: found.length, equipment: configured };
}
