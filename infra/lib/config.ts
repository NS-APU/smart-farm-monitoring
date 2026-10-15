/**
 * IaC の設定（環境変数）。アカウント ID・ドメイン名・ホストゾーン名は、リポジトリに書かず、環境変数で渡す。
 * - AWS のアカウント: CDK が、認証（プロファイル・OIDC のロール）から、CDK_DEFAULT_ACCOUNT に設定する
 * - SFM_DOMAIN_NAME・SFM_HOSTED_ZONE_NAME: 独自のサブドメインを使うときだけ、2 つとも指定する
 */

/** リージョンは、東京に固定する（ユーザーの指示。architecture.md 11.4）。 */
export const REGION = 'ap-northeast-1';
/** CloudFront の証明書は、us-east-1 でしか作れない。 */
export const CERTIFICATE_REGION = 'us-east-1';
export const GITHUB_REPOSITORY = 'NS-APU/smart-farm-monitoring';
/**
 * GitHub の OIDC トークンの `sub` の接頭辞（不変の ID の形式。Issue #87）。
 * このリポジトリは、GitHub の新しい既定（`use_immutable_subject: true`）で、`sub` が、名前ではなく、組織・リポジトリの
 * ID を含む形（`<この接頭辞>:environment:<Environment 名>`）になる。リポジトリの名前変更・移管による、なりすましを防げる。
 * 組織・リポジトリの ID は、公開の情報（秘密ではない）。確認方法:
 *   gh api repos/NS-APU/smart-farm-monitoring/actions/oidc/customization/sub --jq .sub_claim_prefix
 */
export const GITHUB_SUBJECT_PREFIX = 'repo:NS-APU@117165122/smart-farm-monitoring@1408451825';
export const DEPLOY_ENVIRONMENT_NAME = 'evaluation';

export interface InfraConfig {
  /** 認証から決まるアカウント。未設定のときは、アカウントに依存しない（synth のみ）。 */
  readonly account?: string;
  readonly domainName?: string;
  readonly hostedZoneName?: string;
  readonly existingOidcProviderArn?: string;
}

function optional(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): InfraConfig {
  const account = optional(env, 'CDK_DEFAULT_ACCOUNT');
  const domainName = optional(env, 'SFM_DOMAIN_NAME');
  const hostedZoneName = optional(env, 'SFM_HOSTED_ZONE_NAME');
  const existingOidcProviderArn = optional(env, 'SFM_GITHUB_OIDC_PROVIDER_ARN');
  if ((domainName === undefined) !== (hostedZoneName === undefined)) {
    throw new Error(
      'SFM_DOMAIN_NAME と SFM_HOSTED_ZONE_NAME は、2 つとも指定するか、2 つとも指定しないでください',
    );
  }
  if (domainName !== undefined && account === undefined) {
    throw new Error('独自ドメインを使うには、AWS の認証（アカウントの特定）が必要です');
  }
  return {
    ...(account === undefined ? {} : { account }),
    ...(domainName === undefined || hostedZoneName === undefined
      ? {}
      : { domainName, hostedZoneName }),
    ...(existingOidcProviderArn === undefined ? {} : { existingOidcProviderArn }),
  };
}
