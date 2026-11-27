import crypto from 'crypto';
import { Router, NextFunction, Request, Response } from 'express';
import {
  CommissionLedgerStatus,
  InventoryMovementType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ReturnStatus,
  RoleName,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { addMoney, money } from '../../common/decimal';
import { recordAuditLog } from '../../common/audit';
import { paymentSandboxAdapter } from '../../integrations/payment-sandbox';

const createReturnSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    reason: z.string().trim().min(3).max(160),
    description: z.string().trim().max(2000).optional(),
    evidenceMetadata: z.record(z.unknown()).optional(),
    items: z
      .array(
        z.object({
          orderItemId: z.string().uuid(),
          quantity: z.coerce.number().int().positive(),
        }),
      )
      .min(1),
  }),
});

const returnDecisionSchema = z.object({
  params: z.object({ returnId: z.string().uuid() }),
  body: z.object({
    status: z.enum([
      ReturnStatus.SELLER_REVIEW,
      ReturnStatus.ESCALATED,
      ReturnStatus.APPROVED,
      ReturnStatus.REJECTED,
      ReturnStatus.RECEIVED,
    ]),
    resolutionNotes: z.string().trim().max(1000).optional(),
    restockInventory: z.boolean().default(false),
  }),
});

const createRefundSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    returnId: z.string().uuid().optional(),
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: z.string().trim().min(6).max(160).optional(),
  }),
});

export const returnsRouter = Router();
returnsRouter.use(authenticate);

returnsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isElevated = req.user!.roles.includes(RoleName.ADMIN) || req.user!.roles.includes(RoleName.SUPPORT_AGENT);
    const where: Prisma.ReturnRequestWhereInput = isElevated
      ? {}
      : req.user!.roles.includes(RoleName.SELLER) && req.user!.sellerId
        ? { sellerId: req.user!.sellerId }
        : { customerId: req.user!.userId };

    const items = await prisma.returnRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { orderNumber: true, status: true, totalAmount: true } },
        seller: { select: { storeName: true } },
        customer: { select: { email: true, firstName: true, lastName: true } },
        items: { include: { orderItem: true } },
        refunds: true,
      },
    });
    return sendSuccess(req, res, items, 'Return requests retrieved');
  } catch (err) {
    next(err);
  }
});

returnsRouter.post('/', validateRequest(createReturnSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.body.orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('Order not found');
    if (order.customerId !== req.user!.userId) {
      throw new ForbiddenError('Cannot request return for another customer order');
    }
    if (order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.RETURN_REQUESTED) {
      throw new ValidationError(`Order in status ${order.status} is not eligible for return`);
    }

    const orderItemMap = new Map(order.items.map((i) => [i.id, i]));
    const firstOrderItem = orderItemMap.get(req.body.items[0].orderItemId);
    if (!firstOrderItem) throw new ValidationError('Invalid order item for return');

    for (const reqItem of req.body.items) {
      const oi = orderItemMap.get(reqItem.orderItemId);
      if (!oi) throw new ValidationError(`Order item ${reqItem.orderItemId} does not belong to order`);
      if (reqItem.quantity > oi.quantity) {
        throw new ValidationError(`Return quantity exceeds purchased quantity for ${oi.skuCodeSnapshot}`);
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const ret = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          customerId: req.user!.userId,
          sellerId: firstOrderItem.sellerId,
          status: ReturnStatus.REQUESTED,
          reason: req.body.reason,
          description: req.body.description,
          evidenceMetadata: req.body.evidenceMetadata ?? {},
          items: {
            create: req.body.items.map((i: { orderItemId: string; quantity: number }) => ({
              orderItemId: i.orderItemId,
              quantity: i.quantity,
            })),
          },
        },
        include: { items: true },
      });

      if (order.status === OrderStatus.DELIVERED) {
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.RETURN_REQUESTED } });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.DELIVERED,
            toStatus: OrderStatus.RETURN_REQUESTED,
            reason: `Return requested: ${req.body.reason}`,
            changedByUserId: req.user!.userId,
          },
        });
      }

      await recordAuditLog(tx, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'RETURN_REQUESTED',
        resourceType: 'RETURN',
        resourceId: ret.id,
        requestId: req.requestId,
      });

      return ret;
    });

    return sendSuccess(req, res, created, 'Return request submitted', 201);
  } catch (err) {
    next(err);
  }
});

