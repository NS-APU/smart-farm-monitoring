/**
 * Lambda の関数のコードを、esbuild の JS API で、1 ファイルにまとめる（cdk synth・deploy の中で実行する）。
 * CDK の NodejsFunction は、pnpm のプロジェクトで、`pnpm exec esbuild` をシェル経由で呼ぶため、
 * Windows の pnpm のシムで失敗する。JS API で呼べば、Windows・Linux のどちらでも、同じように動く（Docker も不要）。
 * テストでは、CDK のコンテキスト `aws:cdk:bundling-stacks` を空にして、バンドルを省く。
 *
 * - AWS SDK も、まとめに含める（Lambda の実行環境の SDK の版は、変わりうる。テストした版を、そのまま動かすため）
 * - 資産のハッシュは、まとめた出力で決める（既定のソースのディレクトリのハッシュでは、ディレクトリの外のコード（application・
 *   infrastructure など）だけが変わったとき、デプロイしても、Lambda のコードが更新されない）
 */

import { dirname, join } from 'node:path';
import { AssetHashType, DockerImage } from 'aws-cdk-lib';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { buildSync } from 'esbuild';

/** `entry`（TypeScript）を、同じディレクトリを資産のもとにして、`index.js` にまとめた Code を返す。 */
export function bundledLambdaCode(entry: string): Code {
  return Code.fromAsset(dirname(entry), {
    assetHashType: AssetHashType.OUTPUT,
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
            outfile: join(outputDir, 'index.js'),
            logLevel: 'silent',
          });
          return true;
        },
      },
    },
  });
}
