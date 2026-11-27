import crypto from 'crypto';
import { Router, NextFunction, Request, Response } from 'express';
import {
  OrderItemFulfillmentStatus,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  RoleName,
  WebhookEventStatus,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../common/errors';
import { recordAuditLog } from '../../common/audit';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { paymentSandboxAdapter, signWebhookPayload } from '../../integrations/payment-sandbox';
import { env } from '../../config/env';
import { inventoryService } from '../inventory/inventory.service';
import { commissionsService } from '../commissions/commissions.routes';
import { logger } from '../../common/logger';
import { enqueueTrackedJob, QUEUE_NAMES } from '../../workers/queues';

export interface PaymentWebhookEventPayload {
  eventId: string;
  eventType: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'REFUND_SUCCEEDED';
  providerPaymentId: string;
  providerRefundId?: string;
  failureCode?: string;
  failureMessage?: string;
  amount?: string;
}

export const paymentsService = {
  /**
   * Idempotent atomic webhook processor for payment and refund events.
   * Prevents duplicate order confirmation, inventory double-deduction, and duplicate refunds.
   */
  async processPaymentWebhook(params: {
    rawPayload: string;
    signatureHeader?: string;
    payload: PaymentWebhookEventPayload;
    requestId?: string;
  }) {
    const signatureValid = paymentSandboxAdapter.verifyPaymentWebhookSignature(
      params.rawPayload,
      params.signatureHeader,
    );
    if (!signatureValid) {
      throw new UnauthorizedError('Invalid webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
    }

    const provider = 'SANDBOX_PAY';

    // Claim event uniquely outside domain transaction so failure records survive rollback
    const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO webhook_events (id, provider, provider_event_id, event_type, signature_valid, payload, status, created_at, updated_at)
      VALUES (gen_random_uuid(), ${provider}, ${params.payload.eventId}, ${params.payload.eventType}, true, ${JSON.stringify(params.payload)}::jsonb, 'RECEIVED', NOW(), NOW())
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;

    const existingEvent = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider, providerEventId: params.payload.eventId } },
    });

    if (inserted.length === 0 && existingEvent.status === WebhookEventStatus.PROCESSED) {
      logger.info(
        { requestId: params.requestId, eventId: params.payload.eventId },
        'Duplicate payment webhook detected; returning idempotent acknowledgement',
      );
      return {
        idempotent: true,
        processed: false,
        eventId: params.payload.eventId,
        status: existingEvent.status,
      };
    }

    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        const lockedEvents = await tx.$queryRaw<Array<{ id: string; status: WebhookEventStatus }>>`
          SELECT id, status FROM webhook_events WHERE id = ${existingEvent.id}::uuid FOR UPDATE
        `;
        if (lockedEvents[0]?.status === WebhookEventStatus.PROCESSED) {
          return {
            idempotent: true,
            processed: false,
            eventId: params.payload.eventId,
            status: WebhookEventStatus.PROCESSED,
          };
        }

        await tx.webhookEvent.update({
          where: { id: existingEvent.id },
          data: { status: WebhookEventStatus.PROCESSING },
        });
        const paymentRows = await tx.$queryRaw<Array<{ id: string; order_id: string; status: PaymentStatus }>>`
          SELECT id, order_id, status
          FROM payments
          WHERE provider_payment_id = ${params.payload.providerPaymentId}
          FOR UPDATE
        `;
        const paymentRow = paymentRows[0];
        if (!paymentRow) {
          throw new NotFoundError(`Payment ${params.payload.providerPaymentId} not found`);
        }

        const orderRows = await tx.$queryRaw<Array<{ id: string; status: OrderStatus; customer_id: string; order_number: string }>>`
          SELECT id, status, customer_id, order_number
          FROM orders
          WHERE id = ${paymentRow.order_id}::uuid
          FOR UPDATE
        `;
        const orderRow = orderRows[0]!;

        // Record PaymentEvent deduplicated by (payment_id, provider_event_id)
        await tx.$executeRaw`
          INSERT INTO payment_events (id, payment_id, event_type, provider_event_id, payload, created_at)
          VALUES (gen_random_uuid(), ${paymentRow.id}::uuid, ${params.payload.eventType}, ${params.payload.eventId}, ${JSON.stringify(params.payload)}::jsonb, NOW())
          ON CONFLICT (payment_id, provider_event_id) DO NOTHING
        `;

        if (params.payload.eventType === 'PAYMENT_SUCCEEDED') {
          if (paymentRow.status !== PaymentStatus.CAPTURED) {
            await tx.payment.update({
              where: { id: paymentRow.id },
              data: {
                status: PaymentStatus.CAPTURED,
                capturedAt: new Date(),
                failureCode: null,
                failureMessage: null,
              },
            });
          }

          if (orderRow.status === OrderStatus.PENDING_PAYMENT) {
            await tx.order.update({
              where: { id: orderRow.id },
              data: { status: OrderStatus.PAYMENT_CONFIRMED },
            });
            await tx.orderItem.updateMany({
              where: { orderId: orderRow.id },
              data: { fulfillmentStatus: OrderItemFulfillmentStatus.ALLOCATED },
            });
            await tx.orderStatusHistory.create({
              data: {
                orderId: orderRow.id,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: OrderStatus.PAYMENT_CONFIRMED,
                reason: `Payment confirmed via webhook ${params.payload.eventId}`,
              },
            });

            await inventoryService.commitOrderReservationsTx(tx, {
              orderId: orderRow.id,
            });
            await commissionsService.calculateAndPersistOrderCommissionsTx(tx, orderRow.id);

            await tx.notification.create({
              data: {
                userId: orderRow.customer_id,
                type: 'PAYMENT_CONFIRMED',
                title: `Payment confirmed for ${orderRow.order_number}`,
                message: `Your payment was captured and order ${orderRow.order_number} is now confirmed.`,
              },
            });
            await tx.outboxEvent.create({
              data: {
                aggregateType: 'ORDER',
                aggregateId: orderRow.id,
                eventType: 'ORDER_PAYMENT_CONFIRMED',
                payload: {
                  orderId: orderRow.id,
                  orderNumber: orderRow.order_number,
                  customerId: orderRow.customer_id,
                },
              },
            });
          }
        } else if (params.payload.eventType === 'PAYMENT_FAILED') {
          if (paymentRow.status !== PaymentStatus.CAPTURED) {
            await tx.payment.update({
              where: { id: paymentRow.id },
              data: {
                status: PaymentStatus.FAILED,
                failureCode: params.payload.failureCode ?? 'SANDBOX_DECLINED',
                failureMessage: params.payload.failureMessage ?? 'Sandbox payment declined',
              },
            });
            await tx.notification.create({
              data: {
                userId: orderRow.customer_id,
                type: 'PAYMENT_FAILED',
                title: `Payment failed for ${orderRow.order_number}`,
                message: params.payload.failureMessage ?? 'Your payment attempt failed. You may retry before reservation expiry.',
              },
            });
          }
        } else if (params.payload.eventType === 'REFUND_SUCCEEDED' && params.payload.providerRefundId) {
          await tx.refund.updateMany({
            where: { providerRefundId: params.payload.providerRefundId, status: { not: RefundStatus.SUCCEEDED } },
            data: { status: RefundStatus.SUCCEEDED, processedAt: new Date() },
          });
        }

        await tx.webhookEvent.update({
          where: { id: existingEvent.id },
          data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date(), lastError: null },
        });

        return {
          idempotent: false,
          processed: true,
          eventId: params.payload.eventId,
          status: WebhookEventStatus.PROCESSED,
        };
      });
    } catch (err) {
      await prisma.webhookEvent.update({
        where: { id: existingEvent.id },
        data: {
          status: WebhookEventStatus.FAILED,
          retryCount: { increment: 1 },
          lastError: err instanceof Error ? err.message : 'Webhook processing failed',
        },
      });
      throw err;
    }

    if (txResult.processed && params.payload.eventType === 'PAYMENT_SUCCEEDED') {
      await enqueueTrackedJob({
        queueName: QUEUE_NAMES.NOTIFICATIONS,
        jobName: 'outbox-dispatch',
        jobId: `outbox-paid-${params.payload.eventId}`,
        payload: {
          providerPaymentId: params.payload.providerPaymentId,
          eventType: 'ORDER_PAYMENT_CONFIRMED',
        },
      });
    }

    return txResult;
  },
};

