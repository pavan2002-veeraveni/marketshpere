import { Router, Request, Response } from 'express';
import { prisma } from '../../common/prisma';
import { pingRedis } from '../../common/redis';
import { sendSuccess } from '../../common/response';
import { renderPrometheusMetrics } from '../../common/metrics';
import { env } from '../../config/env';

async function checkDependencies(requestId?: string) {
  let dbHealthy = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }

  const redisHealthy = await pingRedis(false);

  let pythonHealthy = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${env.PYTHON_SERVICE_URL}/api/v1/health`, {
      signal: controller.signal,
      headers: requestId ? { 'x-request-id': requestId } : undefined,
    });
    clearTimeout(timer);
    pythonHealthy = resp.ok;
  } catch {
    pythonHealthy = false;
  }

  return { dbHealthy, redisHealthy, pythonHealthy };
}

export const healthRouter = Router();

healthRouter.get('/', async (req: Request, res: Response) => {
  const { dbHealthy, redisHealthy, pythonHealthy } = await checkDependencies(req.requestId);
  const allHealthy = dbHealthy && redisHealthy && pythonHealthy;
  const overallStatus = allHealthy ? 'ok' : 'degraded';
  const strict = req.query.strict === 'true';
  const httpStatus = !dbHealthy || (strict && !allHealthy) ? 503 : 200;

  return sendSuccess(
    req,
    res,
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: {
        postgres: dbHealthy ? 'up' : 'down',
        redis: redisHealthy ? 'up' : 'down',
        pythonService: pythonHealthy ? 'up' : 'down',
      },
    },
    allHealthy ? 'Service healthy' : dbHealthy ? 'Service degraded' : 'Database unavailable',
    httpStatus,
  );
});

healthRouter.get('/metrics', async (req: Request, res: Response) => {
  const { dbHealthy, redisHealthy, pythonHealthy } = await checkDependencies(req.requestId);
  let outboxPending = 0;
  const jobCounts: Record<string, number> = {
    QUEUED: 0,
    ACTIVE: 0,
    COMPLETED: 0,
    FAILED: 0,
    DEAD_LETTER: 0,
  };

  if (dbHealthy) {
    try {
      const [pendingCount, groupedJobs] = await Promise.all([
        prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
        prisma.backgroundJobRecord.groupBy({ by: ['status'], _count: { status: true } }),
      ]);
      outboxPending = pendingCount;
      for (const row of groupedJobs) {
        jobCounts[row.status] = row._count.status;
      }
    } catch {
      // Keep default metrics on transient read failure
    }
  }

  const body = renderPrometheusMetrics({
    postgresUp: dbHealthy,
    redisUp: redisHealthy,
    pythonUp: pythonHealthy,
    outboxPending,
    jobCounts,
  });

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return res.status(200).send(body);
});
