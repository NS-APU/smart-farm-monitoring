/**
 * 組み立て（コンポジションルート）。設定に応じて、ポートの実装（アダプタ）を選び、サービスを組み立てる。
 * 本番は、DynamoDB・Cognito・実ファイルサーバー等のアダプタを、ここで差し替える（後で追加する）。
 * ローカル（local）・テスト（test）では、メモリ／ファイルの Repository、ファイルサーバーと農業情報基盤の
 * モック、Web Push のダミー、アプリ内の認証、操作できる時計を使う（AWS なしで E2E・負荷テストを動かす）。
 */

import {
  DEFAULT_ROLE_CONFIG,
  createAccessPolicy,
  type AccessPolicy,
} from '../application/auth/access-policy.ts';
import { createAuthService, type AuthService } from '../application/auth/auth-service.ts';
import { createUserService, type UserService } from '../application/auth/user-service.ts';
import { createAuditService, type AuditService } from '../application/audit/audit-service.ts';
import {
  createManualEntryService,
  type ManualEntryService,
} from '../application/manual-entry/manual-entry-service.ts';
import {
  createCriteriaAdminService,
  type CriteriaAdminService,
} from '../application/evaluation/criteria-admin-service.ts';
import {
  createIngestionAdminService,
  type IngestionAdminService,
} from '../application/ingestion/ingestion-admin-service.ts';
import {
  createPushSubscriptionService,
  type PushSubscriptionService,
} from '../application/notification/push-subscription-service.ts';
import { createCriteriaService } from '../application/evaluation/criteria-service.ts';
import {
  createEvaluationService,
  type EvaluationService,
} from '../application/evaluation/evaluation-service.ts';
import {
  createEquipmentService,
  type EquipmentService,
} from '../application/equipment/equipment-service.ts';
import {
  createStatusCodeService,
  type StatusCodeService,
} from '../application/equipment/status-code-service.ts';
import { createFederationService } from '../application/federation/federation-service.ts';
import {
  createIngestionSettings,
  type IngestionSettings,
} from '../application/ingestion/ingestion-settings.ts';
import {
  createIngestionService,
  type IngestionService,
} from '../application/ingestion/ingestion-service.ts';
import { createJobRunner, type JobRunner } from '../application/jobs/job-runner.ts';
import {
  DEFAULT_SCHEDULE,
  createScheduler,
  type Scheduler,
} from '../application/jobs/scheduler.ts';
import {
  createNotificationService,
  type NotificationService,
} from '../application/notification/notification-service.ts';
import { errorLogFields } from '../application/error-fields.ts';
import type { ClockPort } from '../application/ports/clock-port.ts';
import type { IdGeneratorPort } from '../application/ports/id-generator-port.ts';
import type { Logger } from '../application/ports/logger-port.ts';
import type { Repositories } from '../application/ports/repositories.ts';
import { createDashboardQuery, type DashboardQuery } from '../application/query/dashboard-query.ts';
import {
  createObservationQuery,
  type ObservationQuery,
} from '../application/query/observation-query.ts';
import { createViewpointQuery, type ViewpointQuery } from '../application/query/viewpoint-query.ts';
import { seedInitialStatusCodes } from '../application/seed/initial-data.ts';
import type { SeedMode } from '../application/seed/seed-modes.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../application/settings.ts';
import { createDefaultFormatProfileRegistry } from '../infrastructure/format-profiles/declarative-profile.ts';
import {
  createControllableClock,
  createSystemClock,
  type ControllableClock,
} from '../infrastructure/local/clocks.ts';
import { createDummyWebPush } from '../infrastructure/local/dummy-web-push.ts';
import { createFaultController } from '../infrastructure/local/faults.ts';
import { createUuidGenerator } from '../infrastructure/local/ids.ts';
import { ensureInitialUser } from '../infrastructure/local/initial-user.ts';
import { createLocalAuth } from '../infrastructure/local/local-auth.ts';
import { createLocalRepositories } from '../infrastructure/local/local-repositories.ts';
import { hashPassword } from '../infrastructure/local/password-hasher.ts';
import { createDirectoryFileSource } from '../infrastructure/local/mock-file-server.ts';
import { createMockFederation } from '../infrastructure/local/mock-federation.ts';
import {
  DEMO_ROBOT_ID,
  DEMO_SENSOR_ID,
  buildDemoEquipment,
  generateAutoObservations,
  generateManualObservations,
} from '../infrastructure/local/synthetic-data.ts';
import { createJsonLogger, STDOUT_SINK } from '../infrastructure/logging/json-logger.ts';
import type { DevApiDeps } from '../presentation/api-deps.ts';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import { ConfigError, type AppConfig } from './config.ts';

