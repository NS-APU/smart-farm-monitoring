import { describe, expect, it } from 'vitest';
import { handler, respond, type FunctionUrlEvent } from '../lambda/api.ts';

const event = (method: string, rawPath: string): FunctionUrlEvent => ({
  rawPath,
  requestContext: { http: { method } },
});

describe('最小の API のハンドラ（関数の URL）', () => {
  it('GET /health は、200 で、状態と時刻を返す（バックエンドの /health と同じ形）', () => {
    const result = respond(event('GET', '/health'), new Date('2026-10-15T00:00:00.000Z'));
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(result.body)).toEqual({ status: 'ok', time: '2026-10-15T00:00:00.000Z' });
  });

  it('それ以外のパス・メソッドは、共通のエラー形式で、404 を返す', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/equipment'],
      ['POST', '/health'],
      ['GET', '/'],
    ] as const) {
      const result = respond(event(method, path), new Date());
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'NOT_FOUND', message: '対象が見つかりません' },
      });
    }
  });

  it('handler は、Promise で結果を返す（Node.js の Lambda はコールバック形式を使えない）', async () => {
    const result = await handler(event('GET', '/health'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'ok' });
  });
});
