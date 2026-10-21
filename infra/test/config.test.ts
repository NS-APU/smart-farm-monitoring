import { describe, expect, it } from 'vitest';
import { STACK_NAMES, readConfig } from '../lib/config.ts';

describe('IaC の設定（環境変数）', () => {
  it('何も指定しなければ、アカウントにもドメインにも依存しない', () => {
    expect(readConfig({})).toEqual({ environment: 'development' });
  });

  it('空白だけの値は、未指定として扱う', () => {
    expect(
      readConfig({ SFM_DOMAIN_NAME: '  ', SFM_HOSTED_ZONE_NAME: '', CDK_DEFAULT_ACCOUNT: ' ' }),
    ).toEqual({ environment: 'development' });
  });

  it('アカウントと、独自ドメイン・ホストゾーンを読み取る', () => {
    expect(
      readConfig({
        CDK_DEFAULT_ACCOUNT: '111111111111',
        SFM_DOMAIN_NAME: 'eval.example.com',
        SFM_HOSTED_ZONE_NAME: 'example.com',
        SFM_GITHUB_OIDC_PROVIDER_ARN:
          'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
      }),
    ).toEqual({
      environment: 'development',
      account: '111111111111',
      domainName: 'eval.example.com',
      hostedZoneName: 'example.com',
      existingOidcProviderArn:
        'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
    });
  });

  it('サイトの環境（SFM_ENVIRONMENT）は、development（既定）か production。空白は、未指定。それ以外は、エラー（Issue #117）', () => {
    expect(readConfig({ SFM_ENVIRONMENT: 'production' }).environment).toBe('production');
    expect(readConfig({ SFM_ENVIRONMENT: 'development' }).environment).toBe('development');
    expect(readConfig({ SFM_ENVIRONMENT: ' ' }).environment).toBe('development');
    expect(() => readConfig({ SFM_ENVIRONMENT: 'prod' })).toThrow('SFM_ENVIRONMENT');
    expect(() => readConfig({ SFM_ENVIRONMENT: 'evaluation' })).toThrow('SFM_ENVIRONMENT');
  });

  it('スタックの名前: 開発サイトの既存の名前は、変えない。本番サイトは、別の名前（削除のコマンドが、*Evaluation* で選ぶため、Evaluation を含む）', () => {
    expect(STACK_NAMES.development).toEqual({
      data: 'SfmData',
      evaluation: 'SfmEvaluation',
      certificate: 'SfmEvaluationCertificate',
    });
    expect(STACK_NAMES.production).toEqual({
      data: 'SfmProductionData',
      evaluation: 'SfmProductionEvaluation',
      certificate: 'SfmProductionEvaluationCertificate',
    });
    const all = [
      ...Object.values(STACK_NAMES.development),
      ...Object.values(STACK_NAMES.production),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(STACK_NAMES.production.evaluation).toContain('Evaluation');
    expect(STACK_NAMES.production.certificate).toContain('Evaluation');
  });

  it('ドメイン名とホストゾーン名は、片方だけの指定を許さない', () => {
    expect(() =>
      readConfig({ CDK_DEFAULT_ACCOUNT: '1', SFM_DOMAIN_NAME: 'eval.example.com' }),
    ).toThrow('2 つとも');
    expect(() =>
      readConfig({ CDK_DEFAULT_ACCOUNT: '1', SFM_HOSTED_ZONE_NAME: 'example.com' }),
    ).toThrow('2 つとも');
  });

  it('独自ドメインには、AWS の認証（アカウントの特定）が必要', () => {
    expect(() =>
      readConfig({ SFM_DOMAIN_NAME: 'eval.example.com', SFM_HOSTED_ZONE_NAME: 'example.com' }),
    ).toThrow('アカウントの特定');
  });
});
