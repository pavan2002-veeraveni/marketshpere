import { Router, NextFunction, Request, Response } from 'express';
import { CommissionLedgerStatus, OrderItemFulfillmentStatus, OrderStatus, Prisma, RoleName } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { recordAuditLog } from '../../common/audit';
import { inventoryService } from '../inventory/inventory.service';

export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: [OrderStatus.PAYMENT_CONFIRMED, OrderStatus.CANCELLED],
  PAYMENT_CONFIRMED: [OrderStatus.PROCESSING, OrderStatus.CANCELLED, OrderStatus.REFUND_PENDING],
  PROCESSING: [OrderStatus.READY_TO_SHIP, OrderStatus.CANCELLED],
  READY_TO_SHIP: [OrderStatus.SHIPPED],
  SHIPPED: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  OUT_FOR_DELIVERY: [OrderStatus.DELIVERED],
  DELIVERED: [OrderStatus.RETURN_REQUESTED],
  CANCELLED: [OrderStatus.REFUND_PENDING],
  RETURN_REQUESTED: [OrderStatus.RETURN_APPROVED, OrderStatus.DELIVERED],
  RETURN_APPROVED: [OrderStatus.RETURNED],
  RETURNED: [OrderStatus.REFUND_PENDING],
  REFUND_PENDING: [OrderStatus.REFUNDED],
  REFUNDED: [],
};

export function assertOrderTransitionAllowed(fromStatus: OrderStatus, toStatus: OrderStatus): void {
  const allowed = ALLOWED_ORDER_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new ConflictError(
      `Invalid order state transition from ${fromStatus} to ${toStatus}`,
      'INVALID_ORDER_TRANSITION',
    );
  }
}

const transitionOrderSchema = z.object({
  params: z.object({ orderId: z.string().uuid() }),
  body: z.object({
    toStatus: z.nativeEnum(OrderStatus),
    reason: z.string().trim().max(500).optional(),
  }),
});

const cancelOrderSchema = z.object({
  params: z.object({ orderId: z.string().uuid() }),
  body: z.object({
    reason: z.string().trim().max(500).default('Cancelled by requester'),
  }),
});