const DEMO_DAYS = 3;
const DEMO_SEED = 20_261_009;
/** デモの温度の基準（℃）。環境適応性が「注意」になり、通知の例が得られる。 */
const DEMO_TEMPERATURE_BASE_CELSIUS = 26;

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: ClockPort;
  readonly repositories: Repositories;
  readonly policy: AccessPolicy;
  readonly authService: AuthService;
  readonly equipmentService: EquipmentService;
  readonly statusCodeService: StatusCodeService;
  readonly auditService: AuditService;
  readonly manualEntryService: ManualEntryService;
  readonly criteriaAdminService: CriteriaAdminService;
  readonly userService: UserService;
  readonly ingestionAdminService: IngestionAdminService;
  readonly pushSubscriptionService: PushSubscriptionService;
  readonly dashboardQuery: DashboardQuery;
  readonly viewpointQuery: ViewpointQuery;
  readonly observationQuery: ObservationQuery;
  readonly notificationService: NotificationService;
  readonly evaluationService: EvaluationService;
  readonly ingestionService: IngestionService;
  readonly ingestionSettings: IngestionSettings;
  readonly jobRunner: JobRunner;
  readonly scheduler: Scheduler;
  /** 開発用の操作（時計・モック・リセット）。環境変数 DEV_API_ENABLED で明示した場合だけ有効（既定・本番では undefined）。 */
  readonly dev: DevApiDeps | undefined;
  /** 信頼するプロキシの段数（接続元の識別）。 */
  readonly trustedProxyHops: number;
  /** 初期データ・最初のユーザー・（指定なら）デモデータを用意する。起動時に1度呼ぶ。 */
  initialize(): Promise<void>;
  /** 未保存のデータを書き出し、スケジューラを止める。 */
  close(): void;
}

export interface ContainerOverrides {
  readonly logger?: Logger;
  readonly clock?: ControllableClock;
  readonly ids?: IdGeneratorPort;
  readonly settings?: Partial<AppSettings>;
}

/** 設定の既定値に、環境変数の設定と、テストの上書きを重ねる。 */
function buildSettings(config: AppConfig, overrides: ContainerOverrides): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    defaultIngestionIntervalMinutes: config.defaultIngestionIntervalMinutes,
    staleAfterIntervals: config.staleAfterIntervals,
    ingestion: {
      ...DEFAULT_APP_SETTINGS.ingestion,
      retryBaseDelayMs: config.ingestionRetryBaseDelayMs,
      stopNotificationEnabled: config.ingestionStopNotificationEnabled,
      notifyFileFailures: config.ingestionFileFailureNotificationEnabled,
      stopAfterIntervals: config.staleAfterIntervals,
    },
    ...overrides.settings,
  };
}

/** ローカル・テスト用のアダプタ: Repository、ファイルサーバーと農業情報基盤のモック、Web Push のダミー、認証。 */
function buildAdapters(config: AppConfig, clock: ClockPort, logger: Logger) {
  const { repositories, store } = createLocalRepositories(
    config.persistence === 'file'
      ? {
          filePath: config.dataFile,
          onFlushError: (error) => {
            logger.error('データファイルの書き込みに失敗しました。再び書き込みます', {
              ...errorLogFields(error),
            });
          },
        }
      : {},
  );
  store.load();

  const faults = {
    fileServer: createFaultController(),
    federation: createFaultController(),
    webPush: createFaultController(),
  };
  const mocks = {
    federation: createMockFederation({ faults: faults.federation, clock }),
    webPush: createDummyWebPush({ faults: faults.webPush }),
  };
  const fileSource = createDirectoryFileSource({
    rootDirectory: config.fileServerDirectory,
    faults: faults.fileServer,
    clock,
  });
  const policy = createAccessPolicy(config.roles);
  const auth = createLocalAuth({ users: repositories.users, clock });
  // 取り込みの解釈の仕様（FormatProfile）は、不変のため、取り込みと設定の参照で共有する
  const profiles = createDefaultFormatProfileRegistry();
  return { repositories, store, faults, mocks, fileSource, policy, auth, profiles };
}

type Adapters = ReturnType<typeof buildAdapters>;

