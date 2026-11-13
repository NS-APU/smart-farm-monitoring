/**
 * 農業情報基盤の連携先の設定の保管（ADR-0024。Issue #177）。
 * - 接続先（エンドポイントの URL）: 書き込み専用の秘密情報（SecretPort の `federation/endpoint`）。値は、状態に含めない・ログに出さない
 * - テナント名・context の URL・有効／無効: 設定の保管（SettingsRepository の `federation.settings`）
 * 設定がなければ、既定（テナント `smart_farm_monitoring`・無効）。
 */

import { validationError } from '@smart-farm/shared/errors';
import {
  DEFAULT_FEDERATION_TENANT,
  FederationEndpointInputSchema,
  FederationSettingsSchema,
  parseFederationEndpoint,
  type FederationEndpoint,
  type FederationSettings,
} from '@smart-farm/shared/schemas/federation-connection';
import type { SecretPort, SecretStatus } from '../ports/secret-port.ts';
import type { SettingsRepository } from '../ports/repositories.ts';

export const FEDERATION_ENDPOINT_SECRET_REFERENCE = 'federation/endpoint';
const SETTINGS_KEY = 'federation.settings';

/** context の URL の既定（このリポジトリの context。当面は develop。リリース後に、タグの URL に切り替える）。 */
export const DEFAULT_FEDERATION_CONTEXT_URL =
  'https://raw.githubusercontent.com/NS-APU/smart-farm-monitoring/develop/docs/10_design/data/ngsi-ld-context.jsonld';

const DEFAULT_SETTINGS: FederationSettings = {
  tenant: DEFAULT_FEDERATION_TENANT,
  contextUrl: DEFAULT_FEDERATION_CONTEXT_URL,
  enabled: false,
};

/** 連携に使う接続（接続先と設定がそろったもの）。 */
export interface FederationConnection extends FederationSettings {
  readonly endpoint: FederationEndpoint;
}

export interface FederationConnectionDescription {
  readonly settings: FederationSettings;
  /** 接続先の状態（値は、含めない）。 */
  readonly endpoint: SecretStatus;
}

export interface FederationConnectionStore {
  /** 連携に使う接続。接続先が未設定・読めないときは、undefined（無効のときも、接続は返す）。 */
  get(): Promise<FederationConnection | undefined>;
  /** 画面に示す内容（設定と、接続先の状態。接続先の値は、含めない）。 */
  describe(): Promise<FederationConnectionDescription>;
  saveSettings(settings: FederationSettings): Promise<void>;
  /** 接続先を保存する（書き込み専用）。正しくなければ、検証エラー（値は、メッセージに含めない）。 */
  saveEndpoint(url: string): Promise<void>;
}

export function createFederationConnectionStore(deps: {
  readonly settings: SettingsRepository;
  readonly secrets: SecretPort;
}): FederationConnectionStore {
  const { settings, secrets } = deps;

  async function readSettings(): Promise<FederationSettings> {
    const parsed = FederationSettingsSchema.safeParse(await settings.get(SETTINGS_KEY));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  return {
    async get() {
      const value = await secrets.get(FEDERATION_ENDPOINT_SECRET_REFERENCE);
      const endpoint = value === undefined ? undefined : parseFederationEndpoint(value);
      return endpoint === undefined ? undefined : { ...(await readSettings()), endpoint };
    },

    async describe() {
      const [current, endpoint] = await Promise.all([
        readSettings(),
        secrets.status(FEDERATION_ENDPOINT_SECRET_REFERENCE),
      ]);
      return { settings: current, endpoint };
    },

    async saveSettings(input) {
      const parsed = FederationSettingsSchema.safeParse(input);
      if (!parsed.success) {
        throw validationError(
          parsed.error.issues.map((issue) => ({
            name: String(issue.path[0] ?? 'settings'),
            message: issue.message,
          })),
        );
      }
      await settings.set(SETTINGS_KEY, parsed.data);
    },

    async saveEndpoint(url) {
      const parsed = FederationEndpointInputSchema.safeParse(url);
      const endpoint = parsed.success ? parseFederationEndpoint(parsed.data) : undefined;
      if (!parsed.success || endpoint === undefined) {
        throw validationError([
          {
            name: 'endpoint',
            message: parsed.success
              ? '接続先を指定してください'
              : (parsed.error.issues[0]?.message ?? ''),
          },
        ]);
      }
      // 保管するのは、検証済みの URL（末尾の / を取り除いた形）
      await secrets.set(FEDERATION_ENDPOINT_SECRET_REFERENCE, normalizedUrl(parsed.data));
    },
  };
}

/** 末尾の `/` を取り除いた URL。 */
function normalizedUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
