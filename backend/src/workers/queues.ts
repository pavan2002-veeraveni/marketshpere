import { Queue, JobsOptions } from 'bullmq';
import { BackgroundJobStatus, Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../common/prisma';
import { logger } from '../common/logger';
import { ensureRedisReady } from '../common/redis';

export const QUEUE_NAMES = {
  COMMERCE_MAINTENANCE: 'marketsphere-maintenance',
  NOTIFICATIONS: 'marketsphere-notifications',
  FEED_IMPORT: 'marketsphere-feed-import',
  SETTLEMENTS: 'marketsphere-settlements',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
};

function parseRedisConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
    connectTimeout: 400,
    enableOfflineQueue: false,
    retryStrategy(times: number) {
      if (times > 1) return null;
      return 150;
    },
  };
}

export const bullConnection = parseRedisConnection();

let queuesInitialized: Record<string, Queue> | null = null;

export function getQueues() {
  if (!queuesInitialized) {
    queuesInitialized = {
      [QUEUE_NAMES.COMMERCE_MAINTENANCE]: new Queue(QUEUE_NAMES.COMMERCE_MAINTENANCE, {
        connection: bullConnection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      [QUEUE_NAMES.NOTIFICATIONS]: new Queue(QUEUE_NAMES.NOTIFICATIONS, {
        connection: bullConnection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      [QUEUE_NAMES.FEED_IMPORT]: new Queue(QUEUE_NAMES.FEED_IMPORT, {
        connection: bullConnection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      [QUEUE_NAMES.SETTLEMENTS]: new Queue(QUEUE_NAMES.SETTLEMENTS, {
        connection: bullConnection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    };
  }
  return queuesInitialized;
}

export async function enqueueTrackedJob(params: {
  queueName: QueueName | string;
  jobName: string;
  jobId: string;
  payload: Record<string, unknown>;
  delayMs?: number;
}) {
  await prisma.backgroundJobRecord.upsert({
    where: {
      queueName_jobId: { queueName: params.queueName, jobId: params.jobId },
    },
    update: {
      status: BackgroundJobStatus.QUEUED,
      payload: params.payload as Prisma.InputJsonValue,
      errorMessage: null,
    },
    create: {
      queueName: params.queueName,
      jobId: params.jobId,
      jobName: params.jobName,
      status: BackgroundJobStatus.QUEUED,
      payload: params.payload as Prisma.InputJsonValue,
    },
  });

  const redisReady = await ensureRedisReady();
  if (!redisReady) {
    return { enqueued: false, persistedInDb: true, jobId: params.jobId };
  }

  try {
    const queue = getQueues()[params.queueName];
    if (!queue) {
      return { enqueued: false, persistedInDb: true, jobId: params.jobId };
    }
    await Promise.race([
      queue.add(params.jobName, params.payload, {
        jobId: params.jobId,
        delay: params.delayMs,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('BullMQ enqueue timeout')), 500)),
    ]);
    return { enqueued: true, persistedInDb: true, jobId: params.jobId };
  } catch (err) {
    logger.warn(
      { queueName: params.queueName, jobId: params.jobId, err: err instanceof Error ? err.message : String(err) },
      'Failed to push job to Redis queue; persisted in background_job_records for replay',
    );
    return { enqueued: false, persistedInDb: true, jobId: params.jobId };
  }
}

export async function closeQueues() {
  if (!queuesInitialized) return;
  await Promise.all(Object.values(queuesInitialized).map((q) => q.close()));
  queuesInitialized = null;
}
