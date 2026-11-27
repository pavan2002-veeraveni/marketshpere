import { Router, NextFunction, Request, Response } from 'express';
import { Prisma, RoleName, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { NotFoundError } from '../../common/errors';
import { addMoney } from '../../common/decimal';
import { recordAuditLog } from '../../common/audit';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { emailSandboxAdapter } from '../../integrations/email-sandbox';
import { enqueueTrackedJob } from '../../workers/queues';
import { executeTrackedJobByName, isRegisteredJobName, WORKER_JOB_REGISTRY } from '../../workers/processors';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRoles(RoleName.ADMIN));

adminRouter.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      usersCount,
      sellersTotal,
      sellersPending,
      productsActive,
      orders,
      commissions,
      openDisputes,
      pendingReturns,
      lowStockItems,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.seller.count(),
      prisma.seller.count({ where: { onboardingStatus: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
      prisma.product.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      prisma.order.findMany({ select: { status: true, totalAmount: true } }),
      prisma.commissionLedger.findMany({ select: { commissionAmount: true, netSellerAmount: true } }),
      prisma.dispute.count({ where: { status: { in: ['OPEN', 'INVESTIGATING', 'ESCALATED'] } } }),
      prisma.returnRequest.count({ where: { status: { in: ['REQUESTED', 'SELLER_REVIEW', 'ESCALATED'] } } }),
      prisma.inventory.findMany({ select: { onHandQty: true, reservedQty: true, reorderPoint: true } }),
    ]);

    const nonCancelledOrders = orders.filter((o) => o.status !== 'CANCELLED');
    const gmv = addMoney(...nonCancelledOrders.map((o) => o.totalAmount.toString()));
    const totalCommission = addMoney(...commissions.map((c) => c.commissionAmount.toString()));
    const lowStockCount = lowStockItems.filter((i) => i.onHandQty - i.reservedQty <= i.reorderPoint).length;

    const ordersByStatus = orders.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {});

    return sendSuccess(req, res, {
      usersCount,
      sellersTotal,
      sellersPending,
      productsActive,
      ordersCount: orders.length,
      gmv: gmv.toFixed(2),
      totalCommission: totalCommission.toFixed(2),
      openDisputes,
      pendingReturns,
      lowStockCount,
      ordersByStatus,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Math.min(100, Number(req.query.limit ?? 20));
    const { skip, take } = getSkipTake(page, limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          primaryRole: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    return sendSuccess(req, res, items, 'Users retrieved', 200, { ...buildPaginationMeta(page, limit, total) });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch(
  '/users/:userId/status',
  validateRequest(
    z.object({
      params: z.object({ userId: z.string().uuid() }),
      body: z.object({ status: z.nativeEnum(UserStatus) }),
    }),
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.user.findUnique({ where: { id: req.params.userId } });
      if (!existing) throw new NotFoundError('User not found');
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: { status: req.body.status },
        select: { id: true, email: true, status: true, primaryRole: true },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: RoleName.ADMIN,
        action: 'USER_STATUS_UPDATED',
        resourceType: 'USER',
        resourceId: existing.id,
        beforeState: { status: existing.status },
        afterState: { status: updated.status },
      });
      return sendSuccess(req, res, updated, 'User status updated');
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get('/audit-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Math.min(100, Number(req.query.limit ?? 30));
    const { skip, take } = getSkipTake(page, limit);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { actorUser: { select: { email: true, primaryRole: true } } },
      }),
      prisma.auditLog.count(),
    ]);
    return sendSuccess(req, res, items, 'Audit logs retrieved', 200, { ...buildPaginationMeta(page, limit, total) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/webhooks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.webhookEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return sendSuccess(req, res, items, 'Webhook events retrieved');
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.backgroundJobRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return sendSuccess(req, res, items, 'Background job records retrieved');
  } catch (err) {
    next(err);
  }
});

const triggerJobSchema = z.object({
  body: z.object({
    jobName: z.enum([
      'reservation-expiry-sweep',
      'outbox-dispatch',
      'low-stock-alerts',
      'payment-reconciliation',
      'failed-webhook-recovery',
      'shipping-status-callback',
      'settlement-batch',
    ]),
    payload: z.record(z.unknown()).default({}),
    executeNow: z.boolean().default(true),
  }),
});

