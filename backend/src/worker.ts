import { Worker, Job } from 'bullmq';
import { logger } from './common/logger';
import { prisma } from './common/prisma';
import { closeRedis } from './common/redis';
import { bullConnection, closeQueues, getQueues, QUEUE_NAMES } from './workers/queues';
import {
  executeTrackedJobByName,
  isRegisteredJobName,
  runWithJobTracking,
} from './workers/processors';

const workers: Worker[] = [];

async function registerRepeatableJobs() {
  const maintenanceQueue = getQueues()[QUEUE_NAMES.COMMERCE_MAINTENANCE]!;
  await maintenanceQueue.add(
    'reservation-expiry-sweep',
    {},
    { jobId: 'repeatable-reservation-expiry', repeat: { every: 60_000 } },
  );
  await maintenanceQueue.add(
    'outbox-dispatch',
    {},
    { jobId: 'repeatable-outbox-dispatch', repeat: { every: 15_000 } },
  );
  await maintenanceQueue.add(
    'low-stock-alerts',
    {},
    { jobId: 'repeatable-low-stock-alerts', repeat: { every: 300_000 } },
  );
  await maintenanceQueue.add(
    'payment-reconciliation',
    {},
    { jobId: 'repeatable-payment-reconciliation', repeat: { every: 300_000 } },
  );
  await maintenanceQueue.add(
    'failed-webhook-recovery',
    {},
    { jobId: 'repeatable-failed-webhook-recovery', repeat: { every: 180_000 } },
  );

  const settlementQueue = getQueues()[QUEUE_NAMES.SETTLEMENTS]!;
  await settlementQueue.add(
    'settlement-batch',
    {},
    { jobId: 'repeatable-settlement-batch', repeat: { every: 3_600_000 } },
  );
}

async function handleQueueJob(queueName: string, job: Job) {
  const payload = (job.data ?? {}) as Record<string, unknown>;
  const jobId = job.id ?? `${job.name}-${Date.now()}`;
  if (isRegisteredJobName(job.name)) {
    return executeTrackedJobByName(job.name, jobId, payload, queueName);
  }
  return runWithJobTracking(queueName, jobId, job.name, payload, async () => ({ ignored: true }));
}

function startWorkers() {
  const queueConfigs: Array<{ name: string; concurrency: number }> = [
    { name: QUEUE_NAMES.COMMERCE_MAINTENANCE, concurrency: 2 },
    { name: QUEUE_NAMES.FEED_IMPORT, concurrency: 2 },
    { name: QUEUE_NAMES.SETTLEMENTS, concurrency: 1 },
    { name: QUEUE_NAMES.NOTIFICATIONS, concurrency: 4 },
  ];

  for (const cfg of queueConfigs) {
    const w = new Worker(
      cfg.name,
      async (job: Job) => handleQueueJob(cfg.name, job),
      { connection: bullConnection, concurrency: cfg.concurrency },
    );
    w.on('failed', (job, err) => {
      logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'BullMQ job failed');
    });
    workers.push(w);
  }
}

async function main() {
  startWorkers();
  await registerRepeatableJobs();
  logger.info('MarketSphere BullMQ background workers started');
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down BullMQ workers');
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await prisma.$disconnect();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Worker startup error');
  process.exit(1);
});
