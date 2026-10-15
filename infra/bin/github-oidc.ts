/**
 * GitHub Actions の OIDC のプロバイダーとロールの CDK アプリのエントリ。
 * ユーザーが、1 回だけ、手元から実行する（`pnpm --filter @smart-farm/infra run deploy:oidc`）。
 */

import { createGithubOidcApp } from '../lib/apps.ts';

createGithubOidcApp(process.env).synth();
