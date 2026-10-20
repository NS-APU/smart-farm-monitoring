/**
 * 提示層（Hono）が必要とする依存の一覧。アプリケーション層のサービスと設定のみ。
 * 組み立て（runtime/container.ts）が、これを満たす。
 * 本番の経路（handlers 系）は、アプリケーション層のみに依存する。開発用 API（dev-routes・DevApiDeps）だけが、
 * ローカルのアダプタ（時計・停止の再現）の型に依存する。
 */

import type { AuthenticatedUser } from '@smart-farm/shared/schemas/auth';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { AuditService } from '../application/audit/audit-service.ts';
import type { AuthService } from '../application/auth/auth-service.ts';
import type { UserService } from '../application/auth/user-service.ts';
import type { CriteriaAdminService } from '../application/evaluation/criteria-admin-service.ts';
import type { IngestionAdminService } from '../application/ingestion/ingestion-admin-service.ts';
import type { IngestionService } from '../application/ingestion/ingestion-service.ts';
import type { ManualEntryService } from '../application/manual-entry/manual-entry-service.ts';
import type { PushSubscriptionService } from '../application/notification/push-subscription-service.ts';
import type { EquipmentService } from '../application/equipment/equipment-service.ts';
import type { StatusCodeService } from '../application/equipment/status-code-service.ts';
import type { JobRunner } from '../application/jobs/job-runner.ts';
import type { Scheduler } from '../application/jobs/scheduler.ts';
import type { NotificationService } from '../application/notification/notification-service.ts';
import type { ClockPort } from '../application/ports/clock-port.ts';
import type { Logger } from '../application/ports/logger-port.ts';
import type { DashboardQuery } from '../application/query/dashboard-query.ts';
import type { ObservationQuery } from '../application/query/observation-query.ts';
import type { ViewpointQuery } from '../application/query/viewpoint-query.ts';
import type { DevSeedMode } from '../application/seed/seed-modes.ts';
import type { ControllableClock } from '../infrastructure/local/clocks.ts';
import type { DummyWebPush } from '../infrastructure/local/dummy-web-push.ts';
import type { FaultController } from '../infrastructure/local/faults.ts';
import type { MockFederation } from '../infrastructure/local/mock-federation.ts';

/** 開発用 API（時計・モック・リセット）の依存。ローカル・テストのみ。組み立て（container.ts）が、これを満たす。 */
export interface DevApiDeps {
  readonly clock: ControllableClock;
  readonly faults: {
    readonly fileServer: FaultController;
    readonly federation: FaultController;
    readonly webPush: FaultController;
  };
  readonly mocks: { readonly federation: MockFederation; readonly webPush: DummyWebPush };
  /** データを消し、初期データ（と、指定ならデモデータ）を入れ直す。 */
  reset(seedMode: DevSeedMode): Promise<void>;
  /** 観測値を保存し、指定なら評価する（E2E で、状態ごとの値を用意する）。保存した件数を返す。 */
  seedObservations(observations: readonly Observation[], evaluate: boolean): Promise<number>;
}

export interface ApiDeps {
  readonly logger: Logger;
  readonly clock: ClockPort;
  readonly authService: AuthService;
  readonly equipmentService: EquipmentService;
  readonly statusCodeService: StatusCodeService;
  readonly auditService: AuditService;
  readonly manualEntryService: ManualEntryService;
  readonly criteriaAdminService: CriteriaAdminService;
  readonly userService: UserService;
  readonly ingestionAdminService: IngestionAdminService;
  readonly ingestionService: IngestionService;
  readonly pushSubscriptionService: PushSubscriptionService;
  readonly dashboardQuery: DashboardQuery;
  readonly viewpointQuery: ViewpointQuery;
  readonly observationQuery: ObservationQuery;
  readonly notificationService: NotificationService;
  readonly jobRunner: JobRunner;
  readonly scheduler: Scheduler;
  /** 開発用 API。環境変数で明示した場合だけ有効（既定・本番では undefined。ルートを登録しない）。 */
  readonly dev: DevApiDeps | undefined;
  /** 信頼するプロキシの段数（接続元の識別。0 なら X-Forwarded-For を信頼しない）。 */
  readonly trustedProxyHops: number;
  /** 利用者の IP が入っているヘッダーの名前（接続元の識別。未指定なら使わない）。 */
  readonly clientIpHeader: string | undefined;
}

/** Hono のコンテキストの変数。 */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    user: AuthenticatedUser;
  };
}