returnsRouter.patch(
  '/:returnId/decision',
  requireRoles(RoleName.SELLER, RoleName.SUPPORT_AGENT, RoleName.ADMIN),
  validateRequest(returnDecisionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ret = await prisma.returnRequest.findUnique({
        where: { id: req.params.returnId },
        include: { order: true, items: { include: { orderItem: true } } },
      });
      if (!ret) throw new NotFoundError('Return request not found');

      const isElevated =
        req.user!.roles.includes(RoleName.ADMIN) || req.user!.roles.includes(RoleName.SUPPORT_AGENT);
      if (!isElevated && ret.sellerId !== req.user!.sellerId) {
        throw new ForbiddenError('Cannot review return for another seller');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const nextRet = await tx.returnRequest.update({
          where: { id: ret.id },
          data: {
            status: req.body.status,
            resolutionNotes: req.body.resolutionNotes,
            reviewedByUserId: req.user!.userId,
          },
        });

        if (req.body.status === ReturnStatus.APPROVED && ret.order.status === OrderStatus.RETURN_REQUESTED) {
          await tx.order.update({ where: { id: ret.orderId }, data: { status: OrderStatus.RETURN_APPROVED } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: ret.orderId,
              fromStatus: ret.order.status,
              toStatus: OrderStatus.RETURN_APPROVED,
              reason: req.body.resolutionNotes ?? 'Return approved',
              changedByUserId: req.user!.userId,
            },
          });
        } else if (req.body.status === ReturnStatus.REJECTED && ret.order.status === OrderStatus.RETURN_REQUESTED) {
          await tx.order.update({ where: { id: ret.orderId }, data: { status: OrderStatus.DELIVERED } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: ret.orderId,
              fromStatus: ret.order.status,
              toStatus: OrderStatus.DELIVERED,
              reason: req.body.resolutionNotes ?? 'Return rejected',
              changedByUserId: req.user!.userId,
            },
          });
        } else if (req.body.status === ReturnStatus.RECEIVED) {
          await tx.order.update({ where: { id: ret.orderId }, data: { status: OrderStatus.RETURNED } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: ret.orderId,
              fromStatus: ret.order.status,
              toStatus: OrderStatus.RETURNED,
              reason: 'Returned merchandise received by warehouse',
              changedByUserId: req.user!.userId,
            },
          });

          if (req.body.restockInventory) {
            for (const item of ret.items) {
              const inv = await tx.inventory.findUnique({
                where: {
                  skuId_warehouseId: {
                    skuId: item.orderItem.skuId,
                    warehouseId: item.orderItem.warehouseId,
                  },
                },
              });
              if (inv) {
                const updatedInv = await tx.inventory.update({
                  where: { id: inv.id },
                  data: { onHandQty: { increment: item.quantity }, version: { increment: 1 } },
                });
                await tx.inventoryLedger.create({
                  data: {
                    inventoryId: inv.id,
                    skuId: item.orderItem.skuId,
                    warehouseId: item.orderItem.warehouseId,
                    movementType: InventoryMovementType.RETURN_RESTOCK,
                    quantityDelta: item.quantity,
                    balanceAfter: updatedInv.onHandQty - updatedInv.reservedQty,
                    referenceType: 'RETURN_RECEIVED',
                    referenceId: ret.id,
                    actorUserId: req.user!.userId,
                  },
                });
              }
            }
          }
        }

        await tx.notification.create({
          data: {
            userId: ret.customerId,
            type: 'RETURN_STATUS_UPDATED',
            title: `Return status updated to ${req.body.status}`,
            message: req.body.resolutionNotes ?? `Your return for order ${ret.order.orderNumber} is now ${req.body.status}.`,
          },
        });

        await recordAuditLog(tx, {
          actorUserId: req.user!.userId,
          actorRole: req.user!.roles[0],
          action: 'RETURN_DECISION',
          resourceType: 'RETURN',
          resourceId: ret.id,
          requestId: req.requestId,
          afterState: { status: req.body.status, resolutionNotes: req.body.resolutionNotes },
        });

        return nextRet;
      });

      return sendSuccess(req, res, updated, 'Return decision recorded');
    } catch (err) {
      next(err);
    }
  },
);

export const refundsRouter = Router();
refundsRouter.use(authenticate, requireRoles(RoleName.SUPPORT_AGENT, RoleName.ADMIN));

refundsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.refund.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        order: { select: { orderNumber: true, totalAmount: true, status: true } },
        payment: { select: { providerPaymentId: true, amount: true, status: true } },
      },
    });
    return sendSuccess(req, res, items, 'Refunds retrieved');
  } catch (err) {
    next(err);
  }
});

