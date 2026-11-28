import { Router, NextFunction, Request, Response } from 'express';
import { CommissionLedgerStatus, CommissionType, Prisma, RoleName } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { NotFoundError } from '../../common/errors';
import { addMoney, maxMoney, minMoney, money, mulMoney } from '../../common/decimal';
import { recordAuditLog } from '../../common/audit';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { pythonClient } from '../../integrations/python-client';

const createRuleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(150),
    sellerId: z.string().uuid().nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    commissionType: z.nativeEnum(CommissionType).default(CommissionType.PERCENTAGE),
    percentageRate: z.string().regex(/^\d+(\.\d{1,4})?$/).default('0.1000'),
    fixedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0.00'),
    priority: z.coerce.number().int().default(50),
    isActive: z.boolean().default(true),
  }),
});

export interface PrecomputedCommissionLine {
  grossAmount: string;
  discountAllocated: string;
  commissionAmount: string;
  netSellerAmount: string;
  commissionRuleId: string | null;
}

export const commissionsService = {
  async previewOrderCommissionsViaPython(
    orderId: string,
    requestId?: string,
  ): Promise<Map<string, PrecomputedCommissionLine>> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: { select: { categoryId: true } },
            seller: { select: { id: true, commissionRateOverride: true } },
          },
        },
      },
    });
    if (!order || order.items.length === 0) return new Map();

    const activeRules = await prisma.commissionRule.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });

    const calcResp = await pythonClient.calculateCommissions({
      items: order.items.map((item) => ({
        orderItemId: item.id,
        sellerId: item.sellerId,
        categoryId: item.product.categoryId,
        unitPrice: item.unitPrice.toString(),
        quantity: item.quantity,
        discountAmount: item.discountAmount.toString(),
        sellerRateOverride:
          item.seller.commissionRateOverride !== null && item.seller.commissionRateOverride !== undefined
            ? item.seller.commissionRateOverride.toString()
            : null,
      })),
      rules: activeRules.map((r) => ({
        ruleId: r.id,
        name: r.name,
        sellerId: r.sellerId,
        categoryId: r.categoryId,
        commissionType: r.commissionType,
        percentageRate: r.percentageRate.toString(),
        fixedAmount: r.fixedAmount.toString(),
        priority: r.priority,
      })),
      requestId,
    });

    const map = new Map<string, PrecomputedCommissionLine>();
    for (const resLine of calcResp.items) {
      const orderItem = order.items.find((i) => i.id === resLine.orderItemId);
      const matchedRule = orderItem
        ? activeRules.find((r) => r.name === resLine.appliedRule) ??
          activeRules.find((r) => r.sellerId === orderItem.sellerId && r.categoryId === orderItem.product.categoryId) ??
          activeRules.find((r) => r.sellerId === orderItem.sellerId && !r.categoryId) ??
          activeRules.find((r) => !r.sellerId && r.categoryId === orderItem.product.categoryId) ??
          activeRules.find((r) => !r.sellerId && !r.categoryId)
        : undefined;
      map.set(resLine.orderItemId, {
        grossAmount: resLine.netCommissionableAmount,
        discountAllocated: resLine.discountAllocated,
        commissionAmount: resLine.commissionAmount,
        netSellerAmount: resLine.netSellerAmount,
        commissionRuleId: matchedRule?.id ?? null,
      });
    }
    return map;
  },

  async calculateAndPersistOrderCommissionsTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    precomputed?: Map<string, PrecomputedCommissionLine>,
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: { select: { categoryId: true } },
            seller: { select: { id: true, commissionRateOverride: true } },
          },
        },
      },
    });
    if (!order) return [];

    const activeRules = precomputed
      ? []
      : await tx.commissionRule.findMany({
          where: { isActive: true },
          orderBy: { priority: 'asc' },
        });

    const createdLedgers = [];
    for (const item of order.items) {
      const existing = await tx.commissionLedger.findUnique({ where: { orderItemId: item.id } });
      if (existing) {
        createdLedgers.push(existing);
        continue;
      }

      const pre = precomputed?.get(item.id);
      if (pre) {
        const ledger = await tx.commissionLedger.create({
          data: {
            orderId: order.id,
            orderItemId: item.id,
            sellerId: item.sellerId,
            commissionRuleId: pre.commissionRuleId,
            grossAmount: pre.grossAmount,
            discountAllocated: pre.discountAllocated,
            commissionAmount: pre.commissionAmount,
            netSellerAmount: pre.netSellerAmount,
            status: CommissionLedgerStatus.EARNED,
          },
        });
        createdLedgers.push(ledger);
        continue;
      }

      const matchingRule =
        activeRules.find((r) => r.sellerId === item.sellerId && r.categoryId === item.product.categoryId) ??
        activeRules.find((r) => r.sellerId === item.sellerId && !r.categoryId) ??
        activeRules.find((r) => !r.sellerId && r.categoryId === item.product.categoryId) ??
        activeRules.find((r) => !r.sellerId && !r.categoryId);

      const grossBeforeDiscount = mulMoney(item.unitPrice.toString(), item.quantity);
      const discountAllocated = money(item.discountAmount.toString());
      const netBase = maxMoney('0.00', grossBeforeDiscount.minus(discountAllocated));

      let commissionAmount = money('0.00');
      if (item.seller.commissionRateOverride !== null && item.seller.commissionRateOverride !== undefined) {
        commissionAmount = mulMoney(netBase, item.seller.commissionRateOverride.toString());
      } else if (matchingRule) {
        const pctPart =
          matchingRule.commissionType === CommissionType.FIXED
            ? money('0.00')
            : mulMoney(netBase, matchingRule.percentageRate.toString());
        const fixedPart =
          matchingRule.commissionType === CommissionType.PERCENTAGE
            ? money('0.00')
            : mulMoney(matchingRule.fixedAmount.toString(), item.quantity);
        commissionAmount = addMoney(pctPart, fixedPart);
      } else {
        commissionAmount = mulMoney(netBase, '0.1000');
      }

      commissionAmount = minMoney(commissionAmount, netBase);
      const netSellerAmount = maxMoney('0.00', netBase.minus(commissionAmount));

      const ledger = await tx.commissionLedger.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          sellerId: item.sellerId,
          commissionRuleId: matchingRule?.id ?? null,
          grossAmount: netBase.toFixed(2),
          discountAllocated: discountAllocated.toFixed(2),
          commissionAmount: commissionAmount.toFixed(2),
          netSellerAmount: netSellerAmount.toFixed(2),
          status: CommissionLedgerStatus.EARNED,
        },
      });
      createdLedgers.push(ledger);
    }

    return createdLedgers;
  },
};

