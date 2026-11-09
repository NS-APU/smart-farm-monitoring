/**
 * アプリケーションの動作設定（暫定の既定値）。値の根拠は dev_spec.md 4章。
 * 環境変数からの読み込みと検証は runtime/config.ts で行う。
 */

import type { IngestionIntervalMinutes } from '@smart-farm/shared/constants/status';
import { DEFAULT_LATE_AFTER_MINUTES } from '../domain/observation-quality.ts';
import {
  DEFAULT_DELIVERY_EXPIRY_MINUTES,
  DEFAULT_RETRY_BASE_MINUTES,
  DEFAULT_RETRY_MAX_MINUTES,
} from '../domain/notification-delivery.ts';
import {
  DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES,
  DEFAULT_SUPPRESSION_MINUTES,
} from '../domain/notification-rules.ts';

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
     * 既定は通知する（ADR-0019 の D-37。#236）。形式違い・不正な値も、取り込みログに記録したうえで、取り込み失敗として通知する。
     * 通知しない運用にしたい場合は、設定（INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED）で切り替えられる。
     */
    readonly notifyFileFailures: boolean;
    /** 新しいデータが届かない取り込み元を、「データ取得の停止」として通知するか（V-018。暫定）。 */
    readonly stopNotificationEnabled: boolean;
    /** 「データ取得の停止」とみなす基準: 取得間隔の何倍、新しいデータがないか。 */
    readonly stopAfterIntervals: number;
  };
  readonly notification: {
    /** 取り込みの失敗・停止、連携の期限切れの通知を、同じ鍵で繰り返さない期間（分。D-38）。 */
    readonly suppressionMinutes: number;
    /** 「正常が続いたあとの悪化」を、新しい出来事として通知する、正常が続いた時間（分。D-38）。 */
    readonly recurrenceAfterNormalMinutes: number;
    /** Web Push の再送の最初の間隔（分）。失敗のたびに倍にする（ADR-0019 の D-38）。 */
    readonly webPushRetryBaseMinutes: number;
    /** Web Push の再送の間隔の上限（分）。 */
    readonly webPushRetryMaxMinutes: number;
    /** Web Push の配信を断念する期限（通知を作ってからの分）。Web Push の有効期限（TTL）も、この期限にそろえる。 */
    readonly webPushExpiryMinutes: number;
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
    /** 破棄の期限（日）。連携キューに積んでから、この日数を過ぎても送れていない項目は、破棄する（ADR-0016 の D-06）。 */
    readonly expiryDays: number;
  };
}

/** 連携の破棄の期限（日）の既定と、設定できる範囲。 */
export const DEFAULT_FEDERATION_EXPIRY_DAYS = 30;
export const MIN_FEDERATION_EXPIRY_DAYS = 1;
export const MAX_FEDERATION_EXPIRY_DAYS = 365;

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
    notifyFileFailures: true,
    stopNotificationEnabled: true,
    stopAfterIntervals: 3,
  },
  notification: {
    suppressionMinutes: DEFAULT_SUPPRESSION_MINUTES,
    recurrenceAfterNormalMinutes: DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES,
    webPushRetryBaseMinutes: DEFAULT_RETRY_BASE_MINUTES,
    webPushRetryMaxMinutes: DEFAULT_RETRY_MAX_MINUTES,
    webPushExpiryMinutes: DEFAULT_DELIVERY_EXPIRY_MINUTES,
    ioTimeoutMs: DEFAULT_IO_TIMEOUT_MS,
  },
  federation: {
    batchSize: 100,
    retryBaseDelayMinutes: 5,
    retryMaxDelayMinutes: 720,
    ioTimeoutMs: DEFAULT_IO_TIMEOUT_MS,
    expiryDays: DEFAULT_FEDERATION_EXPIRY_DAYS,
  },
};
