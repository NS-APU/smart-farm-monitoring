/**
 * Lambda の関数のコードを、esbuild の JS API で、1 ファイルにまとめる（cdk synth・deploy の中で実行する）。
 * CDK の NodejsFunction は、pnpm のプロジェクトで、`pnpm exec esbuild` をシェル経由で呼ぶため、
 * Windows の pnpm のシムで失敗する。JS API で呼べば、Windows・Linux のどちらでも、同じように動く（Docker も不要）。
 * テストでは、CDK のコンテキスト `aws:cdk:bundling-stacks` を空にして、バンドルを省く。
 */

import { dirname, join } from 'node:path';
import { DockerImage } from 'aws-cdk-lib';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { buildSync } from 'esbuild';

/** `entry`（TypeScript）を、同じディレクトリを資産のもとにして、`index.js` にまとめた Code を返す。 */
export function bundledLambdaCode(entry: string): Code {
  return Code.fromAsset(dirname(entry), {
    bundling: {
      // ローカルでバンドルできるため、Docker のイメージは使わない（型の要求を満たすための指定）
      image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24'),
      local: {
        tryBundle(outputDir: string): boolean {
          buildSync({
            entryPoints: [entry],
            bundle: true,
            platform: 'node',
            target: 'node24',
            format: 'cjs',
            minify: true,
            legalComments: 'none',
            // AWS SDK は、Lambda の実行環境に含まれる
            external: ['@aws-sdk/*'],
            outfile: join(outputDir, 'index.js'),
            logLevel: 'silent',
          });
          return true;
        },
      },
    },
  });
}