export const commissionsRouter = Router();
commissionsRouter.use(authenticate);

commissionsRouter.get(
  '/rules',
  requireRoles(RoleName.ADMIN, RoleName.SELLER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.roles.includes(RoleName.ADMIN);
      const where: Prisma.CommissionRuleWhereInput = isAdmin
        ? {}
        : {
            isActive: true,
            OR: [{ sellerId: null }, { sellerId: req.user!.sellerId ?? '__none__' }],
          };
      const rules = await prisma.commissionRule.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        include: {
          seller: { select: { id: true, storeName: true } },
          category: { select: { id: true, name: true } },
        },
      });
      return sendSuccess(req, res, rules, 'Commission rules retrieved');
    } catch (err) {
      next(err);
    }
  },
);

commissionsRouter.post(
  '/rules',
  requireRoles(RoleName.ADMIN),
  validateRequest(createRuleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rule = await prisma.commissionRule.create({ data: req.body });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: RoleName.ADMIN,
        action: 'COMMISSION_RULE_CREATED',
        resourceType: 'COMMISSION_RULE',
        resourceId: rule.id,
        afterState: rule,
      });
      return sendSuccess(req, res, rule, 'Commission rule created', 201);
    } catch (err) {
      next(err);
    }
  },
);

commissionsRouter.patch(
  '/rules/:ruleId',
  requireRoles(RoleName.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.commissionRule.findUnique({ where: { id: req.params.ruleId } });
      if (!existing) throw new NotFoundError('Commission rule not found');
      const updated = await prisma.commissionRule.update({
        where: { id: existing.id },
        data: {
          isActive: typeof req.body.isActive === 'boolean' ? req.body.isActive : undefined,
          percentageRate: req.body.percentageRate ?? undefined,
          fixedAmount: req.body.fixedAmount ?? undefined,
          priority: typeof req.body.priority === 'number' ? req.body.priority : undefined,
        },
      });
      return sendSuccess(req, res, updated, 'Commission rule updated');
    } catch (err) {
      next(err);
    }
  },
);

commissionsRouter.post(
  '/calculate',
  requireRoles(RoleName.ADMIN, RoleName.SELLER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const activeRules = await prisma.commissionRule.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      });
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      const result = await pythonClient.calculateCommissions({
        items,
        rules: activeRules.map((r) => ({
          ruleId: r.id,
          name: r.name,
          sellerId: r.sellerId,
          categoryId: r.categoryId,
          commissionType: r.commissionType,
          percentageRate: r.percentageRate.toString(),
          fixedAmount: r.fixedAmount.toString(),
          priority: r.priority,
        })),
        requestId: req.requestId,
      });
      return sendSuccess(req, res, result, 'Commission preview calculated');
    } catch (err) {
      next(err);
    }
  },
);

commissionsRouter.get(
  '/ledger',
  requireRoles(RoleName.SELLER, RoleName.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Number(req.query.page ?? 1);
      const limit = Math.min(100, Number(req.query.limit ?? 20));
      const { skip, take } = getSkipTake(page, limit);

      const where: Prisma.CommissionLedgerWhereInput = {};
      if (!req.user!.roles.includes(RoleName.ADMIN)) {
        where.sellerId = req.user!.sellerId ?? '__none__';
      } else if (typeof req.query.sellerId === 'string') {
        where.sellerId = req.query.sellerId;
      }

      const [items, total] = await Promise.all([
        prisma.commissionLedger.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            order: { select: { orderNumber: true, status: true } },
            orderItem: { select: { productTitleSnapshot: true, skuCodeSnapshot: true, quantity: true } },
            seller: { select: { storeName: true } },
          },
        }),
        prisma.commissionLedger.count({ where }),
      ]);
      return sendSuccess(req, res, items, 'Commission ledger retrieved', 200, {
        ...buildPaginationMeta(page, limit, total),
      });
    } catch (err) {
      next(err);
    }
  },
);
