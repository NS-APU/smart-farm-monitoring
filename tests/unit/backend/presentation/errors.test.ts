/** API のエラー処理（共通のエラー応答）のテスト。 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../../../src/backend/application/ports/logger-port.ts';
import {
  buildErrorBody,
  handleError,
  handleNotFound,
} from '../../../../src/backend/presentation/errors.ts';
import type { AppEnv } from '../../../../src/backend/presentation/api-deps.ts';

describe('API のエラー処理', () => {
  function appThatThrows(error: Error) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('logger', NULL_LOGGER);
      await next();
    });
    app.onError(handleError);
    app.notFound(handleNotFound);
    app.get('/x', () => {
      throw error;
    });
    return app;
  }

  it('クライアント起因の HTTP エラー（4xx）は、入力不正（400）にする', async () => {
    const response = await appThatThrows(new HTTPException(404)).request('/x');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      buildErrorBody('VALIDATION_ERROR', 'リクエストが正しくありません'),
    );
  });

  it('サーバー起因の HTTP エラー（5xx）は、想定外のエラーとして扱い、内部情報を返さない', async () => {
    const response = await appThatThrows(
      new HTTPException(503, { message: 'internal detail' }),
    ).request('/x');

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('internal detail');
  });

  it('項目ごとのエラーは、1件もなければ fields を含めない', () => {
    expect(buildErrorBody('NOT_FOUND', 'なし')).toEqual({
      error: { code: 'NOT_FOUND', message: 'なし' },
    });
    expect(
      buildErrorBody('VALIDATION_ERROR', 'x', [{ name: 'a', message: 'b' }]).error.fields,
    ).toEqual([{ name: 'a', message: 'b' }]);
  });
});
