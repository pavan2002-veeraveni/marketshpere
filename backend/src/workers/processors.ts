import crypto from 'crypto';
import { BackgroundJobStatus, OutboxEventStatus, PaymentStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { prisma } from '../common/prisma';
import { logger } from '../common/logger';
import { emailSandboxAdapter } from '../integrations/email-sandbox';
import { inventoryService } from '../modules/inventory/inventory.service';
import { settlementsService } from '../modules/settlements/settlements.routes';
import { catalogService } from '../modules/catalog/catalog.service';
import { commissionsService } from '../modules/commissions/commissions.routes';
import { paymentsService, PaymentWebhookEventPayload } from '../modules/payments/payments.routes';
import { shippingService } from '../modules/shipping/shipping.routes';
import { signWebhookPayload } from '../integrations/payment-sandbox';
import { env } from '../config/env';
import { QUEUE_NAMES, QueueName } from './queues';

export async function runWithJobTracking(
  queueName: string,
  jobId: string,
  jobName: string,
  payload: Record<string, unknown>,
  fn: () => Promise<Record<string, unknown>>,
) {
  await prisma.backgroundJobRecord.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    update: {
      status: BackgroundJobStatus.ACTIVE,
      attempts: { increment: 1 },
      lastAttemptedAt: new Date(),
    },
    create: {
      queueName,
      jobId,
      jobName,
      status: BackgroundJobStatus.ACTIVE,
      attempts: 1,
      payload: payload as Prisma.InputJsonValue,
      lastAttemptedAt: new Date(),
    },
  });

  try {
    const result = await fn();
    const updated = await prisma.backgroundJobRecord.update({
      where: { queueName_jobId: { queueName, jobId } },
      data: {
        status: BackgroundJobStatus.COMPLETED,
        result: result as Prisma.InputJsonValue,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    return { ...result, _jobRecord: updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const existing = await prisma.backgroundJobRecord.findUnique({
      where: { queueName_jobId: { queueName, jobId } },
    });
    const nextStatus =
      existing && existing.attempts >= 3 ? BackgroundJobStatus.DEAD_LETTER : BackgroundJobStatus.FAILED;

    await prisma.backgroundJobRecord.update({
      where: { queueName_jobId: { queueName, jobId } },
      data: {
        status: nextStatus,
        errorMessage: message,
      },
    });
    throw err;
  }
}

export interface ShippingCallbackPayload {
  eventId?: string;
  trackingNumber: string;
  status: ShipmentStatus;
  location?: string;
  description?: string;
  failedReason?: string;
}

export const workerProcessors = {
  async processReservationExpirySweep() {
    return inventoryService.releaseExpiredReservations(200);
  },

  async processLowStockAlerts() {
    const inventories = await prisma.inventory.findMany({
      include: {
        sku: {
          include: {
            product: { include: { seller: { select: { userId: true, storeName: true } } } },
          },
        },
        warehouse: { select: { code: true } },
      },
    });

    let alerted = 0;
    const todayKey = new Date().toISOString().slice(0, 10);
    for (const inv of inventories) {
      const available = inv.onHandQty - inv.reservedQty;
      if (available <= inv.reorderPoint) {
        const marker = `LOW_STOCK:${inv.id}:${todayKey}`;
        const existing = await prisma.notification.findFirst({
          where: {
            userId: inv.sku.product.seller.userId,
            type: 'LOW_STOCK_ALERT',
            message: { contains: marker },
          },
        });
        if (!existing) {
          await prisma.notification.create({
            data: {
              userId: inv.sku.product.seller.userId,
              type: 'LOW_STOCK_ALERT',
              title: `Low stock alert: ${inv.sku.skuCode}`,
              message: `${inv.sku.product.title} (${inv.sku.skuCode}) in ${inv.warehouse.code} has ${available} unit(s) available [${marker}].`,
            },
          });
          alerted++;
        }
      }
    }
    return { checked: inventories.length, alerted };
  },

  async processOutboxDispatch() {
    const pending = await prisma.outboxEvent.findMany({
      where: { status: OutboxEventStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    let dispatched = 0;
    for (const evt of pending) {
      try {
        const payload = evt.payload as Record<string, unknown>;
        let recipientUserId =
          typeof payload.customerId === 'string'
            ? payload.customerId
            : typeof payload.userId === 'string'
              ? payload.userId
              : undefined;

        if (!recipientUserId && typeof payload.orderId === 'string') {
          const order = await prisma.order.findUnique({
            where: { id: payload.orderId },
            select: { customerId: true },
          });
          recipientUserId = order?.customerId;
        }

        if (recipientUserId) {
          const user = await prisma.user.findUnique({ where: { id: recipientUserId } });
          if (user) {
            await emailSandboxAdapter.sendEmail({
              to: user.email,
              subject: `MarketSphere Update: ${evt.eventType}`,
              body: `Event ${evt.eventType} processed for ${evt.aggregateType} ${evt.aggregateId}`,
              template: evt.eventType,
            });
          }
        }
        await prisma.outboxEvent.update({
          where: { id: evt.id },
          data: { status: OutboxEventStatus.DISPATCHED, dispatchedAt: new Date() },
        });
        dispatched++;
      } catch (err) {
        await prisma.outboxEvent.update({
          where: { id: evt.id },
          data: { status: OutboxEventStatus.FAILED },
        });
        logger.error({ outboxId: evt.id, err: err instanceof Error ? err.message : String(err) }, 'Outbox dispatch failed');
      }
    }
    return { scanned: pending.length, dispatched };
  },

  async processPaymentReconciliation() {
    const confirmedOrdersWithoutCommissions = await prisma.order.findMany({
      where: {
        status: { in: ['PAYMENT_CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        commissionLedgers: { none: {} },
      },
      take: 50,
    });

    let reconciled = 0;
    for (const order of confirmedOrdersWithoutCommissions) {
      await prisma.$transaction(async (tx) => {
        await commissionsService.calculateAndPersistOrderCommissionsTx(tx, order.id);
      });
      reconciled++;
    }

    const cancelledCleanups = await prisma.payment.updateMany({
      where: {
        status: PaymentStatus.INITIATED,
        order: { status: 'CANCELLED' },
      },
      data: {
        status: PaymentStatus.FAILED,
        failureCode: 'ORDER_CANCELLED',
        failureMessage: 'Reconciled: associated order was cancelled prior to capture',
      },
    });

    return { commissionsReconciled: reconciled, stalePaymentsClosed: cancelledCleanups.count };
  },

  async processShippingCallback(payload: ShippingCallbackPayload) {
    const normalized = {
      eventId: payload.eventId ?? `shp_job_${crypto.randomBytes(6).toString('hex')}`,
      trackingNumber: payload.trackingNumber,
      status: payload.status,
      location: payload.location,
      description: payload.description,
      failedReason: payload.failedReason,
    };
    const rawPayload = JSON.stringify(normalized);
    const sig = signWebhookPayload(rawPayload, env.SHIPPING_WEBHOOK_SECRET);
    return shippingService.processShippingWebhook({
      rawPayload,
      signatureHeader: sig,
      payload: normalized,
    });
  },

  async processFailedWebhookRecovery() {
    const failedWebhooks = await prisma.webhookEvent.findMany({
      where: {
        status: 'FAILED',
        provider: { in: ['SANDBOX_PAY', 'SANDBOX_SHIP'] },
        retryCount: { lt: 5 },
      },
      take: 25,
    });

    let recovered = 0;
    for (const evt of failedWebhooks) {
      try {
        const raw = JSON.stringify(evt.payload);
        if (evt.provider === 'SANDBOX_PAY') {
          const sig = signWebhookPayload(raw, env.PAYMENT_WEBHOOK_SECRET);
          await paymentsService.processPaymentWebhook({
            rawPayload: raw,
            signatureHeader: sig,
            payload: evt.payload as unknown as PaymentWebhookEventPayload,
          });
          recovered++;
        } else if (evt.provider === 'SANDBOX_SHIP') {
          const sig = signWebhookPayload(raw, env.SHIPPING_WEBHOOK_SECRET);
          await shippingService.processShippingWebhook({
            rawPayload: raw,
            signatureHeader: sig,
            payload: evt.payload as unknown as {
              eventId: string;
              trackingNumber: string;
              status: ShipmentStatus;
              location?: string;
              description?: string;
              failedReason?: string;
            },
          });
          recovered++;
        }
      } catch (err) {
        logger.warn({ webhookId: evt.id, provider: evt.provider, err: err instanceof Error ? err.message : String(err) }, 'Webhook recovery attempt failed');
      }
    }
    return { attempted: failedWebhooks.length, recovered };
  },

  async processFeedImportJob(payload: {
    sellerId: string;
    actorUserId: string;
    format: 'csv' | 'json';
    content: string;
    warehouseId?: string;
  }) {
    return catalogService.importProductFeed(
      payload.sellerId,
      payload.actorUserId,
      payload.format,
      payload.content,
      payload.warehouseId,
    );
  },

  async processSettlementBatch(payload: { periodStart?: string; periodEnd?: string; sellerId?: string }) {
    const periodEnd = payload.periodEnd ? new Date(payload.periodEnd) : new Date();
    const periodStart = payload.periodStart
      ? new Date(payload.periodStart)
      : new Date(periodEnd.getTime() - 30 * 86400_000);
    const settlements = await settlementsService.generateSettlements({
      sellerId: payload.sellerId,
      periodStart,
      periodEnd,
    });
    return { generatedCount: settlements.length };
  },
};

export type RegisteredJobName =
  | 'reservation-expiry-sweep'
  | 'outbox-dispatch'
  | 'low-stock-alerts'
  | 'payment-reconciliation'
  | 'failed-webhook-recovery'
  | 'shipping-status-callback'
  | 'feed-import'
  | 'settlement-batch';

export const WORKER_JOB_REGISTRY: Record<
  RegisteredJobName,
  { queueName: QueueName; run: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> }
> = {
  'reservation-expiry-sweep': {
    queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
    run: () => workerProcessors.processReservationExpirySweep(),
  },
  'outbox-dispatch': {
    queueName: QUEUE_NAMES.NOTIFICATIONS,
    run: () => workerProcessors.processOutboxDispatch(),
  },
  'low-stock-alerts': {
    queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
    run: () => workerProcessors.processLowStockAlerts(),
  },
  'payment-reconciliation': {
    queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
    run: () => workerProcessors.processPaymentReconciliation(),
  },
  'failed-webhook-recovery': {
    queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
    run: () => workerProcessors.processFailedWebhookRecovery(),
  },
  'shipping-status-callback': {
    queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
    run: (payload) => workerProcessors.processShippingCallback(payload as unknown as ShippingCallbackPayload),
  },
  'feed-import': {
    queueName: QUEUE_NAMES.FEED_IMPORT,
    run: (payload) =>
      workerProcessors.processFeedImportJob(
        payload as {
          sellerId: string;
          actorUserId: string;
          format: 'csv' | 'json';
          content: string;
          warehouseId?: string;
        },
      ),
  },
  'settlement-batch': {
    queueName: QUEUE_NAMES.SETTLEMENTS,
    run: (payload) =>
      workerProcessors.processSettlementBatch(
        payload as { periodStart?: string; periodEnd?: string; sellerId?: string },
      ),
  },
};

export function isRegisteredJobName(name: string): name is RegisteredJobName {
  return Object.prototype.hasOwnProperty.call(WORKER_JOB_REGISTRY, name);
}

export async function executeTrackedJobByName(
  jobName: RegisteredJobName,
  jobId: string,
  payload: Record<string, unknown> = {},
  queueOverride?: string,
) {
  const entry = WORKER_JOB_REGISTRY[jobName];
  return runWithJobTracking(queueOverride ?? entry.queueName, jobId, jobName, payload, () => entry.run(payload));
}
