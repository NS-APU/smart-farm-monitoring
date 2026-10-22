/**
 * DynamoDB Local に接続するための、テスト用の設定。認証情報は、明らかにダミーの値（DynamoDB Local は、検証しない。
 * 英数字だけにする。ハイフンを含むと、DynamoDB Local が拒否する）。
 */

export const DYNAMODB_LOCAL_REGION = 'ap-northeast-1';
export const DYNAMODB_LOCAL_CREDENTIALS = {
  accessKeyId: 'localdummykey',
  secretAccessKey: 'localdummysecret',
};