adminRouter.post('/jobs/trigger', validateRequest(triggerJobSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobName = req.body.jobName as keyof typeof WORKER_JOB_REGISTRY;
    const queueName = WORKER_JOB_REGISTRY[jobName].queueName;
    const jobId = `manual-${jobName}-${Date.now()}`;
    const payload = (req.body.payload ?? {}) as Record<string, unknown>;

    await enqueueTrackedJob({
      queueName,
      jobName,
      jobId,
      payload,
    });

    let jobRecord = await prisma.backgroundJobRecord.findUniqueOrThrow({
      where: { queueName_jobId: { queueName, jobId } },
    });

    if (req.body.executeNow !== false) {
      await executeTrackedJobByName(jobName, jobId, payload, queueName);
      jobRecord = await prisma.backgroundJobRecord.findUniqueOrThrow({
        where: { queueName_jobId: { queueName, jobId } },
      });
    }

    await recordAuditLog(prisma, {
      actorUserId: req.user!.userId,
      actorRole: RoleName.ADMIN,
      action: 'BACKGROUND_JOB_TRIGGERED',
      resourceType: 'BACKGROUND_JOB_RECORD',
      resourceId: jobRecord.id,
      requestId: req.requestId,
      afterState: { jobName, status: jobRecord.status },
    });

    return sendSuccess(req, res, jobRecord, `Job ${jobName} ${jobRecord.status.toLowerCase()}`, 201);
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/jobs/:jobId/replay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await prisma.backgroundJobRecord.findUnique({ where: { id: req.params.jobId } });
    if (!job) throw new NotFoundError('Job record not found');

    const executeNow = req.body?.executeNow === true;
    const payload = (job.payload && typeof job.payload === 'object' ? job.payload : {}) as Record<string, unknown>;

    await enqueueTrackedJob({
      queueName: job.queueName,
      jobName: job.jobName,
      jobId: job.jobId,
      payload,
    });

    if (executeNow && isRegisteredJobName(job.jobName)) {
      await executeTrackedJobByName(job.jobName, job.jobId, payload, job.queueName);
    }

    const updated = await prisma.backgroundJobRecord.findUniqueOrThrow({ where: { id: job.id } });
    await recordAuditLog(prisma, {
      actorUserId: req.user!.userId,
      actorRole: RoleName.ADMIN,
      action: 'BACKGROUND_JOB_REPLAY_QUEUED',
      resourceType: 'BACKGROUND_JOB_RECORD',
      resourceId: job.id,
      requestId: req.requestId,
      afterState: { status: updated.status, executeNow },
    });
    return sendSuccess(req, res, updated, executeNow ? 'Job replayed and executed' : 'Job marked for replay');
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configs = await prisma.systemConfig.findMany({ orderBy: { key: 'asc' } });
    return sendSuccess(req, res, configs, 'System configuration retrieved');
  } catch (err) {
    next(err);
  }
});

adminRouter.put(
  '/config/:key',
  validateRequest(
    z.object({
      params: z.object({ key: z.string().min(2).max(120) }),
      body: z.object({
        value: z.record(z.unknown()),
        description: z.string().max(255).optional(),
      }),
    }),
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.systemConfig.upsert({
        where: { key: req.params.key! },
        update: {
          value: req.body.value,
          description: req.body.description,
          updatedByUserId: req.user!.userId,
        },
        create: {
          key: req.params.key!,
          value: req.body.value,
          description: req.body.description,
          updatedByUserId: req.user!.userId,
        },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: RoleName.ADMIN,
        action: 'SYSTEM_CONFIG_UPDATED',
        resourceType: 'SYSTEM_CONFIG',
        resourceId: updated.key,
        afterState: updated.value,
      });
      return sendSuccess(req, res, updated, 'System configuration updated');
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get('/sandbox-emails', async (req: Request, res: Response) => {
  return sendSuccess(req, res, emailSandboxAdapter.getRecentSandboxEmails(), 'Sandbox emails retrieved');
});
