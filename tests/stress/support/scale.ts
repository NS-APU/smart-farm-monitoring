/**
 * 負荷テストのデータ規模（定数。ここを変えると、規模を調整できる）。
 * 根拠: NFR-3.1（利用者10名ほど）、NFR-3.2（複数のハウス・ロボット・センサーへの拡張）、NFR-3.6（1台のロボットの稼働データを
 * 1日あたり数百〜数千レコード、1年分蓄積）。基本の1:1:1・15分間隔・1年分で約35万件（docs の手順9の測定と同じ規模）を、
 * 最初のハウスに置き、ほかのハウスで、複数のロボット・センサー・間隔を加える。
 * 実データ・個人情報は使わない（合成データ。設備名も、実在しそうな名前を避けた一般的な名称）。
 */

/** 1つのハウスの構成。ロボットとセンサーは、同じ台数（組）で置く。 */
export interface StressHouse {
  readonly houseId: string;
  readonly name: string;
  /** ロボット・環境センサーの組の数（ロボット n 台・センサー n 台）。 */
  readonly units: number;
  /** 自動取り込みの間隔（分）。 */
  readonly intervalMinutes: number;
}

export interface StressScale {
  readonly houses: readonly StressHouse[];
  /** 観測値を蓄積する期間（日）。NFR-3.6 の1年。 */
  readonly historyDays: number;
  /** 追加のステータスコードの数（初期の定義に加える）。 */
  readonly statusCodes: number;
  readonly notifications: number;
  readonly auditLogs: number;
  readonly manualEntries: number;
  readonly ingestionLogs: number;
  readonly ingestedFileRecords: number;
  readonly federationItems: number;
  readonly federationLogs: number;
  /** 観点ごと・設備ごとの、ステータスの変化の履歴の数。 */
  readonly statusChangesPerViewpoint: number;
  /** 利用者の数（単独利用の1人 + 同時接続の利用者。NFR-3.1 の10名）。 */
  readonly users: number;
}

export const STRESS_SCALE: StressScale = {
  houses: [
    { houseId: 'HOUSE-01', name: '負荷試験ハウス1', units: 1, intervalMinutes: 15 },
    { houseId: 'HOUSE-02', name: '負荷試験ハウス2', units: 2, intervalMinutes: 60 },
    { houseId: 'HOUSE-03', name: '負荷試験ハウス3', units: 1, intervalMinutes: 60 },
  ],
  historyDays: 365,
  statusCodes: 300,
  notifications: 5000,
  auditLogs: 5000,
  manualEntries: 5000,
  ingestionLogs: 5000,
  ingestedFileRecords: 35_000,
  federationItems: 10_000,
  federationLogs: 3000,
  statusChangesPerViewpoint: 100,
  users: 11,
};

/** 乱数の種（同じ種で、同じデータ。結果の再現性）。 */
export const STRESS_SEED = 20_261_012;

/** 負荷テスト用のユーザー（明らかにダミーとわかる値）。1人目が初期ユーザー。 */
export const STRESS_USER_PASSWORD = 'Dummy-Passw0rd-stress';

/** 同時接続の利用者（2人目から。1人目は、単独利用の利用者）。 */
export function concurrentUserId(index: number): string {
  return stressUserId(index + 1);
}

export function stressUserId(index: number): string {
  return `stress-user-${String(index + 1).padStart(2, '0')}`;
}

export const STRESS_USER = {
  userId: stressUserId(0),
  userName: '負荷試験ユーザー01',
  password: STRESS_USER_PASSWORD,
} as const;

/** 即時取得・定期取り込みの大量実行の規模。 */
export const BULK_INGESTION = {
  /** 取り込み元ごとのファイル数（ロボット JSON・センサー CSV）。 */
  filesPerSource: 150,
  /** 1ファイルの記録数（1時間おき・約6日分）。 */
  recordsPerFile: 144,
} as const;

/** ファイルの中の設備の識別子（設備の externalId）。 */
export function robotExternalId(houseIndex: number, unit: number): string {
  return `ROBOT-STRESS-${String(houseIndex + 1)}-${String(unit + 1)}`;
}

export function sensorExternalId(houseIndex: number, unit: number): string {
  return `SENSOR-STRESS-${String(houseIndex + 1)}-${String(unit + 1)}`;
}

export function robotId(houseIndex: number, unit: number): string {
  return houseIndex === 0 && unit === 0
    ? 'ROBOT-01'
    : `ROBOT-0${String(houseIndex + 1)}-${String(unit + 1)}`;
}

export function sensorId(houseIndex: number, unit: number): string {
  return houseIndex === 0 && unit === 0
    ? 'SENSOR-01'
    : `SENSOR-0${String(houseIndex + 1)}-${String(unit + 1)}`;
}
