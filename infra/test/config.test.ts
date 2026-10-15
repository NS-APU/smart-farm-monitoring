import { describe, expect, it } from 'vitest';
import { readConfig } from '../lib/config.ts';

describe('IaC の設定（環境変数）', () => {
  it('何も指定しなければ、アカウントにもドメインにも依存しない', () => {
    expect(readConfig({})).toEqual({});
  });

  it('空白だけの値は、未指定として扱う', () => {
    expect(
      readConfig({ SFM_DOMAIN_NAME: '  ', SFM_HOSTED_ZONE_NAME: '', CDK_DEFAULT_ACCOUNT: ' ' }),
    ).toEqual({});
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
      account: '111111111111',
      domainName: 'eval.example.com',
      hostedZoneName: 'example.com',
      existingOidcProviderArn:
        'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
    });
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
