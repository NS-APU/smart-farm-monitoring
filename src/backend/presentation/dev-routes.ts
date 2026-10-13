/**
 * 開発用 API（`/api/v1/dev/*`）。ローカル・テストのみ登録し、本番では登録しない。
 * AWS なしで、E2E・負荷テストを動かすための操作: 時計の固定・進行、スケジューラ・ジョブの手動起動、
 * モック（ファイルサーバー・農業情報基盤・Web Push）の停止・遅延の再現、データのリセット。
 * ログイン済みであれば使える（権限は設けない。本番にはない API のため）。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '@smart-farm/shared/errors';
import {
  EquipmentIdSchema,
  IsoDateTimeSchema,
  ObservationQualitySchema,
  ObservationSourceSchema,
} from '@smart-farm/shared/schemas/common';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { JOB_IDS, isJobId } from '../application/jobs/job-runner.ts';
import { DEV_SEED_MODES } from '../application/seed/seed-modes.ts';
import { FAULT_MODES, type FaultController } from '../infrastructure/local/faults.ts';
import {
  MAX_EXPANDED_OBSERVATIONS,
  buildSeededObservation,
  expandSeededSeries,
} from '../infrastructure/local/synthetic-data.ts';
import type { ApiDeps, AppEnv, DevApiDeps } from './api-deps.ts';
import { authenticateRequest } from './auth-guards.ts';
import { parseJsonBody, parseOptionalJsonBody } from './request-parsing.ts';

/** NONE: 空／DEMO: デモの設備・合成データ／EQUIPMENT: デモの設備のみ（観測値は /dev/observations で用意する）。 */
const ResetBodySchema = z.object({ seed: z.enum(DEV_SEED_MODES).default('NONE') });
const SeededValueSchema = z.union([z.number(), z.string(), z.null()]);
const SeededObservationSchema = z.object({
  equipmentId: EquipmentIdSchema,
  itemKey: z.string().min(1).max(100),
  observedAt: IsoDateTimeSchema,
  value: SeededValueSchema,
  source: ObservationSourceSchema.default('AUTO_IMPORT'),
  quality: ObservationQualitySchema.default('VALID'),
  receivedAt: IsoDateTimeSchema.optional(),
});
const SeededSeriesSchema = z.object({
  equipmentId: EquipmentIdSchema,
  itemKey: z.string().min(1).max(100),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  intervalMinutes: z.number().int().min(1),
  value: SeededValueSchema,
  source: ObservationSourceSchema.default('AUTO_IMPORT'),
  quality: ObservationQualitySchema.default('VALID'),
});
const SeedObservationsBodySchema = z.object({
  observations: z.array(SeededObservationSchema).max(5000).default([]),
  series: z.array(SeededSeriesSchema).max(200).default([]),
  /** 保存後に、評価を更新するか（取り込み・手動入力の保存後と同じ）。 */
  evaluate: z.boolean().default(true),
});
const ClockBodySchema = z.object({
  /** FREEZE: 固定／RUNNING: 実時間で進める。 */
  mode: z.enum(['FREEZE', 'RUNNING']).optional(),
  at: IsoDateTimeSchema.optional(),
});
const AdvanceBodySchema = z.object({ minutes: z.number() });
const FaultBodySchema = z.object({
  mode: z.enum(FAULT_MODES).optional(),
  delayMs: z.number().int().min(0).optional(),
});

function clockState(dev: DevApiDeps): { now: string; frozen: boolean } {
  return { now: dev.clock.now().toISOString(), frozen: dev.clock.isFrozen() };
}

export function createDevRoutes(deps: ApiDeps, dev: DevApiDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use(async (c, next) => {
    await authenticateRequest(c, deps.authService);
    await next();
  });

  routes.post('/reset', async (c) => {
    const body = await parseOptionalJsonBody(c, ResetBodySchema);
    await dev.reset(body.seed);
    return c.body(null, 204);
  });

  routes.post('/observations', async (c) => {
    const body = await parseJsonBody(c, SeedObservationsBodySchema);
    const rows = [
      ...body.observations.map(({ receivedAt, ...item }) =>
        buildSeededObservation({
          ...item,
          observedAt: new Date(item.observedAt),
          ...(receivedAt === undefined ? {} : { receivedAt: new Date(receivedAt) }),
        }),
      ),
      ...body.series.flatMap((item) =>
        expandSeededSeries({ ...item, from: new Date(item.from), to: new Date(item.to) }),
      ),
    ];
    if (rows.length > MAX_EXPANDED_OBSERVATIONS) {
      throw new AppError('VALIDATION_ERROR', '観測値が多すぎます');
    }
    return c.json({ saved: await dev.seedObservations(rows, body.evaluate) });
  });

  routes.get('/clock', (c) => c.json(clockState(dev)));

  routes.put('/clock', async (c) => {
    const body = await parseJsonBody(c, ClockBodySchema);
    if (body.at !== undefined) {
      dev.clock.set(new Date(body.at));
    }
    if (body.mode === 'FREEZE') {
      dev.clock.freeze();
    } else if (body.mode === 'RUNNING') {
      dev.clock.unfreeze();
    }
    return c.json(clockState(dev));
  });

  routes.post('/clock/advance', async (c) => {
    const body = await parseJsonBody(c, AdvanceBodySchema);
    dev.clock.advance(body.minutes * MS_PER_MINUTE);
    return c.json(clockState(dev));
  });

  routes.post('/scheduler/tick', async (c) => c.json({ executed: await deps.scheduler.tick() }));

  routes.post('/jobs/:jobId/run', async (c) => {
    const jobId = c.req.param('jobId');
    if (!isJobId(jobId)) {
      throw new AppError('NOT_FOUND', `ジョブが見つかりません（${JOB_IDS.join('、')}）`);
    }
    return c.json(await deps.jobRunner.run(jobId));
  });

  const mockTargets = new Map<string, FaultController>([
    ['file-server', dev.faults.fileServer],
    ['federation', dev.faults.federation],
    ['web-push', dev.faults.webPush],
  ]);
  routes.put('/mocks/:target', async (c) => {
    const controller = mockTargets.get(c.req.param('target'));
    if (controller === undefined) {
      throw new AppError('NOT_FOUND', 'モックが見つかりません');
    }
    const body = await parseJsonBody(c, FaultBodySchema);
    return c.json(
      controller.set(
        omitUndefined({
          mode: body.mode,
          delayMs: body.delayMs,
        }),
      ),
    );
  });

  routes.get('/mocks/federation/received', (c) =>
    c.json({ items: dev.mocks.federation.received() }),
  );
  routes.get('/mocks/web-push/delivered', (c) => c.json({ items: dev.mocks.webPush.delivered() }));

  return routes;
}