interface ServiceDeps {
  readonly config: AppConfig;
  readonly settings: AppSettings;
  readonly adapters: Adapters;
  readonly logger: Logger;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

/** アプリケーション層のサービスを、アダプタに結び付けて組み立てる。 */
function buildServices({ config, settings, adapters, logger, clock, ids }: ServiceDeps) {
  const { repositories, mocks, fileSource, policy, auth, profiles } = adapters;
  const authService = createAuthService({ auth, policy, logger });

  const criteria = createCriteriaService({ criteria: repositories.criteria });
  const federation = createFederationService({
    federation: repositories.federation,
    port: mocks.federation,
    clock,
    ids,
    settings: settings.federation,
    logger,
  });
  const notificationService = createNotificationService({
    notifications: repositories.notifications,
    pushSubscriptions: repositories.pushSubscriptions,
    webPush: mocks.webPush,
    clock,
    ids,
    settings: settings.notification,
    logger,
  });
  const evaluationService = createEvaluationService({
    repositories,
    criteria,
    notifications: notificationService,
    federation,
    clock,
    settings,
    logger,
  });
  const ingestionSettings = createIngestionSettings(
    repositories.settings,
    settings.defaultIngestionIntervalMinutes,
  );
  const ingestionService = createIngestionService({
    repositories,
    ingestionSettings,
    fileSource,
    profiles,
    evaluation: evaluationService,
    notifications: notificationService,
    federation,
    clock,
    ids,
    settings: settings.ingestion,
    logger,
  });
  const auditService = createAuditService({ auditLogs: repositories.auditLogs, clock, ids });
  const manualEntryService = createManualEntryService({
    repositories,
    audit: auditService,
    evaluation: evaluationService,
    federation,
    clock,
    ids,
    logger,
  });
  const criteriaAdminService = createCriteriaAdminService({
    criteriaService: criteria,
    criteriaRepository: repositories.criteria,
    audit: auditService,
    evaluation: evaluationService,
    clock,
    logger,
  });
  const equipmentService = createEquipmentService({
    equipment: repositories.equipment,
    audit: auditService,
    evaluation: evaluationService,
    clock,
    logger,
  });
  const statusCodeService = createStatusCodeService({
    statusCodes: repositories.statusCodes,
    audit: auditService,
    evaluation: evaluationService,
    logger,
  });
  const userService = createUserService({
    users: repositories.users,
    policy,
    hasher: { hash: hashPassword },
    audit: auditService,
    clock,
    sessions: auth,
    pushSubscriptions: repositories.pushSubscriptions,
  });
  const ingestionAdminService = createIngestionAdminService({
    ingestionSettings,
    ingestion: repositories.ingestion,
    federation: repositories.federation,
    ingestionService,
    profiles,
    audit: auditService,
  });
  const pushSubscriptionService = createPushSubscriptionService({
    subscriptions: repositories.pushSubscriptions,
    clock,
    publicKey: config.webPushPublicKey,
  });
  const jobRunner = createJobRunner({
    ingestion: ingestionService,
    evaluation: evaluationService,
    federation,
    notifications: notificationService,
  });
  const scheduler = createScheduler({ runner: jobRunner, clock, plans: DEFAULT_SCHEDULE, logger });

  return {
    authService,
    criteria,
    notificationService,
    evaluationService,
    ingestionSettings,
    ingestionService,
    auditService,
    manualEntryService,
    criteriaAdminService,
    equipmentService,
    statusCodeService,
    userService,
    ingestionAdminService,
    pushSubscriptionService,
    jobRunner,
    scheduler,
  };
}

type Services = ReturnType<typeof buildServices>;

/** デモの設備と、合成データ（観測値）を入れ、評価する。設備がすでにあれば、何もしない。 */
async function seedDemoData(
  { repositories }: Adapters,
  { evaluationService }: Services,
  settings: AppSettings,
  clock: ClockPort,
): Promise<void> {
  if ((await repositories.equipment.list({ includeDeleted: true })).length > 0) {
    return;
  }
  const now = clock.now();
  for (const equipment of buildDemoEquipment(now)) {
    await repositories.equipment.save(equipment);
  }
  const from = new Date(now.getTime() - DEMO_DAYS * MS_PER_DAY);
  await repositories.observations.saveMany([
    ...generateAutoObservations({
      robotId: DEMO_ROBOT_ID,
      sensorId: DEMO_SENSOR_ID,
      from,
      to: now,
      intervalMinutes: settings.defaultIngestionIntervalMinutes,
      seed: DEMO_SEED,
      temperatureBaseCelsius: DEMO_TEMPERATURE_BASE_CELSIUS,
    }),
    ...generateManualObservations({
      robotId: DEMO_ROBOT_ID,
      at: new Date(now.getTime() - 30 * MS_PER_MINUTE),
      enteredBy: undefined,
    }),
  ]);
  await evaluationService.evaluateAll('SEED');
}

/** 開発用の操作（時計・モックの停止・リセット・観測値の用意）。ローカル・テストのみ。 */
function buildDevControls(
  adapters: Adapters,
  services: Services,
  clock: ControllableClock,
  initialize: (seedMode: SeedMode) => Promise<void>,
): DevApiDeps {
  const { repositories, store, faults, mocks } = adapters;
  const { scheduler, evaluationService } = services;
  return {
    clock,
    faults,
    mocks,
    async reset(seedMode) {
      store.clear();
      scheduler.reset();
      mocks.federation.reset();
      mocks.webPush.reset();
      faults.fileServer.reset();
      faults.federation.reset();
      faults.webPush.reset();
      clock.unfreeze();
      clock.set(new Date());
      await initialize(seedMode === 'EQUIPMENT' ? 'NONE' : seedMode);
      if (seedMode === 'EQUIPMENT') {
        for (const equipment of buildDemoEquipment(clock.now())) {
          await repositories.equipment.save(equipment);
        }
      }
    },
    async seedObservations(observations, evaluate) {
      await repositories.observations.saveMany(observations);
      if (evaluate) {
        await evaluationService.evaluateAll('DEV');
      }
      return observations.length;
    },
  };
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  if (config.mode === 'production' || config.persistence === 'dynamodb') {
    throw new ConfigError('本番用のアダプタ（DynamoDB・Cognito・実ファイルサーバー）は未実装です');
  }

  const logger =
    overrides.logger ?? createJsonLogger({ sink: STDOUT_SINK, minimumLevel: config.logLevel });
  // 時刻を操作できる時計は、開発用 API が有効なときだけ作る（無効なときは、システム時計。V-143）
  const controllableClock =
    overrides.clock ?? (config.devApiEnabled ? createControllableClock() : undefined);
  const clock: ClockPort = controllableClock ?? createSystemClock();
  const ids = overrides.ids ?? createUuidGenerator();
  const settings = buildSettings(config, overrides);

  const adapters = buildAdapters(config, clock, logger);
  const services = buildServices({ config, settings, adapters, logger, clock, ids });
  const { repositories, store, policy } = adapters;

  async function initialize(seedMode: SeedMode = config.seedMode): Promise<void> {
    await seedInitialStatusCodes(repositories.statusCodes);
    if (config.initialUser !== undefined) {
      const created = await ensureInitialUser(repositories.users, config.initialUser, clock.now());
      if (created) {
        logger.info('最初のユーザーを作成しました', { userId: config.initialUser.userId });
      }
    }
    if (seedMode === 'DEMO') {
      await seedDemoData(adapters, services, settings, clock);
    }
  }

  const dev =
    config.devApiEnabled && controllableClock !== undefined
      ? buildDevControls(adapters, services, controllableClock, initialize)
      : undefined;
  if (dev !== undefined) {
    logger.warn('開発用 API が有効です。本番・共有環境では無効にしてください');
  }
  if (config.roles === DEFAULT_ROLE_CONFIG) {
    logger.warn(
      '既定のロール（全利用者が全権限を持つ1ロール）で動作しています。ROLE_DEFINITIONS_JSON で、権限を分けてください',
    );
  }

  return {
    config,
    logger,
    clock,
    repositories,
    policy,
    authService: services.authService,
    equipmentService: services.equipmentService,
    statusCodeService: services.statusCodeService,
    auditService: services.auditService,
    manualEntryService: services.manualEntryService,
    criteriaAdminService: services.criteriaAdminService,
    userService: services.userService,
    ingestionAdminService: services.ingestionAdminService,
    pushSubscriptionService: services.pushSubscriptionService,
    dashboardQuery: createDashboardQuery({
      repositories,
      ingestionSettings: services.ingestionSettings,
      settings,
      clock,
    }),
    viewpointQuery: createViewpointQuery({
      repositories,
      criteria: services.criteria,
      settings,
      clock,
    }),
    observationQuery: createObservationQuery({ repositories }),
    notificationService: services.notificationService,
    evaluationService: services.evaluationService,
    ingestionService: services.ingestionService,
    ingestionSettings: services.ingestionSettings,
    jobRunner: services.jobRunner,
    scheduler: services.scheduler,
    dev,
    trustedProxyHops: config.trustedProxyHops,
    initialize: () => initialize(),
    close() {
      services.scheduler.stop();
      store.flush();
    },
  };
}
