/**
 * サーバーレス環境（評価環境）に対するスモークテスト・性能の実測（`pnpm test:smoke`。Issue #79）の接続先・認証情報。
 * すべて環境変数で渡す（コード・ログ・結果に残さない。リポジトリは公開）。
 *
 * - SMOKE_BASE_URL: 環境の URL（`SfmEvaluation` のスタックの出力 `SiteUrl`。`https://` で始まる。パス・末尾のスラッシュは付けない）
 * - SMOKE_USER_ID / SMOKE_PASSWORD: ログインするユーザー（評価環境の初期ユーザー）
 *
 * エラーメッセージには、パスワードを含めない。
 */

export interface SmokeEnv {
  /** 末尾のスラッシュを除いた、環境の URL。 */
  readonly baseUrl: string;
  readonly userId: string;
  readonly password: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `環境変数 ${name} が必要です（使い方: docs/00_project/commands.md の「サーバーレス環境のスモークテスト」）`,
    );
  }
  return value;
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('SMOKE_BASE_URL が URL ではありません（例: https://xxxx.cloudfront.net）');
  }
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) {
    // 平文の通信で、パスワードを送らない（ローカルの確認だけ、http を許す）
    throw new Error('SMOKE_BASE_URL は、https:// で始まる URL を指定してください');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error('SMOKE_BASE_URL には、パス・クエリ・フラグメントを付けないでください');
  }
  return url.origin;
}

export function readSmokeEnv(env: Env = process.env): SmokeEnv {
  return {
    baseUrl: parseBaseUrl(required(env, 'SMOKE_BASE_URL')),
    userId: required(env, 'SMOKE_USER_ID').trim(),
    password: required(env, 'SMOKE_PASSWORD'),
  };
}