refundsRouter.post('/', validateRequest(createRefundSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idempotencyKey =
      req.header('idempotency-key') ?? req.body.idempotencyKey ?? `ref_${req.body.orderId}_${crypto.randomUUID()}`;

    const existingByIdem = await prisma.refund.findUnique({ where: { idempotencyKey } });
    if (existingByIdem) {
      return sendSuccess(req, res, existingByIdem, 'Refund retrieved idempotently');
    }

    const requestedAmount = money(req.body.amount);
    if (requestedAmount.lte(0)) {
      throw new ValidationError('Refund amount must be positive');
    }

    const created = await prisma.$transaction(async (tx) => {
      const paymentRows = await tx.$queryRaw<
        Array<{ id: string; provider_payment_id: string | null; amount: Prisma.Decimal; status: PaymentStatus }>
      >`
        SELECT id, provider_payment_id, amount, status
        FROM payments
        WHERE order_id = ${req.body.orderId}::uuid
          AND status IN ('CAPTURED', 'PARTIALLY_REFUNDED')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `;
      const payment = paymentRows[0];
      if (!payment) {
        throw new ConflictError('No captured payment eligible for refund on this order', 'NO_CAPTURED_PAYMENT');
      }

      const existingRefunds = await tx.refund.findMany({
        where: {
          paymentId: payment.id,
          status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
        },
      });
      const alreadyRefunded = addMoney(...existingRefunds.map((r) => r.amount.toString()));
      const paidAmount = money(payment.amount.toString());

      if (alreadyRefunded.plus(requestedAmount).gt(paidAmount)) {
        throw new ConflictError(
          `Requested refund ($${requestedAmount.toFixed(2)}) exceeds remaining refundable balance ($${paidAmount.minus(alreadyRefunded).toFixed(2)})`,
          'REFUND_EXCEEDS_PAYMENT',
        );
      }

      if (req.body.returnId) {
        const duplicateForReturn = await tx.refund.findFirst({
          where: { returnId: req.body.returnId, status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] } },
        });
        if (duplicateForReturn) {
          throw new ConflictError('Refund already processed for this return request', 'DUPLICATE_RETURN_REFUND');
        }
      }

      const gatewayResp = await paymentSandboxAdapter.issueRefund({
        providerPaymentId: payment.provider_payment_id ?? payment.id,
        amount: requestedAmount.toFixed(2),
        idempotencyKey,
        requestId: req.requestId,
      });

      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: req.body.orderId,
          returnId: req.body.returnId ?? null,
          providerRefundId: gatewayResp.providerRefundId,
          idempotencyKey,
          amount: requestedAmount.toFixed(2),
          status: RefundStatus.SUCCEEDED,
          reason: req.body.reason,
          processedAt: new Date(gatewayResp.processedAt),
        },
      });

      const totalAfterRefund = alreadyRefunded.plus(requestedAmount);
      const isFullRefund = totalAfterRefund.gte(paidAmount);

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED },
      });

      const order = await tx.order.findUniqueOrThrow({ where: { id: req.body.orderId } });
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.REFUNDED,
          reason: `Refund processed ($${requestedAmount.toFixed(2)}): ${req.body.reason}`,
          changedByUserId: req.user!.userId,
        },
      });

      if (req.body.returnId) {
        await tx.returnRequest.update({
          where: { id: req.body.returnId },
          data: { status: ReturnStatus.REFUNDED },
        });
      }

      if (isFullRefund) {
        await tx.commissionLedger.updateMany({
          where: { orderId: order.id, status: { in: [CommissionLedgerStatus.PENDING, CommissionLedgerStatus.EARNED] } },
          data: { status: CommissionLedgerStatus.REVERSED },
        });
      }

      await tx.notification.create({
        data: {
          userId: order.customerId,
          type: 'REFUND_PROCESSED',
          title: `Refund processed for ${order.orderNumber}`,
          message: `A refund of $${requestedAmount.toFixed(2)} has been issued.`,
        },
      });

      await recordAuditLog(tx, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'REFUND_PROCESSED',
        resourceType: 'REFUND',
        resourceId: refund.id,
        requestId: req.requestId,
        afterState: { amount: requestedAmount.toFixed(2), orderId: order.id },
      });

      return refund;
    });

    return sendSuccess(req, res, created, 'Refund processed', 201);
  } catch (err) {
    next(err);
  }
});
