/**
 * アプリケーションの動作設定（暫定の既定値）。値の根拠は dev_spec.md 4章。
 * 環境変数からの読み込みと検証は runtime/config.ts で行う。
 */

import type { IngestionIntervalMinutes } from '@smart-farm/shared/constants/status';
import { DEFAULT_LATE_AFTER_MINUTES } from '../domain/observation-quality.ts';
import { DEFAULT_SUPPRESSION_MINUTES } from '../domain/notification-rules.ts';

export interface AppSettings {
  /** 取得間隔の既定値（分）。FR-1.5 の既定値は TODO のため、構想時の15分を採用する。 */
  readonly defaultIngestionIntervalMinutes: IngestionIntervalMinutes;
  /** 「データが古い」とみなす基準: 取得間隔の何倍を超えたか。 */
  readonly staleAfterIntervals: number;
  readonly ingestion: {
    /** 接続・取得の試行回数（初回を含む）。 */
    readonly maxAttempts: number;
    /** 再試行の待ち時間（ミリ秒）の基準。試行ごとに2倍にする。 */
    readonly retryBaseDelayMs: number;
    readonly lateAfterMinutes: number;
    /** ファイルサーバーへの1回の通信（一覧・読み取り・接続テスト）のタイムアウト（ミリ秒）。 */
    readonly ioTimeoutMs: number;
    /** 読み込むファイルの大きさの上限（バイト）。超えたファイルは、読まずに失敗として扱う。 */
    readonly maxFileBytes: number;
    /**
     * ファイル単位の失敗（読み取り不可・形式違い・大きすぎる）を、取り込み失敗として通知するか（V-017）。
     * 既定は通知しない（UC-24・dev_spec.md 4章 No.17: 形式違い・不正な値は、取り込みログに記録し、接続の失敗とは区別して通知しない）。
     * 通知の条件は、発注者の確認（Q-011）が先に必要なため、設定で切り替えられるようにする。
     */
    readonly notifyFileFailures: boolean;
    /** 新しいデータが届かない取り込み元を、「データ取得の停止」として通知するか（V-018。暫定）。 */
    readonly stopNotificationEnabled: boolean;
    /** 「データ取得の停止」とみなす基準: 取得間隔の何倍、新しいデータがないか。 */
    readonly stopAfterIntervals: number;
  };
  readonly notification: {
    readonly suppressionMinutes: number;
    /** Web Push の配信の試行回数の上限（初回を含む）。 */
    readonly maxDeliveryAttempts: number;
    /** Web Push への1回の配信のタイムアウト（ミリ秒）。 */
    readonly ioTimeoutMs: number;
  };
  readonly federation: {
    readonly batchSize: number;
    /** 再試行の間隔（分）の基準。試行ごとに2倍にし、上限まで広げる。 */
    readonly retryBaseDelayMinutes: number;
    readonly retryMaxDelayMinutes: number;
    /** 農業情報基盤への1回の送信のタイムアウト（ミリ秒）。 */
    readonly ioTimeoutMs: number;
  };
}

/** 外部との通信のタイムアウトの既定（ミリ秒）。Lambda の実行時間・ゲートウェイの時間制限より、十分に短くする。 */
const DEFAULT_IO_TIMEOUT_MS = 30_000;
/** 読み込むファイルの大きさの上限の既定（10 MiB）。 */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultIngestionIntervalMinutes: 15,
  staleAfterIntervals: 3,
  ingestion: {
    maxAttempts: 3,
    retryBaseDelayMs: 1000,
    lateAfterMinutes: DEFAULT_LATE_AFTER_MINUTES,
    ioTimeoutMs: DEFAULT_IO_TIMEOUT_MS,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    notifyFileFailures: false,
    stopNotificationEnabled: true,
    stopAfterIntervals: 3,
  },
  notification: {
    suppressionMinutes: DEFAULT_SUPPRESSION_MINUTES,
    maxDeliveryAttempts: 3,
    ioTimeoutMs: DEFAULT_IO_TIMEOUT_MS,
  },
  federation: {
    batchSize: 100,
    retryBaseDelayMinutes: 5,
    retryMaxDelayMinutes: 720,
    ioTimeoutMs: DEFAULT_IO_TIMEOUT_MS,
  },
};
