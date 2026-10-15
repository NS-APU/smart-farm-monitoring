/**
 * Repository の DynamoDB 実装（ADR-0007）の組み立て。ポートは application/ports/repositories.ts。
 * 同じ契約テスト（tests/integration/repository-contract.test.ts）を、ローカルの実装と同じく通す。
 * テーブルは、IaC（infra/）で作る。ここでは、作らない。
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Repositories } from '../../application/ports/repositories.ts';
import { createEvaluationRepository } from './evaluation-repository.ts';
import { createFederationRepository, createIngestionRepository } from './ingestion-repositories.ts';
import {
  createCriteriaRepository,
  createEquipmentRepository,
  createSettingsRepository,
  createStatusCodeRepository,
} from './master-data-repositories.ts';
import { createNotificationRepository } from './notification-repository.ts';
import { createObservationRepository } from './observation-repository.ts';
import type { Database } from './operations.ts';
import { createAuditLogRepository, createManualEntryRepository } from './record-repositories.ts';
import type { TableNames } from './table-schema.ts';
import { createPushSubscriptionRepository, createUserRepository } from './user-repositories.ts';

export interface DynamoRepositoriesOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tables: TableNames;
  /** 1 回の操作で読む観測値の上限（既定は 50,000 件）。テストで、下げる。 */
  readonly observationReadLimit?: number;
}

export function createDynamoRepositories(options: DynamoRepositoriesOptions): Repositories {
  const db: Database = { client: options.client, tables: options.tables };
  return {
    equipment: createEquipmentRepository(db),
    statusCodes: createStatusCodeRepository(db),
    criteria: createCriteriaRepository(db),
    observations: createObservationRepository(
      db,
      options.observationReadLimit === undefined ? {} : { readLimit: options.observationReadLimit },
    ),
    evaluations: createEvaluationRepository(db),
    notifications: createNotificationRepository(db),
    ingestion: createIngestionRepository(db),
    federation: createFederationRepository(db),
    auditLogs: createAuditLogRepository(db),
    manualEntries: createManualEntryRepository(db),
    users: createUserRepository(db),
    pushSubscriptions: createPushSubscriptionRepository(db),
    settings: createSettingsRepository(db),
  };
}
