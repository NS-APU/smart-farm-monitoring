import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * 画面の Zod の設定（Issue #127）。画面には CSP（`unsafe-eval` なし）が付く。Zod は、起動時に `new Function` が使えるかを試し、
 * CSP のもとでは、例外を捕まえて動くが、ブラウザが CSP の違反として報告する。`jitless` にすると、この確認を省く（検証は、同じ結果）。
 */
describe('画面の Zod の設定（CSP のもとで、eval を試さない）', () => {
  it('設定の前は、JIT の確認を省かず、設定の読み込みのあとは、jitless になる', async () => {
    expect(z.config().jitless).not.toBe(true);

    await import('../../../src/frontend/lib/zod-config.ts');

    expect(z.config().jitless).toBe(true);
  });

  it('jitless でも、検証の結果は、変わらない（成功・失敗とエラーの内容）', async () => {
    await import('../../../src/frontend/lib/zod-config.ts');
    const schema = z.object({ name: z.string().min(1), count: z.number().int() });

    expect(schema.safeParse({ name: 'a', count: 2 }).success).toBe(true);
    const failed = schema.safeParse({ name: '', count: 1.5 });
    expect(failed.success).toBe(false);
    expect(failed.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'count',
      'name',
    ]);
  });
});
