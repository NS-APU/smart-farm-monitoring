/**
 * IaC の設定（環境変数）。アカウント ID・ドメイン名・ホストゾーン名は、リポジトリに書かず、環境変数で渡す。
 * - AWS のアカウント: CDK が、認証（プロファイル・OIDC のロール）から、CDK_DEFAULT_ACCOUNT に設定する
 * - SFM_ENVIRONMENT: サイトの環境（development（既定）・production。Issue #117。ADR-0013）。スタックの名前・タグ・構成が変わる。
 *   開発サイトの既存の名前（SfmData・SfmEvaluation）は、変えない
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

/** サイトの環境。開発サイト（現在の評価環境）と、本番サイト（実証実験用）。GitHub の Environment の名前も、これと同じ。 */
export const SITE_ENVIRONMENTS = ['development', 'production'] as const;
export type SiteEnvironment = (typeof SITE_ENVIRONMENTS)[number];
export const DEFAULT_SITE_ENVIRONMENT: SiteEnvironment = 'development';

/**
 * 環境ごとのスタックの名前。**開発サイトの名前は、変えない**（スタックの名前を変えると、リソースが置き換わる）。
 * 本番サイトは、別の名前にして、同じアカウントでも、データ・ユーザー・URL を共有しない。
 * 評価環境の名前に、`Evaluation` を含める（削除のコマンドが、環境を問わず、`*Evaluation*` で選ぶ）。
 */
export const STACK_NAMES: Readonly<
  Record<SiteEnvironment, { data: string; evaluation: string; certificate: string }>
> = {
  development: {
    data: 'SfmData',
    evaluation: 'SfmEvaluation',
    certificate: 'SfmEvaluationCertificate',
  },
  production: {
    data: 'SfmProductionData',
    evaluation: 'SfmProductionEvaluation',
    certificate: 'SfmProductionEvaluationCertificate',
  },
};

export interface InfraConfig {
  /** サイトの環境。未指定は、development。 */
  readonly environment: SiteEnvironment;
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

function readEnvironment(env: Readonly<Record<string, string | undefined>>): SiteEnvironment {
  const value = optional(env, 'SFM_ENVIRONMENT');
  if (value === undefined) {
    return DEFAULT_SITE_ENVIRONMENT;
  }
  const found = SITE_ENVIRONMENTS.find((name) => name === value);
  if (found === undefined) {
    throw new Error(`SFM_ENVIRONMENT は、${SITE_ENVIRONMENTS.join(' か ')} にしてください`);
  }
  return found;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): InfraConfig {
  const environment = readEnvironment(env);
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
    environment,
    ...(account === undefined ? {} : { account }),
    ...(domainName === undefined || hostedZoneName === undefined
      ? {}
      : { domainName, hostedZoneName }),
    ...(existingOidcProviderArn === undefined ? {} : { existingOidcProviderArn }),
  };
}
