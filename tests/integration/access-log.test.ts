/** アクセスログ（レビュー V-099）のテスト。アプリ全体（認証・ルート・ログ）を、テスト用の組み立てで動かす。 */

import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../../src/backend/infrastructure/logging/json-logger.ts';
import { createTestContext } from '../support/test-context.ts';

describe('アクセスログ（V-099）', () => {
  it('認証後のリクエストには、操作者（userId）と対象の設備（equipmentId）を残す。公開ルートには、操作者がない', async () => {
    const entries: Record<string, unknown>[] = [];
    const sink = {
      write: (line: string) => entries.push(JSON.parse(line) as Record<string, unknown>),
    };
    const logger = createJsonLogger({ sink, minimumLevel: 'info' });
    const context = await createTestContext({ logger });
    const token = await context.login();
    entries.length = 0;

    await context.request('/dashboard?equipmentId=HOUSE-T1', { token });
    await context.app.request('/health');

    const dashboard = entries.find((entry) => entry.path === '/api/v1/dashboard');
    const health = entries.find((entry) => entry.path === '/health');
    expect(dashboard).toMatchObject({ userId: 'test-user', equipmentId: 'HOUSE-T1' });
    expect(health).toBeDefined();
    expect(health).not.toHaveProperty('userId');
  });
});