const confirmSandboxSchema = z.object({
  params: z.object({ paymentId: z.string().uuid() }),
  body: z.object({
    outcome: z.enum(['SUCCEED', 'FAIL']).default('SUCCEED'),
    failureMessage: z.string().max(300).optional(),
  }),
});

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

paymentsRouter.get('/', requireRoles(RoleName.ADMIN, RoleName.SUPPORT_AGENT), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Math.min(100, Number(req.query.limit ?? 20));
    const { skip, take } = getSkipTake(page, limit);
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { orderNumber: true, status: true, customer: { select: { email: true } } } },
          refunds: true,
        },
      }),
      prisma.payment.count(),
    ]);
    return sendSuccess(req, res, items, 'Payments retrieved', 200, { ...buildPaginationMeta(page, limit, total) });
  } catch (err) {
    next(err);
  }
});

paymentsRouter.post(
  '/:paymentId/confirm-sandbox',
  validateRequest(confirmSandboxSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payment = await prisma.payment.findUnique({
        where: { id: req.params.paymentId },
        include: { order: true },
      });
      if (!payment) throw new NotFoundError('Payment not found');
      if (payment.order.customerId !== req.user!.userId && !req.user!.roles.includes(RoleName.ADMIN)) {
        throw new ForbiddenError('Cannot confirm another customer payment');
      }
      if (payment.order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new ConflictError(`Order is already in status ${payment.order.status}`, 'ORDER_NOT_PENDING_PAYMENT');
      }

      const eventPayload: PaymentWebhookEventPayload = {
        eventId: `evt_sbx_${payment.id}_${req.body.outcome}_${Date.now()}`,
        eventType: req.body.outcome === 'SUCCEED' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
        providerPaymentId: payment.providerPaymentId!,
        amount: payment.amount.toString(),
        failureMessage: req.body.failureMessage,
      };
      const rawPayload = JSON.stringify(eventPayload);
      const signature = signWebhookPayload(rawPayload, env.PAYMENT_WEBHOOK_SECRET);

      const outcome = await paymentsService.processPaymentWebhook({
        rawPayload,
        signatureHeader: signature,
        payload: eventPayload,
        requestId: req.requestId,
      });

      const updatedOrder = await prisma.order.findUnique({
        where: { id: payment.orderId },
        include: { payments: true, items: true },
      });

      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: `SANDBOX_PAYMENT_${req.body.outcome}`,
        resourceType: 'PAYMENT',
        resourceId: payment.id,
        requestId: req.requestId,
      });

      return sendSuccess(req, res, { outcome, order: updatedOrder }, 'Sandbox payment processed');
    } catch (err) {
      next(err);
    }
  },
);

paymentsRouter.post('/:paymentId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.paymentId },
      include: { order: true },
    });
    if (!payment) throw new NotFoundError('Payment not found');
    if (payment.order.customerId !== req.user!.userId && !req.user!.roles.includes(RoleName.ADMIN)) {
      throw new ForbiddenError('Cannot retry another customer payment');
    }
    if (payment.status !== PaymentStatus.FAILED) {
      throw new ValidationError('Only failed payments can be retried');
    }
    if (payment.order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictError('Order is no longer awaiting payment');
    }

    const nextIntent = await paymentSandboxAdapter.initiatePayment({
      orderId: payment.orderId,
      orderNumber: payment.order.orderNumber,
      amount: payment.amount.toString(),
      currency: payment.currency,
      idempotencyKey: `retry_${payment.id}_${crypto.randomBytes(4).toString('hex')}`,
      requestId: req.requestId,
    });

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: nextIntent.providerPaymentId,
        status: PaymentStatus.INITIATED,
        failureCode: null,
        failureMessage: null,
      },
    });
    return sendSuccess(req, res, updated, 'Payment retry initiated');
  } catch (err) {
    next(err);
  }
});
