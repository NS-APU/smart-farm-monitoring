/**
 * GET の応答の ETag のキャッシュ（URL ごと）。次の同じ GET に If-None-Match を付け、304（変化なし）なら前回の本文を使う。
 * ETag は、同じ URL・同じアクセストークンのときだけ使う（別の利用者の応答を使い回さない）。
 */

/** 前回の GET の応答（ETag つき）。 */
export interface CachedResponse {
  /** 保存したときのアクセストークンと同じトークンで送るときだけ、ETag を返す。 */
  etagFor(accessToken: string | undefined): string | undefined;
  /** 前回の本文（304 のときに使う）。 */
  readonly body: unknown;
}

export interface EtagCache {
  lookup(url: string): CachedResponse | undefined;
  store(url: string, accessToken: string | undefined, etag: string, body: unknown): void;
}

export function createEtagCache(): EtagCache {
  const entries = new Map<string, CachedResponse>();
  return {
    lookup: (url) => entries.get(url),
    store(url, accessToken, etag, body) {
      entries.set(url, {
        etagFor: (requestToken) => (requestToken === accessToken ? etag : undefined),
        body,
      });
    },
  };
}
