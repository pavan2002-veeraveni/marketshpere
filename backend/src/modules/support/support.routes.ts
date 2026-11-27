import crypto from 'crypto';
import { Router, NextFunction, Request, Response } from 'express';
import { DisputeStatus, Prisma, RoleName, SupportCaseStatus, SupportPriority } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import { recordAuditLog } from '../../common/audit';

const createSupportCaseSchema = z.object({
  body: z.object({
    orderId: z.string().uuid().optional(),
    subject: z.string().trim().min(3).max(200),
    priority: z.nativeEnum(SupportPriority).default(SupportPriority.MEDIUM),
    initialMessage: z.string().trim().min(3).max(3000),
  }),
});

const updateSupportCaseSchema = z.object({
  params: z.object({ caseId: z.string().uuid() }),
  body: z.object({
    status: z.nativeEnum(SupportCaseStatus).optional(),
    priority: z.nativeEnum(SupportPriority).optional(),
    assignedAgentId: z.string().uuid().nullable().optional(),
  }),
});

const addNoteSchema = z.object({
  body: z.object({
    body: z.string().trim().min(1).max(3000),
    isInternal: z.boolean().default(true),
  }),
});

const createDisputeSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    reason: z.string().trim().min(3).max(200),
    details: z.string().trim().max(2000).optional(),
  }),
});

const updateDisputeSchema = z.object({
  params: z.object({ disputeId: z.string().uuid() }),
  body: z.object({
    status: z.nativeEnum(DisputeStatus),
    resolutionSummary: z.string().trim().max(2000).optional(),
  }),
});

export const supportRouter = Router();
supportRouter.use(authenticate);

supportRouter.get('/customers', requireRoles(RoleName.SUPPORT_AGENT, RoleName.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const users = await prisma.user.findMany({
      where: {
        primaryRole: RoleName.CUSTOMER,
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' } },
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        createdAt: true,
        _count: { select: { orders: true, supportCasesOpened: true } },
      },
      take: 30,
    });
    return sendSuccess(req, res, users, 'Customers retrieved');
  } catch (err) {
    next(err);
  }
});

supportRouter.get('/cases', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAgent = req.user!.roles.includes(RoleName.SUPPORT_AGENT) || req.user!.roles.includes(RoleName.ADMIN);
    const cases = await prisma.supportCase.findMany({
      where: isAgent ? {} : { customerId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, email: true, firstName: true, lastName: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        notes: {
          where: isAgent ? {} : { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: { authorUser: { select: { email: true, firstName: true, lastName: true, primaryRole: true } } },
        },
      },
    });
    return sendSuccess(req, res, cases, 'Support cases retrieved');
  } catch (err) {
    next(err);
  }
});

supportRouter.post('/cases', validateRequest(createSupportCaseSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caseNumber = `CASE-${new Date().getFullYear()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const created = await prisma.supportCase.create({
      data: {
        caseNumber,
        customerId: req.user!.userId,
        orderId: req.body.orderId ?? null,
        subject: req.body.subject,
        priority: req.body.priority,
        notes: {
          create: {
            authorUserId: req.user!.userId,
            isInternal: false,
            body: req.body.initialMessage,
          },
        },
      },
      include: { notes: true },
    });
    return sendSuccess(req, res, created, 'Support case opened', 201);
  } catch (err) {
    next(err);
  }
});

supportRouter.patch(
  '/cases/:caseId',
  requireRoles(RoleName.SUPPORT_AGENT, RoleName.ADMIN),
  validateRequest(updateSupportCaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.supportCase.findUnique({ where: { id: req.params.caseId } });
      if (!existing) throw new NotFoundError('Support case not found');
      const updated = await prisma.supportCase.update({
        where: { id: existing.id },
        data: {
          status: req.body.status,
          priority: req.body.priority,
          assignedAgentId: req.body.assignedAgentId !== undefined ? req.body.assignedAgentId : req.user!.userId,
        },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'SUPPORT_CASE_UPDATED',
        resourceType: 'SUPPORT_CASE',
        resourceId: existing.id,
        afterState: req.body,
      });
      return sendSuccess(req, res, updated, 'Support case updated');
    } catch (err) {
      next(err);
    }
  },
);

supportRouter.post('/cases/:caseId/notes', validateRequest(addNoteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const supportCase = await prisma.supportCase.findUnique({ where: { id: req.params.caseId } });
    if (!supportCase) throw new NotFoundError('Support case not found');
    const isAgent = req.user!.roles.includes(RoleName.SUPPORT_AGENT) || req.user!.roles.includes(RoleName.ADMIN);
    if (!isAgent && supportCase.customerId !== req.user!.userId) {
      throw new ForbiddenError('Cannot add note to another customer support case');
    }
    const note = await prisma.supportNote.create({
      data: {
        supportCaseId: supportCase.id,
        authorUserId: req.user!.userId,
        isInternal: isAgent ? req.body.isInternal : false,
        body: req.body.body,
      },
    });
    return sendSuccess(req, res, note, 'Note added', 201);
  } catch (err) {
    next(err);
  }
});

export const disputesRouter = Router();
disputesRouter.use(authenticate);

disputesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAgent = req.user!.roles.includes(RoleName.SUPPORT_AGENT) || req.user!.roles.includes(RoleName.ADMIN);
    const where: Prisma.DisputeWhereInput = isAgent
      ? {}
      : req.user!.roles.includes(RoleName.SELLER) && req.user!.sellerId
        ? { sellerId: req.user!.sellerId }
        : { customerId: req.user!.userId };

    const items = await prisma.dispute.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { orderNumber: true, totalAmount: true, status: true } },
        customer: { select: { email: true, firstName: true, lastName: true } },
        seller: { select: { storeName: true } },
        notes: {
          where: isAgent ? {} : { isInternal: false },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return sendSuccess(req, res, items, 'Disputes retrieved');
  } catch (err) {
    next(err);
  }
});

disputesRouter.post('/', validateRequest(createDisputeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.body.orderId }, include: { items: true } });
    if (!order) throw new NotFoundError('Order not found');
    if (order.customerId !== req.user!.userId) throw new ForbiddenError('Cannot dispute another customer order');
    const sellerId = order.items[0]?.sellerId;
    if (!sellerId) throw new NotFoundError('Order seller not found');

    const created = await prisma.dispute.create({
      data: {
        orderId: order.id,
        customerId: req.user!.userId,
        sellerId,
        reason: req.body.reason,
        notes: req.body.details
          ? {
              create: {
                authorUserId: req.user!.userId,
                isInternal: false,
                body: req.body.details,
              },
            }
          : undefined,
      },
      include: { notes: true },
    });
    return sendSuccess(req, res, created, 'Dispute opened', 201);
  } catch (err) {
    next(err);
  }
});

disputesRouter.patch(
  '/:disputeId',
  requireRoles(RoleName.SUPPORT_AGENT, RoleName.ADMIN),
  validateRequest(updateDisputeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.dispute.findUnique({ where: { id: req.params.disputeId } });
      if (!existing) throw new NotFoundError('Dispute not found');
      const updated = await prisma.dispute.update({
        where: { id: existing.id },
        data: {
          status: req.body.status,
          resolutionSummary: req.body.resolutionSummary,
          assignedAgentId: req.user!.userId,
        },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'DISPUTE_UPDATED',
        resourceType: 'DISPUTE',
        resourceId: existing.id,
        afterState: req.body,
      });
      return sendSuccess(req, res, updated, 'Dispute updated');
    } catch (err) {
      next(err);
    }
  },
);