export const ordersService = {
  async listOrders(
    query: { page: number; limit: number; status?: OrderStatus; search?: string },
    caller: { userId: string; roles: RoleName[]; sellerId?: string | null },
  ) {
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { customer: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const isElevated =
      caller.roles.includes(RoleName.ADMIN) ||
      caller.roles.includes(RoleName.SUPPORT_AGENT) ||
      caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);

    if (!isElevated) {
      if (caller.roles.includes(RoleName.SELLER) && caller.sellerId) {
        where.items = { some: { sellerId: caller.sellerId } };
      } else {
        where.customerId = caller.userId;
      }
    }

    const { skip, take } = getSkipTake(query.page, query.limit);
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { id: true, email: true, firstName: true, lastName: true } },
          items:
            !isElevated && caller.roles.includes(RoleName.SELLER) && caller.sellerId
              ? { where: { sellerId: caller.sellerId } }
              : true,
          payments: { select: { id: true, status: true, amount: true, providerPaymentId: true } },
          shipments: true,
        },
      }),
      prisma.order.count({ where }),
    ]);

    return { items: orders, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async getOrderDetail(
    orderId: string,
    caller: { userId: string; roles: RoleName[]; sellerId?: string | null },
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, email: true, firstName: true, lastName: true } },
        items: {
          include: {
            warehouse: { select: { id: true, code: true, name: true } },
            seller: { select: { id: true, storeName: true } },
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        reservations: true,
        payments: { include: { events: true, refunds: true } },
        shipments: { include: { events: { orderBy: { occurredAt: 'desc' } } } },
        returns: { include: { items: true, refunds: true } },
      },
    });
    if (!order) throw new NotFoundError('Order not found');

    const isElevated =
      caller.roles.includes(RoleName.ADMIN) ||
      caller.roles.includes(RoleName.SUPPORT_AGENT) ||
      caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);

    if (!isElevated) {
      if (caller.roles.includes(RoleName.SELLER) && caller.sellerId) {
        const sellerItems = order.items.filter((i) => i.sellerId === caller.sellerId);
        if (sellerItems.length === 0) {
          throw new ForbiddenError('Order does not contain items from your seller store', 'SELLER_ISOLATION_VIOLATION');
        }
        const sellerSkuIds = new Set(sellerItems.map((i) => i.skuId));
        return {
          ...order,
          items: sellerItems,
          shipments: order.shipments.filter((s) => s.sellerId === caller.sellerId),
          returns: order.returns.filter((r) => r.sellerId === caller.sellerId),
          reservations: order.reservations.filter((r) => sellerSkuIds.has(r.skuId)),
        };
      }
      if (order.customerId !== caller.userId) {
        throw new ForbiddenError('You cannot access another customer order', 'ORDER_PRIVACY_VIOLATION');
      }
    }

    return order;
  },

  async transitionOrderStatus(
    orderId: string,
    toStatus: OrderStatus,
    reason: string | undefined,
    caller: { userId: string; roles: RoleName[]; sellerId?: string | null },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('Order not found');

    const isPrivileged =
      caller.roles.includes(RoleName.ADMIN) || caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);
    if (!isPrivileged) {
      if (caller.roles.includes(RoleName.SELLER) && caller.sellerId) {
        const ownsAnyItem = order.items.some((i) => i.sellerId === caller.sellerId);
        if (!ownsAnyItem) throw new ForbiddenError('Not authorized for this order');
        const hasOtherSellerItems = order.items.some((i) => i.sellerId !== caller.sellerId);
        if (hasOtherSellerItems && toStatus !== OrderStatus.PROCESSING && toStatus !== OrderStatus.READY_TO_SHIP) {
          throw new ForbiddenError('Multi-seller order lifecycle transitions require warehouse or admin review');
        }
      } else {
        throw new ForbiddenError('Insufficient role to transition order status');
      }
    }

    assertOrderTransitionAllowed(order.status, toStatus);

    return prisma.$transaction(async (tx) => {
      if (toStatus === OrderStatus.CANCELLED) {
        await inventoryService.releaseOrderReservationsTx(tx, {
          orderId,
          actorUserId: caller.userId,
          reason,
        });
        await tx.commissionLedger.updateMany({
          where: {
            orderId,
            status: { in: [CommissionLedgerStatus.PENDING, CommissionLedgerStatus.EARNED] },
          },
          data: { status: CommissionLedgerStatus.REVERSED },
        });
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: toStatus,
          cancelledAt: toStatus === OrderStatus.CANCELLED ? new Date() : undefined,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus,
          reason: reason ?? `Transitioned to ${toStatus}`,
          changedByUserId: caller.userId,
        },
      });

      if (toStatus === OrderStatus.PROCESSING || toStatus === OrderStatus.READY_TO_SHIP) {
        await tx.orderItem.updateMany({
          where: {
            orderId,
            ...(caller.roles.includes(RoleName.SELLER) && caller.sellerId ? { sellerId: caller.sellerId } : {}),
          },
          data: {
            fulfillmentStatus:
              toStatus === OrderStatus.READY_TO_SHIP
                ? OrderItemFulfillmentStatus.READY_TO_SHIP
                : OrderItemFulfillmentStatus.PICKING,
          },
        });
      }

      await recordAuditLog(tx, {
        actorUserId: caller.userId,
        actorRole: caller.roles[0],
        action: 'ORDER_STATUS_TRANSITION',
        resourceType: 'ORDER',
        resourceId: orderId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        beforeState: { status: order.status },
        afterState: { status: toStatus, reason },
      });

      return updated;
    });
  },

  async cancelOrder(
    orderId: string,
    reason: string,
    caller: { userId: string; roles: RoleName[] },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw new NotFoundError('Order not found');

    const isAdmin = caller.roles.includes(RoleName.ADMIN) || caller.roles.includes(RoleName.SUPPORT_AGENT);
    if (!isAdmin && order.customerId !== caller.userId) {
      throw new ForbiddenError('Cannot cancel another customer order');
    }

    if (
      order.status !== OrderStatus.PENDING_PAYMENT &&
      order.status !== OrderStatus.PAYMENT_CONFIRMED &&
      order.status !== OrderStatus.PROCESSING
    ) {
      throw new ValidationError(`Order in status ${order.status} can no longer be cancelled directly`);
    }

    return prisma.$transaction(async (tx) => {
      await inventoryService.releaseOrderReservationsTx(tx, {
        orderId,
        actorUserId: caller.userId,
        reason,
      });

      await tx.commissionLedger.updateMany({
        where: {
          orderId,
          status: { in: [CommissionLedgerStatus.PENDING, CommissionLedgerStatus.EARNED] },
        },
        data: { status: CommissionLedgerStatus.REVERSED },
      });

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          reason,
          changedByUserId: caller.userId,
        },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'ORDER',
          aggregateId: orderId,
          eventType: 'ORDER_CANCELLED',
          payload: { orderNumber: order.orderNumber, customerId: order.customerId, reason },
        },
      });

      await recordAuditLog(tx, {
        actorUserId: caller.userId,
        actorRole: caller.roles[0],
        action: 'ORDER_CANCELLED',
        resourceType: 'ORDER',
        resourceId: orderId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        beforeState: { status: order.status },
        afterState: { status: OrderStatus.CANCELLED, reason },
      });

      return updated;
    });
  },
};

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Math.min(100, Number(req.query.limit ?? 20));
    const status = req.query.status as OrderStatus | undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const result = await ordersService.listOrders(
      { page, limit, status, search },
      { userId: req.user!.userId, roles: req.user!.roles, sellerId: req.user!.sellerId },
    );
    return sendSuccess(req, res, result.items, 'Orders retrieved', 200, { ...result.meta });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await ordersService.getOrderDetail(req.params.orderId!, {
      userId: req.user!.userId,
      roles: req.user!.roles,
      sellerId: req.user!.sellerId,
    });
    return sendSuccess(req, res, order, 'Order details retrieved');
  } catch (err) {
    next(err);
  }
});

ordersRouter.post('/:orderId/cancel', validateRequest(cancelOrderSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await ordersService.cancelOrder(
      req.params.orderId!,
      req.body.reason,
      { userId: req.user!.userId, roles: req.user!.roles },
      { requestId: req.requestId, ipAddress: req.ip },
    );
    return sendSuccess(req, res, updated, 'Order cancelled');
  } catch (err) {
    next(err);
  }
});

ordersRouter.patch(
  '/:orderId/status',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(transitionOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await ordersService.transitionOrderStatus(
        req.params.orderId!,
        req.body.toStatus,
        req.body.reason,
        { userId: req.user!.userId, roles: req.user!.roles, sellerId: req.user!.sellerId },
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, updated, 'Order status updated');
    } catch (err) {
      next(err);
    }
  },
);
