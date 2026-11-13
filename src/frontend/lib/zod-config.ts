/**
 * 画面の Zod の設定（Issue #127）。ブラウザでの起動エントリ（main.tsx）が、ほかの読み込みより先に、これを読み込む。
 * 画面の配信には、CSP（`unsafe-eval` なし。infra/lib/content-security-policy.ts）が付く。Zod は、最初のスキーマの作成のときに、
 * `new Function` が使えるかを試す（検証を速くする JIT のため）。CSP のもとでは、例外を捕まえて動くが、ブラウザが、CSP の違反として報告する。
 * `jitless` にすると、この確認を省く（検証の結果は、同じ。画面の検証は、少量のため、速度の差は、問題にならない）。
 */

import { z } from 'zod';

z.config({ jitless: true });
