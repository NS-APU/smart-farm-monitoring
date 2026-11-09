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

  describe('Web Push の実配信（#241。ADR-0019 の D-36）', () => {
    const PUBLIC_KEY = 'dummy-vapid-public-key';
    const SUBJECT = 'https://monitoring.example.test/';

    it('指定しなければ、設定に含めない（Web Push は、これまでどおり、購読を受け付けない。空白は、未指定として扱う）', () => {
      expect(readConfig({})).not.toHaveProperty('webPush');
      expect(readConfig({ SFM_WEB_PUSH_PUBLIC_KEY: ' ', SFM_WEB_PUSH_SUBJECT: '' })).toEqual({
        environment: 'development',
      });
    });

    it('SFM_WEB_PUSH_PUBLIC_KEY（公開鍵）と SFM_WEB_PUSH_SUBJECT（連絡先の https の URL）を、読み取る', () => {
      expect(
        readConfig({ SFM_WEB_PUSH_PUBLIC_KEY: PUBLIC_KEY, SFM_WEB_PUSH_SUBJECT: SUBJECT }),
      ).toMatchObject({ webPush: { publicKey: PUBLIC_KEY, subject: SUBJECT } });
    });

    it('どちらか片方だけの指定は、エラー（実配信には、2 つとも必要）', () => {
      expect(() => readConfig({ SFM_WEB_PUSH_PUBLIC_KEY: PUBLIC_KEY })).toThrow(
        'SFM_WEB_PUSH_PUBLIC_KEY と SFM_WEB_PUSH_SUBJECT',
      );
      expect(() => readConfig({ SFM_WEB_PUSH_SUBJECT: SUBJECT })).toThrow(
        'SFM_WEB_PUSH_PUBLIC_KEY と SFM_WEB_PUSH_SUBJECT',
      );
    });

    it.each(['mailto:person@example.test', 'http://monitoring.example.test/', 'monitoring'])(
      '連絡先は、https の URL のみ（%s は、エラー。個人のメールアドレスを、設定に持たない）',
      (subject) => {
        expect(() =>
          readConfig({ SFM_WEB_PUSH_PUBLIC_KEY: PUBLIC_KEY, SFM_WEB_PUSH_SUBJECT: subject }),
        ).toThrow('SFM_WEB_PUSH_SUBJECT');
      },
    );
  });

  describe('ログインの失敗の制限（接続元ごと。Issue #244。D-44）', () => {
    it('指定しなければ、設定に含めない（アプリの既定の、失敗 5 回 / 15 分）。空白は、未指定として扱う', () => {
      expect(readConfig({})).not.toHaveProperty('loginFailureLimit');
      expect(readConfig({})).not.toHaveProperty('loginFailureWindowMinutes');
      expect(
        readConfig({ SFM_LOGIN_FAILURE_LIMIT: ' ', SFM_LOGIN_FAILURE_WINDOW_MINUTES: '' }),
      ).toEqual({ environment: 'development' });
    });

    it('SFM_LOGIN_FAILURE_LIMIT・SFM_LOGIN_FAILURE_WINDOW_MINUTES を読み取る（片方だけも可）', () => {
      expect(
        readConfig({ SFM_LOGIN_FAILURE_LIMIT: '10', SFM_LOGIN_FAILURE_WINDOW_MINUTES: '30' }),
      ).toMatchObject({ loginFailureLimit: 10, loginFailureWindowMinutes: 30 });
      expect(readConfig({ SFM_LOGIN_FAILURE_LIMIT: '8' })).toMatchObject({
        loginFailureLimit: 8,
      });
    });

    it.each([
      ['SFM_LOGIN_FAILURE_LIMIT', '1'],
      ['SFM_LOGIN_FAILURE_LIMIT', '100'],
      ['SFM_LOGIN_FAILURE_WINDOW_MINUTES', '1'],
      ['SFM_LOGIN_FAILURE_WINDOW_MINUTES', '1440'],
    ])('境界値: %s=%s は、有効', (name, value) => {
      expect(() => readConfig({ [name]: value })).not.toThrow();
    });

    it.each([
      ['SFM_LOGIN_FAILURE_LIMIT', '0'],
      ['SFM_LOGIN_FAILURE_LIMIT', '101'],
      ['SFM_LOGIN_FAILURE_LIMIT', '2.5'],
      ['SFM_LOGIN_FAILURE_LIMIT', 'many'],
      ['SFM_LOGIN_FAILURE_WINDOW_MINUTES', '0'],
      ['SFM_LOGIN_FAILURE_WINDOW_MINUTES', '1441'],
      ['SFM_LOGIN_FAILURE_WINDOW_MINUTES', '-1'],
    ])('範囲外・不正な値は、エラー: %s=%s', (name, value) => {
      expect(() => readConfig({ [name]: value })).toThrow(name);
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
