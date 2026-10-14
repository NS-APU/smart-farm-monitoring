/**
 * Repository のローカル実装（インメモリ＋ファイル永続化）の組み立て。ポートは application/ports/repositories.ts。
 * 集約ごとの実装は repositories/ にある。検索・絞り込み・ページ分割は、サーバー側（そこ）で行う（FR-4.2.1, FR-6.8）。
 * DynamoDB の実装は、同じ契約テスト（tests/integration/repository-contract）を通す形で後から追加する。
 */

import { ObservationSchema, observationKey } from '@smart-farm/shared/schemas/observation';
import type { Repositories } from '../../application/ports/repositories.ts';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './local-store.ts';
import { createEvaluationRepository } from './repositories/evaluation-repository.ts';
import {
  createFederationRepository,
  createIngestionRepository,
} from './repositories/ingestion-repositories.ts';
import {
  createCriteriaRepository,
  createEquipmentRepository,
  createSettingsRepository,
  createStatusCodeRepository,
} from './repositories/master-data-repositories.ts';
import { createNotificationRepository } from './repositories/notification-repository.ts';
import { createObservationRepository } from './repositories/observation-repository.ts';
import {
  createAuditLogRepository,
  createManualEntryRepository,
} from './repositories/record-repositories.ts';
import {
  createPushSubscriptionRepository,
  createUserRepository,
} from './repositories/user-repositories.ts';

export interface LocalRepositories {
  readonly repositories: Repositories;
  readonly store: LocalStore;
}

export function createLocalRepositories(options: LocalStoreOptions = {}): LocalRepositories {
  const store = createLocalStore(options);

  // コレクションの登録の順序は、ファイルへ書き出す順序になる（そのため、組み立ての順序を保つ）
  const equipment = createEquipmentRepository(store);
  const statusCodes = createStatusCodeRepository(store);
  const criteria = createCriteriaRepository(store);
  // 観測値は、設備ごとの索引を持つ。読み込み・全消去で、索引を作り直す
  const observations = createObservationRepository(
    store.collection('observations', ObservationSchema, observationKey),
  );

  const ingestion = createIngestionRepository(store);

  const repositories: Repositories = {
    equipment,
    statusCodes,
    criteria,
    observations: observations.repository,
    evaluations: createEvaluationRepository(store),
    notifications: createNotificationRepository(store),
    ingestion: ingestion.repository,
    federation: createFederationRepository(store),
    auditLogs: createAuditLogRepository(store),
    manualEntries: createManualEntryRepository(store),
    users: createUserRepository(store),
    pushSubscriptions: createPushSubscriptionRepository(store),
    settings: createSettingsRepository(store),
  };

  const originalLoad = store.load.bind(store);
  const originalClear = store.clear.bind(store);
  return {
    repositories,
    store: {
      ...store,
      load() {
        originalLoad();
        observations.resetIndex();
        observations.buildIndexes();
        ingestion.resetIndex();
      },
      clear() {
        originalClear();
        observations.resetIndex();
        ingestion.resetIndex();
      },
    },
  };
}
