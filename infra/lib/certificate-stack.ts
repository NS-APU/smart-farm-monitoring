/**
 * CloudFront 用の証明書（ACM）のスタック。CloudFront は、us-east-1 の証明書しか使えないため、別のスタックにする。
 * 独自のサブドメインを使うときだけ作る（Issue #71）。DNS 検証は、Route 53 のホストゾーンに、自動でレコードを作る。
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { type Construct } from 'constructs';

export interface CertificateStackProps extends StackProps {
  readonly domainName: string;
  readonly hostedZoneName: string;
}

export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    // 別のリージョンのスタック（評価環境のスタック）から、証明書を参照できるようにする
    super(scope, id, { ...props, crossRegionReferences: true });
    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: props.hostedZoneName });
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: CertificateValidation.fromDns(zone),
    });
  }
}
