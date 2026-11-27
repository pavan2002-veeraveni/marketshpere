import crypto from 'crypto';
import { Router, NextFunction, Request, Response } from 'express';
import { CommissionLedgerStatus, Prisma, RoleName, SettlementStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, NotFoundError } from '../../common/errors';
import { addMoney, maxMoney } from '../../common/decimal';
import { recordAuditLog } from '../../common/audit';
import { enqueueTrackedJob, QUEUE_NAMES } from '../../workers/queues';

const generateSettlementSchema = z.object({
  body: z.object({
    sellerId: z.string().uuid().optional(),
    periodStart: z.coerce.date().default(() => new Date(Date.now() - 30 * 86400_000)),
    periodEnd: z.coerce.date().default(() => new Date()),
    async: z.boolean().optional().default(false),
  }),
});

export const settlementsService = {
  async generateSettlements(params: {
    sellerId?: string;
    periodStart: Date;
    periodEnd: Date;
    actorUserId?: string;
  }) {
    const ledgers = await prisma.commissionLedger.findMany({
      where: {
        status: CommissionLedgerStatus.EARNED,
        settlementItem: null,
        ...(params.sellerId ? { sellerId: params.sellerId } : {}),
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
    });

    if (ledgers.length === 0) {
      return [];
    }

    const bySeller = new Map<string, typeof ledgers>();
    for (const l of ledgers) {
      const list = bySeller.get(l.sellerId) ?? [];
      list.push(l);
      bySeller.set(l.sellerId, list);
    }

    const createdSettlements = [];

    for (const [sellerId, sellerLedgers] of bySeller.entries()) {
      const settlement = await prisma.$transaction(async (tx) => {
        const grossSales = addMoney(...sellerLedgers.map((l) => l.grossAmount.toString()));
        const totalCommissions = addMoney(...sellerLedgers.map((l) => l.commissionAmount.toString()));
        const netPayout = maxMoney('0.00', addMoney(...sellerLedgers.map((l) => l.netSellerAmount.toString())));

        const settlementNumber = `STL-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const created = await tx.settlement.create({
          data: {
            settlementNumber,
            sellerId,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
            grossSales: grossSales.toFixed(2),
            totalCommissions: totalCommissions.toFixed(2),
            totalRefunds: '0.00',
            netPayout: netPayout.toFixed(2),
            status: SettlementStatus.PENDING_APPROVAL,
            items: {
              create: sellerLedgers.map((l) => ({
                commissionLedgerId: l.id,
                amount: l.netSellerAmount,
              })),
            },
          },
          include: { items: true, seller: { select: { storeName: true } } },
        });

        await tx.commissionLedger.updateMany({
          where: { id: { in: sellerLedgers.map((l) => l.id) } },
          data: { status: CommissionLedgerStatus.SETTLED },
        });

        await recordAuditLog(tx, {
          actorUserId: params.actorUserId ?? null,
          actorRole: params.actorUserId ? RoleName.ADMIN : 'WORKER',
          action: 'SETTLEMENT_GENERATED',
          resourceType: 'SETTLEMENT',
          resourceId: created.id,
          afterState: { settlementNumber, netPayout: netPayout.toFixed(2) },
        });

        return created;
      });
      createdSettlements.push(settlement);
    }

    return createdSettlements;
  },
};

export const settlementsRouter = Router();
settlementsRouter.use(authenticate, requireRoles(RoleName.SELLER, RoleName.ADMIN));

settlementsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: Prisma.SettlementWhereInput = req.user!.roles.includes(RoleName.ADMIN)
      ? {}
      : { sellerId: req.user!.sellerId ?? '__none__' };

    const items = await prisma.settlement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        seller: { select: { id: true, storeName: true } },
        _count: { select: { items: true } },
      },
    });
    return sendSuccess(req, res, items, 'Settlements retrieved');
  } catch (err) {
    next(err);
  }
});

settlementsRouter.post(
  '/generate',
  requireRoles(RoleName.ADMIN),
  validateRequest(generateSettlementSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.body.async) {
        const queued = await enqueueTrackedJob({
          queueName: QUEUE_NAMES.SETTLEMENTS,
          jobName: 'settlement-batch',
          jobId: `stl-batch-${Date.now()}`,
          payload: {
            sellerId: req.body.sellerId,
            periodStart: req.body.periodStart.toISOString(),
            periodEnd: req.body.periodEnd.toISOString(),
          },
        });
        return sendSuccess(req, res, { queued: true, ...queued }, 'Settlement batch queued', 202);
      }

      const settlements = await settlementsService.generateSettlements({
        sellerId: req.body.sellerId,
        periodStart: req.body.periodStart,
        periodEnd: req.body.periodEnd,
        actorUserId: req.user!.userId,
      });
      return sendSuccess(req, res, settlements, `Generated ${settlements.length} settlement statement(s)`, 201);
    } catch (err) {
      next(err);
    }
  },
);

settlementsRouter.patch(
  '/:settlementId/approve',
  requireRoles(RoleName.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settlement = await prisma.settlement.findUnique({
        where: { id: req.params.settlementId },
        include: { seller: { select: { userId: true } } },
      });
      if (!settlement) throw new NotFoundError('Settlement not found');
      if (settlement.status === SettlementStatus.PAID) {
        throw new ConflictError('Settlement has already been paid');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const s = await tx.settlement.update({
          where: { id: settlement.id },
          data: {
            status: SettlementStatus.PAID,
            approvedByUserId: req.user!.userId,
            paidAt: new Date(),
          },
        });
        await tx.notification.create({
          data: {
            userId: settlement.seller.userId,
            type: 'SETTLEMENT_PAID',
            title: `Settlement ${settlement.settlementNumber} paid`,
            message: `Payout of $${settlement.netPayout.toString()} has been approved and settled.`,
          },
        });
        await recordAuditLog(tx, {
          actorUserId: req.user!.userId,
          actorRole: RoleName.ADMIN,
          action: 'SETTLEMENT_APPROVED_PAID',
          resourceType: 'SETTLEMENT',
          resourceId: settlement.id,
          requestId: req.requestId,
        });
        return s;
      });
      return sendSuccess(req, res, updated, 'Settlement approved and paid');
    } catch (err) {
      next(err);
    }
  },
);
