/**
 * 関数の URL への直接の呼び出しの防止（Issue #102。ADR-0010 の追記）の結合テスト。
 * CloudFront が、オリジンへの呼び出しに、秘密のヘッダー（ORIGIN_SECRET_HEADER）を付け、API が、値を検証する（設定 ORIGIN_VERIFY_SECRET）。
 * 一致しない呼び出し（CloudFront を経由しない直接の呼び出し）は、本文なしの 403 で拒否する。これにより、利用者の IP のヘッダー
 * （CLIENT_IP_HEADER）は、CloudFront の Function が入れた値だけになり、直接の呼び出しで偽装して、ログインの試行回数の制限を回避できない。
 * 秘密が未設定（ローカル・E2E）のときは、検証しない。
 */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/backend/application/ports/logger-port.ts';
import { ORIGIN_SECRET_HEADER } from '../../src/backend/presentation/origin-guard.ts';
import { TEST_USER, createTestContext, type TestContext } from '../support/test-context.ts';

const SECRET = 'dummyOriginSecret0123456789abcdefABCDEF0123456789';
const VIEWER_IP_HEADER = 'x-sfm-viewer-ip';

async function secured(extraEnv: Record<string, string> = {}) {
  return createTestContext({
    env: { ORIGIN_VERIFY_SECRET: SECRET, CLIENT_IP_HEADER: VIEWER_IP_HEADER, ...extraEnv },
  });
}

const login = (context: TestContext, headers: Record<string, string>, password: string) =>
  context.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ userId: TEST_USER.userId, password }),
  });

describe('秘密のヘッダーの検証（ORIGIN_VERIFY_SECRET。Issue #102）', () => {
  it('秘密が未設定なら、検証しない（ローカル・E2E は、これまでどおり）', async () => {
    const context = await createTestContext();

    const health = await context.app.request('/health');
    const response = await login(context, {}, TEST_USER.password);

    expect(health.status).toBe(200);
    expect(response.status).toBe(200);
  });

  it('ヘッダーがない呼び出し（直接の呼び出し）は、/health・ログイン・認証つきの API のすべてで、本文なしの 403', async () => {
    const context = await secured();
    const token = await (async () => {
      const response = await login(context, { [ORIGIN_SECRET_HEADER]: SECRET }, TEST_USER.password);
      return ((await response.json()) as { accessToken: string }).accessToken;
    })();

    const responses = await Promise.all([
      context.app.request('/health'),
      login(context, {}, TEST_USER.password),
      context.app.request('/api/v1/equipment', { headers: { authorization: `Bearer ${token}` } }),
      context.app.request('/api/v1/no-such-route'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('');
    }
  });

  it('値が違う・一部だけ合う・長すぎる・空の呼び出しは、403', async () => {
    const context = await secured();

    for (const value of [
      'wrong',
      '',
      `${SECRET}x`,
      SECRET.slice(0, -1),
      SECRET.toUpperCase(),
      SECRET.repeat(100),
    ]) {
      const response = await context.app.request('/health', {
        headers: { [ORIGIN_SECRET_HEADER]: value },
      });
      expect(response.status, value.slice(0, 20)).toBe(403);
    }
  });

  it('値が合う呼び出し（CloudFront 経由）は、これまでどおり動く（ヘッダー名は、大文字・小文字を区別しない）', async () => {
    const context = await secured();

    const health = await context.app.request('/health', {
      headers: { [ORIGIN_SECRET_HEADER]: SECRET },
    });
    const mixedCase = await context.app.request('/health', {
      headers: { 'X-Sfm-Origin-Secret': SECRET },
    });
    const response = await login(context, { [ORIGIN_SECRET_HEADER]: SECRET }, TEST_USER.password);

    expect(health.status).toBe(200);
    expect(mixedCase.status).toBe(200);
    expect(response.status).toBe(200);
  });

  it('直接の呼び出しで、利用者の IP のヘッダーを偽装しても、ログインの試行（失敗）に数えられず、制限も回避できない。正規の経路の制限は、そのまま効く', async () => {
    const context = await secured({ LOGIN_FAILURE_LIMIT: '3' });
    const viaCloudFront = { [ORIGIN_SECRET_HEADER]: SECRET, [VIEWER_IP_HEADER]: '198.51.100.7' };

    // 直接の呼び出し: IP を、毎回、変えて偽装しても、すべて 403（ログインの処理に届かず、401・429 にならない）
    const forged: number[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const response = await login(
        context,
        { [VIEWER_IP_HEADER]: `203.0.113.${String(index)}` },
        'wrong',
      );
      forged.push(response.status);
    }
    expect(forged).toEqual(Array(10).fill(403));

    // 正規の経路: 失敗が、3 回で、制限される（直接の呼び出しは、数えられていない）
    const attempts: number[] = [];
    for (let count = 0; count < 3; count += 1) {
      attempts.push((await login(context, viaCloudFront, 'wrong')).status);
    }
    const blocked = await login(context, viaCloudFront, TEST_USER.password);
    const otherViewer = await login(
      context,
      { ...viaCloudFront, [VIEWER_IP_HEADER]: '198.51.100.8' },
      TEST_USER.password,
    );

    expect(attempts).toEqual([401, 401, 401]);
    expect(blocked.status).toBe(429);
    expect(otherViewer.status).toBe(200);
  });

  it('拒否の記録（ログ）に、秘密の値・送られた値を含めない', async () => {
    const lines: string[] = [];
    const record = (message: string, fields?: Readonly<Record<string, unknown>>) => {
      lines.push(JSON.stringify({ message, ...fields }));
    };
    const recording: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
      child: () => recording,
    };
    const context = await createTestContext({
      env: { ORIGIN_VERIFY_SECRET: SECRET },
      logger: recording,
    });

    await context.app.request('/health', {
      headers: { [ORIGIN_SECRET_HEADER]: 'sent-wrong-value' },
    });

    const output = lines.join('\n');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('sent-wrong-value');
  });
});
