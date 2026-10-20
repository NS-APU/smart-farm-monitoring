import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { bundledLambdaCode } from '../lib/bundle-lambda.ts';

const BACKEND_HANDLER = join(import.meta.dirname, '../../src/backend/runtime/lambda.ts');
const JOB_HANDLER = join(import.meta.dirname, '../../src/backend/runtime/job-lambda.ts');
// それぞれの入口だけが持つ文言（まとめた結果から、どちらのコードかを見分ける）
const JOB_ONLY_MESSAGE = 'ジョブの識別子（jobId）が不正です';
const API_ONLY_MESSAGE = '/health';

/** esbuild は、日本語を \uXXXX にして出力する。文言で探せるように、元の文字に戻す。 */
function decodeUnicodeEscapes(code: string): string {
  return code.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** バックエンド本体のハンドラを、まとめて、まとめた index.js のパスを返す。 */
function bundleBackendHandler(entry = BACKEND_HANDLER): string {
  const app = new App();
  const stack = new Stack(app, 'Bundle');
  new LambdaFunction(stack, 'Api', {
    runtime: Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: bundledLambdaCode(entry),
  });
  const assembly = app.synth();
  const assetDirs = readdirSync(assembly.directory)
    .filter((name) => name.startsWith('asset.'))
    .map((name) => join(assembly.directory, name))
    .filter((dir) => existsSync(join(dir, 'index.js')));
  expect(assetDirs).toHaveLength(1);
  return join(assetDirs[0] ?? '', 'index.js');
}

describe('Lambda のコードのバンドル（esbuild の JS API）', () => {
  it('TypeScript のハンドラを、依存なしの 1 ファイル（index.js）にまとめる', () => {
    const app = new App();
    const stack = new Stack(app, 'Bundle');
    new LambdaFunction(stack, 'Api', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: bundledLambdaCode(BACKEND_HANDLER),
    });
    const assembly = app.synth();
    const assetDirs = readdirSync(assembly.directory)
      .filter((name) => name.startsWith('asset.'))
      .map((name) => join(assembly.directory, name))
      .filter((dir) => existsSync(join(dir, 'index.js')));
    expect(assetDirs).toHaveLength(1);
    const bundled = readFileSync(join(assetDirs[0] ?? '', 'index.js'), 'utf8');
    // ハンドラが、まとめたファイルから、export されている
    expect(bundled).toContain('handler');
    // 入力の TypeScript の型は、残らない
    expect(bundled).not.toContain('interface FunctionUrlEvent');
  });
});

describe('バックエンド本体の Lambda のハンドラ（まとめた結果。Issue #75）', () => {
  it('AWS SDK を含む 1 ファイルになり、そのまま実行できる（/health に答える）', () => {
    const bundlePath = bundleBackendHandler();
    const bundled = readFileSync(bundlePath, 'utf8');

    // AWS SDK も、まとめに含める（Lambda の実行環境の SDK の版に、依存しない）
    expect(bundled).toContain('AdminInitiateAuth');
    expect(bundled).toContain('BatchWriteItem');
    // 大きさの目安（コールドスタートに影響する。実測は、Issue #79）
    expect(statSync(bundlePath).size).toBeLessThan(8 * 1024 * 1024);

    // まとめた結果を、別のプロセスで読み込み、ハンドラを呼ぶ（まとめた結果の、解決できない import などを検出する）。
    // AWS には接続しない設定（テストモード・メモリ）で、/health だけを呼ぶ
    const script = [
      `const { handler } = require(${JSON.stringify(bundlePath)});`,
      "const event = { version: '2.0', routeKey: '$default', rawPath: '/health', rawQueryString: '',",
      "  headers: { host: 'example.invalid' },",
      "  requestContext: { accountId: 'anonymous', apiId: 'dummy', authentication: null, authorizer: {},",
      "    domainName: 'example.invalid', domainPrefix: 'example',",
      "    http: { method: 'GET', path: '/health', protocol: 'HTTP/1.1', sourceIp: '192.0.2.10', userAgent: 'test' },",
      "    requestId: 'dummy', routeKey: '$default', stage: '$default', time: '09/Oct/2026:03:00:00 +0000', timeEpoch: 0 },",
      '  body: null, isBase64Encoded: false };',
      'handler(event, {}).then((result) => {',
      '  process.stdout.write(JSON.stringify({ statusCode: result.statusCode, body: result.body }));',
      '});',
    ].join('\n');
    const output = execFileSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        APP_MODE: 'test',
        PERSISTENCE: 'memory',
        AUTH_PROVIDER: 'local',
        LOG_LEVEL: 'error',
      },
      encoding: 'utf8',
    });

    const result = JSON.parse(output) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'ok' });
  });
});

