import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { bundledLambdaCode } from '../lib/bundle-lambda.ts';

describe('Lambda のコードのバンドル（esbuild の JS API）', () => {
  it('TypeScript のハンドラを、依存なしの 1 ファイル（index.js）にまとめる', () => {
    const app = new App();
    const stack = new Stack(app, 'Bundle');
    new LambdaFunction(stack, 'Api', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: bundledLambdaCode(join(import.meta.dirname, '../lambda/api.ts')),
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
