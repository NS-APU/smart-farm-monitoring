/**
 * 最小の API の Lambda ハンドラ（関数の URL。Issue #71）。`/health` だけに答える。
 * 目的は、サーバーレスの構成（CloudFront → 関数の URL）と、IaC・自動デプロイの経路を確かめること。
 * Issue #75 で、バックエンド本体の Lambda ハンドラ（src/backend/runtime/lambda.ts）に置き換える。
 * 応答の形は、バックエンドと同じ（`/health` は `{ status, time }`、エラーは `{ error: { code, message } }`）。
 */

export interface FunctionUrlEvent {
  readonly rawPath: string;
  readonly requestContext: { readonly http: { readonly method: string } };
}

export interface FunctionUrlResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

function json(statusCode: number, value: unknown): FunctionUrlResult {
  return { statusCode, headers: HEADERS, body: JSON.stringify(value) };
}

export function respond(event: FunctionUrlEvent, now: Date): FunctionUrlResult {
  if (event.requestContext.http.method === 'GET' && event.rawPath === '/health') {
    return json(200, { status: 'ok', time: now.toISOString() });
  }
  return json(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
}

/** Node.js の Lambda のハンドラは、Promise を返す形で書く（コールバック形式は使えない）。 */
export function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  return Promise.resolve(respond(event, new Date()));
}
