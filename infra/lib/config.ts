/**
 * IaC の設定（環境変数）。アカウント ID・ドメイン名・ホストゾーン名は、リポジトリに書かず、環境変数で渡す。
 * - AWS のアカウント: CDK が、認証（プロファイル・OIDC のロール）から、CDK_DEFAULT_ACCOUNT に設定する
 * - SFM_ENVIRONMENT: サイトの環境（development（既定）・production。Issue #117。ADR-0013）。スタックの名前・タグ・構成が変わる。
 *   開発サイトの既存の名前（SfmData・SfmEvaluation）は、変えない
 * - SFM_DOMAIN_NAME・SFM_HOSTED_ZONE_NAME: 独自のサブドメインを使うときだけ、2 つとも指定する
 * - SFM_LOGIN_FAILURE_LIMIT・SFM_LOGIN_FAILURE_WINDOW_MINUTES: 接続元ごとのログインの失敗の制限（失敗の回数・時間（分））。
 *   API の Lambda の環境変数 LOGIN_FAILURE_LIMIT・LOGIN_FAILURE_WINDOW_MINUTES になる。指定しなければ、5 回 / 15 分
 *   （Issue #244。D-44）。値を変えるときは、環境変数を指定して、デプロイし直す（コードの変更は、要らない）
 * - SFM_WEB_PUSH_PUBLIC_KEY・SFM_WEB_PUSH_SUBJECT: Web Push の実配信（#241。ADR-0019 の D-36）。2 つとも指定したときだけ、
 *   API・ジョブの Lambda の環境変数 WEB_PUSH_DELIVERY=vapid・WEB_PUSH_PUBLIC_KEY・WEB_PUSH_SUBJECT になる。
 *   公開鍵は、VAPID の公開鍵（公開の値）。連絡先は、アプリの https の URL（個人のメールアドレスは使わない）。
 *   秘密鍵は、ここには指定しない（パラメータストアの `<環境のパス>web-push/vapid-private-key`。手順は、operations.md）
 */
import {
  MAX_LOGIN_FAILURE_LIMIT,
  MAX_LOGIN_FAILURE_WINDOW_MINUTES,
  MIN_LOGIN_FAILURE_LIMIT,
  MIN_LOGIN_FAILURE_WINDOW_MINUTES,
} from '../../src/backend/infrastructure/common/auth-policy.ts';

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
  /** 接続元ごとのログインの失敗の制限の回数。未指定は、アプリの既定（5 回）。 */
  readonly loginFailureLimit?: number;
  /** 接続元ごとのログインの失敗の制限の時間（分）。未指定は、アプリの既定（15 分）。 */
  readonly loginFailureWindowMinutes?: number;
  /** Web Push の実配信（公開鍵と連絡先）。未指定は、ダミー（購読も受け付けない）。 */
  readonly webPush?: { readonly publicKey: string; readonly subject: string };
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

/** 範囲の中の整数の環境変数を読む。未指定（空白を含む）は undefined。範囲外・整数でない値は、エラー。 */
function optionalInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = optional(env, name);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} は、${String(min)}〜${String(max)} の整数にしてください`);
  }
  return number;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): InfraConfig {
  const environment = readEnvironment(env);
  const account = optional(env, 'CDK_DEFAULT_ACCOUNT');
  const domainName = optional(env, 'SFM_DOMAIN_NAME');
  const hostedZoneName = optional(env, 'SFM_HOSTED_ZONE_NAME');
  const existingOidcProviderArn = optional(env, 'SFM_GITHUB_OIDC_PROVIDER_ARN');
  const loginFailureLimit = optionalInteger(
    env,
    'SFM_LOGIN_FAILURE_LIMIT',
    MIN_LOGIN_FAILURE_LIMIT,
    MAX_LOGIN_FAILURE_LIMIT,
  );
  const loginFailureWindowMinutes = optionalInteger(
    env,
    'SFM_LOGIN_FAILURE_WINDOW_MINUTES',
    MIN_LOGIN_FAILURE_WINDOW_MINUTES,
    MAX_LOGIN_FAILURE_WINDOW_MINUTES,
  );
  const webPush = readWebPush(env);
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
    ...(loginFailureLimit === undefined ? {} : { loginFailureLimit }),
    ...(loginFailureWindowMinutes === undefined ? {} : { loginFailureWindowMinutes }),
    ...(webPush === undefined ? {} : { webPush }),
  };
}

/** Web Push の公開鍵と連絡先。2 つとも指定するか、2 つとも指定しない。連絡先は、https の URL のみ。 */
function readWebPush(env: Readonly<Record<string, string | undefined>>): InfraConfig['webPush'] {
  const publicKey = optional(env, 'SFM_WEB_PUSH_PUBLIC_KEY');
  const subject = optional(env, 'SFM_WEB_PUSH_SUBJECT');
  if (publicKey === undefined && subject === undefined) {
    return undefined;
  }
  if (publicKey === undefined || subject === undefined) {
    throw new Error(
      'SFM_WEB_PUSH_PUBLIC_KEY と SFM_WEB_PUSH_SUBJECT は、2 つとも指定するか、2 つとも指定しないでください',
    );
  }
  if (!subject.startsWith('https://') || !URL.canParse(subject)) {
    throw new Error('SFM_WEB_PUSH_SUBJECT は、https の URL にしてください');
  }
  return { publicKey, subject };
}
