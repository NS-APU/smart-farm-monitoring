/**
 * 自前のファイルサーバーの Lambda のハンドラ（Issue #298。ADR-0027）。Lambda の Function URL（ペイロード形式 2.0。URL 自体は認証なしで、
 * アプリが、読み取り用・書き込み用のトークンで認証する）から、ロボットの `PUT`、取り込み（JB-01）の `GET`・`HEAD` を受ける。
 * 処理は、`application/hosted-file-server/hosted-file-server.ts`。ここは、イベントとの変換と、実際の保管先（S3）・秘密情報（パラメータストア）の
 * 組み立てだけを持つ。ほかの Lambda（API・ジョブ・デモ配信）とは、別の関数・別の権限にする（DynamoDB・Cognito は、使わない）。
 *
 * - 環境変数: `HOSTED_FILE_SERVER_BUCKET`（保管先のバケット）・`CREDENTIAL_PATH_PREFIX`（トークンのパラメータストアのパスの接頭辞。例 `/sfm/development/`）・
 *   `LOG_LEVEL`（任意。既定 info）。トークンの値は、環境変数に持たない
 * - 組み立ては、最初の呼び出しで 1 度だけ行い、失敗したときは、次の呼び出しで再試行する（job-lambda.ts と同じ）
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import {
  createHostedFileServer,
  type HostedFileServer,
} from '../application/hosted-file-server/hosted-file-server.ts';
import {
  createJsonLogger,
  LOG_LEVELS,
  STDOUT_SINK,
} from '../infrastructure/logging/json-logger.ts';
import { createS3HostedFileStore } from '../infrastructure/s3/s3-hosted-file-store.ts';
import { createSsmSecretPort } from '../infrastructure/ssm/ssm-secret.ts';

/** Function URL のリクエスト（ペイロード形式 2.0 のうち、使う項目だけ）。 */
export interface HostedFileHttpEvent {
  readonly rawPath?: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

/** Function URL のレスポンス。 */
export interface HostedFileHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HostedFileHttpHandler = (event: HostedFileHttpEvent) => Promise<HostedFileHttpResponse>;

const EnvSchema = z.object({
  HOSTED_FILE_SERVER_BUCKET: z.string().min(3).max(63),
  CREDENTIAL_PATH_PREFIX: z.string().regex(/^\/([a-z0-9][a-z0-9._-]*\/)+$/),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface HostedFileServerEnv {
  readonly bucket: string;
  readonly credentialPathPrefix: string;
  readonly logLevel: (typeof LOG_LEVELS)[number];
}

/** 環境変数を読む。足りない・形式が正しくないときは、エラー（値は、メッセージに含めない）。 */
export function parseHostedFileServerEnv(
  env: Readonly<Record<string, string | undefined>>,
): HostedFileServerEnv {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `環境変数が正しくありません: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  return {
    bucket: parsed.data.HOSTED_FILE_SERVER_BUCKET,
    credentialPathPrefix: parsed.data.CREDENTIAL_PATH_PREFIX,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

/** ヘッダーの値を、名前の大文字・小文字を区別せずに探す（ペイロード形式 2.0 は、小文字にして渡す）。 */
function headerOf(headers: HostedFileHttpEvent['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

/** イベントと、ファイルサーバーの中核の、対応づけ（テストでは、中核を差し替える）。 */
export function createHostedFileServerLambdaHandler(
  server: HostedFileServer,
): HostedFileHttpHandler {
  return (event) => {
    const body =
      event.body === undefined
        ? undefined
        : Buffer.from(event.body, event.isBase64Encoded === true ? 'base64' : 'utf8');
    return server({
      method: event.requestContext?.http?.method ?? '',
      path: event.rawPath ?? '',
      authorization: headerOf(event.headers, 'authorization'),
      body,
    });
  };
}

/** 環境変数から、実際の保管先（S3）・秘密情報（パラメータストア）を組み立てた、Lambda のハンドラを作る。 */
export function createHostedFileServerLambda(
  env: Readonly<Record<string, string | undefined>>,
): HostedFileHttpHandler {
  let ready: HostedFileHttpHandler | undefined;

  function initialize(): HostedFileHttpHandler {
    const config = parseHostedFileServerEnv(env);
    const logger = createJsonLogger({ sink: STDOUT_SINK, minimumLevel: config.logLevel });
    return createHostedFileServerLambdaHandler(
      createHostedFileServer({
        store: createS3HostedFileStore({ client: new S3Client({}), bucket: config.bucket }),
        secrets: createSsmSecretPort({
          client: new SSMClient({}),
          pathPrefix: config.credentialPathPrefix,
          logger,
        }),
        logger,
      }),
    );
  }

  // 組み立ての失敗（環境変数の誤り）は、保持しない（`ready` は未設定のまま）。次の呼び出しで、組み立てをやり直す
  return async (event) => {
    ready ??= initialize();
    return ready(event);
  };
}

export const handler: HostedFileHttpHandler = createHostedFileServerLambda(process.env);