describe('ジョブの Lambda のハンドラ（まとめた結果。Issue #76）', () => {
  it('AWS SDK を含む 1 ファイルになり、そのまま実行できる（EventBridge の入力で、ジョブを実行する）', () => {
    const bundlePath = bundleBackendHandler(JOB_HANDLER);
    const bundled = readFileSync(bundlePath, 'utf8');

    expect(bundled).toContain('BatchWriteItem');
    expect(statSync(bundlePath).size).toBeLessThan(8 * 1024 * 1024);

    // まとめた結果を、別のプロセスで読み込み、ハンドラを呼ぶ（まとめた結果の、解決できない import などを検出する）。
    // AWS には接続しない設定（テストモード・メモリ）で、通知の配信のジョブ（JB-04）だけを呼ぶ
    const script = [
      `const { handler } = require(${JSON.stringify(bundlePath)});`,
      "handler({ jobId: 'JB-04' }).then((result) => {",
      '  process.stdout.write(JSON.stringify(result));',
      '});',
    ].join('\n');
    const output = execFileSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        APP_MODE: 'test',
        PERSISTENCE: 'memory',
        AUTH_PROVIDER: 'local',
        LOG_LEVEL: 'error',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toEqual({
      jobId: 'JB-04',
      outcome: 'EXECUTED',
      result: {
        jobId: 'JB-04',
        summary: { notificationsProcessed: 0, delivered: 0, failed: 0 },
      },
    });
  });
});

describe('API とジョブの Lambda を、1 つの合成に入れたとき（Issue #107）', () => {
  it('それぞれが、別のコードにまとめられる（CDK がまとめを使い回して、ジョブの Lambda が API のコードで動かない）', () => {
    const app = new App();
    const stack = new Stack(app, 'Bundle');
    new LambdaFunction(stack, 'Api', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: bundledLambdaCode(BACKEND_HANDLER),
    });
    new LambdaFunction(stack, 'Job', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: bundledLambdaCode(JOB_HANDLER),
    });
    const assembly = app.synth();
    const bundles = readdirSync(assembly.directory)
      .filter((name) => name.startsWith('asset.'))
      .map((name) => join(assembly.directory, name))
      .filter((dir) => existsSync(join(dir, 'index.js')))
      .map((dir) => decodeUnicodeEscapes(readFileSync(join(dir, 'index.js'), 'utf8')));

    // 入口が違えば、まとめも別（共有すると、1 つしかできない）
    expect(bundles).toHaveLength(2);
    // ジョブの入口だけが持つ文言（入力の検証のエラー）。ジョブのコードは 1 つだけで、API のコードには、ない
    const jobBundles = bundles.filter((bundle) => bundle.includes(JOB_ONLY_MESSAGE));
    expect(jobBundles).toHaveLength(1);
    // API のコードだけが持つ文言（ヘルスチェックの応答）。ジョブのコードには、ない
    const apiBundles = bundles.filter((bundle) => bundle.includes(API_ONLY_MESSAGE));
    expect(apiBundles).toHaveLength(1);
    expect(jobBundles[0]).not.toContain(API_ONLY_MESSAGE);
  });
});
