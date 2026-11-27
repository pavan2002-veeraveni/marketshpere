import crypto from 'crypto';
import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { BackgroundJobStatus, OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { env } from '../src/config/env';
import { signWebhookPayload } from '../src/integrations/payment-sandbox';
import { runWithJobTracking, workerProcessors } from '../src/workers/processors';

const app = createApp();

describe('MarketSphere Webhooks, Idempotency, Refunds, Partial Fulfillment & Workers', () => {
  let customerToken = '';
  let seller1Token = '';
  let supportToken = '';
  let adminToken = '';
  let seller1SkuId = '';
  let seller2SkuId = '';
  let whEastId = '';

  beforeAll(async () => {
    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      return res.body.data.accessToken as string;
    };
    customerToken = await login('customer@marketsphere.test');
    seller1Token = await login('seller1@marketsphere.test');
    supportToken = await login('support@marketsphere.test');
    adminToken = await login('admin@marketsphere.test');

    const sku1 = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'APX-HP-BLK' }, include: { inventories: true } });
    const sku2 = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'NRD-DM-GRY' }, include: { inventories: true } });
    seller1SkuId = sku1.id;
    seller2SkuId = sku2.id;
    whEastId = sku1.inventories[0]!.warehouseId;
  });

  it('deduplicates duplicate payment webhooks and commits stock/commissions once', async () => {
    const invBefore = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller1SkuId, warehouseId: whEastId } },
    });

    const checkout = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `wh_order_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller1SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(checkout.status).toBe(201);

    const orderId = checkout.body.data.id as string;
    const providerPaymentId = checkout.body.data.payment.providerPaymentId as string;

    const webhookBody = {
      eventId: `evt_dup_${crypto.randomUUID()}`,
      eventType: 'PAYMENT_SUCCEEDED',
      providerPaymentId,
      amount: checkout.body.data.totalAmount,
    };
    const raw = JSON.stringify(webhookBody);
    const sig = signWebhookPayload(raw, env.PAYMENT_WEBHOOK_SECRET);

    // Unsigned webhook must be rejected
    const badSig = await request(app).post('/api/v1/webhooks/payments').send(webhookBody);
    expect(badSig.status).toBe(401);

    // First delivery + duplicate delivery
    const wh1 = await request(app)
      .post('/api/v1/webhooks/payments')
      .set('X-Marketplace-Signature', sig)
      .send(webhookBody);
    expect(wh1.status).toBe(200);
    expect(wh1.body.data.processed).toBe(true);

    const wh2 = await request(app)
      .post('/api/v1/webhooks/payments')
      .set('X-Marketplace-Signature', sig)
      .send(webhookBody);
    expect(wh2.status).toBe(200);
    expect(wh2.body.data.idempotent).toBe(true);

    const invAfter = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller1SkuId, warehouseId: whEastId } },
    });
    expect(invAfter.onHandQty).toBe(invBefore.onHandQty - 1);
    expect(invAfter.reservedQty).toBe(invBefore.reservedQty);

    const commissionCount = await prisma.commissionLedger.count({ where: { orderId } });
    expect(commissionCount).toBe(1);
  });

  it('prevents duplicate and over-limit refunds', async () => {
    const checkout = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `ref_order_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller2SkuId, quantity: 1 }] });
    expect(checkout.status).toBe(201);

    const orderId = checkout.body.data.id as string;
    const paymentId = checkout.body.data.payment.id as string;
    const totalAmount = checkout.body.data.totalAmount as string;

    // Confirm payment
    const confirm = await request(app)
      .post(`/api/v1/payments/${paymentId}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ outcome: 'SUCCEED' });
    expect(confirm.status).toBe(200);

    const refundKey = `ref_idem_${crypto.randomUUID()}`;
    const ref1 = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', refundKey)
      .send({ orderId, amount: totalAmount, reason: 'Customer requested full refund' });
    expect(ref1.status).toBe(201);

    // Same idempotency key returns idempotently
    const refDup = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', refundKey)
      .send({ orderId, amount: totalAmount, reason: 'Customer requested full refund' });
    expect(refDup.status).toBe(200);
    expect(refDup.body.data.id).toBe(ref1.body.data.id);

    // Different idempotency key attempting second refund exceeds payment balance -> 409
    const refOver = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', `ref_over_${crypto.randomUUID()}`)
      .send({ orderId, amount: '5.00', reason: 'Attempted duplicate refund' });
    expect(refOver.status).toBe(409);
  });

  it('supports failed payment retry, partial fulfillment, and signed shipping failure callbacks', async () => {
    const checkout = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `multi_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller1SkuId, quantity: 1 }, { skuId: seller2SkuId, quantity: 1 }] });
    expect(checkout.status).toBe(201);
    const orderId = checkout.body.data.id as string;
    const paymentId = checkout.body.data.payment.id as string;

    // Fail payment first
    const failRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ outcome: 'FAIL', failureMessage: 'Sandbox card declined' });
    expect(failRes.status).toBe(200);
    expect(failRes.body.data.order.payments[0].status).toBe(PaymentStatus.FAILED);

    // Retry and succeed
    const retryRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/retry`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(retryRes.status).toBe(200);

    const okRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ outcome: 'SUCCEED' });
    expect(okRes.status).toBe(200);

    // Seller 1 creates shipment ONLY for Seller 1 items (partial fulfillment: order stays PAYMENT_CONFIRMED because Seller 2 item is still ALLOCATED)
    const shipRes = await request(app)
      .post('/api/v1/shipments')
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({ orderId });
    expect(shipRes.status).toBe(201);
    const trackingNumber = shipRes.body.data.trackingNumber as string;

    const orderMid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderMid.status).toBe(OrderStatus.PAYMENT_CONFIRMED);

    // Simulate failed carrier webhook callback
    const shipWebhook = {
      eventId: `shp_fail_${crypto.randomUUID()}`,
      trackingNumber,
      status: ShipmentStatus.FAILED,
      failedReason: 'Address inaccessible during delivery window',
    };
    const rawShip = JSON.stringify(shipWebhook);
    const shipSig = signWebhookPayload(rawShip, env.SHIPPING_WEBHOOK_SECRET);

    const whShipRes = await request(app)
      .post('/api/v1/webhooks/shipping')
      .set('X-Marketplace-Signature', shipSig)
      .send(shipWebhook);
    expect(whShipRes.status).toBe(200);

    const updatedShipment = await prisma.shipment.findUniqueOrThrow({ where: { trackingNumber } });
    expect(updatedShipment.status).toBe(ShipmentStatus.FAILED);
  });

  it('tracks failed background jobs to DEAD_LETTER and runs reconciliation/outbox processors', async () => {
    const jobId = `fail-job-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await expect(
        runWithJobTracking('marketsphere-maintenance', jobId, 'test-failing-job', { attempt: i + 1 }, async () => {
          throw new Error('Simulated worker transient failure');
        }),
      ).rejects.toThrow('Simulated worker transient failure');
    }

    const record = await prisma.backgroundJobRecord.findUniqueOrThrow({
      where: { queueName_jobId: { queueName: 'marketsphere-maintenance', jobId } },
    });
    expect(record.status).toBe(BackgroundJobStatus.DEAD_LETTER);
    expect(record.attempts).toBe(3);

    const replayRes = await request(app)
      .post(`/api/v1/admin/jobs/${record.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.data.status).toBe('QUEUED');

    const recon = await workerProcessors.processPaymentReconciliation();
    expect(recon).toHaveProperty('commissionsReconciled');

    const outbox = await workerProcessors.processOutboxDispatch();
    expect(outbox).toHaveProperty('dispatched');
  });

  it('tracks checkout/outbox/shipping-callback/feed jobs in PostgreSQL, supports admin trigger & replay, and exposes Prometheus metrics', async () => {
    // 1. Checkout persists background job tracking rows for expiry sweep and outbox dispatch
    const checkout = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `wrk_order_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller1SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(checkout.status).toBe(201);
    const orderId = checkout.body.data.id as string;
    const paymentId = checkout.body.data.payment.id as string;

    const trackedSweep = await prisma.backgroundJobRecord.findUnique({
      where: { queueName_jobId: { queueName: 'marketsphere-maintenance', jobId: `resv-exp-${orderId}` } },
    });
    expect(trackedSweep?.jobName).toBe('reservation-expiry-sweep');
    expect(trackedSweep?.status).toBe(BackgroundJobStatus.QUEUED);

    // 2. Confirm payment -> creates outbox event -> Admin triggers outbox-dispatch job
    const okPay = await request(app)
      .post(`/api/v1/payments/${paymentId}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ outcome: 'SUCCEED' });
    expect(okPay.status).toBe(200);

    const triggerOutbox = await request(app)
      .post('/api/v1/admin/jobs/trigger')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jobName: 'outbox-dispatch', executeNow: true });
    expect(triggerOutbox.status).toBe(201);
    expect(triggerOutbox.body.data.status).toBe(BackgroundJobStatus.COMPLETED);

    const remainingOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: orderId, status: 'PENDING' },
    });
    expect(remainingOutbox).toHaveLength(0);

    // 3. Async shipping webhook (?async=true) queues shipping-status-callback and replays synchronously via admin replay
    const shipRes = await request(app)
      .post('/api/v1/shipments')
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({ orderId });
    expect(shipRes.status).toBe(201);
    const trackingNumber = shipRes.body.data.trackingNumber as string;

    const asyncShipPayload = {
      eventId: `shp_async_${crypto.randomUUID()}`,
      trackingNumber,
      status: ShipmentStatus.IN_TRANSIT,
      location: 'Memphis Sort Facility',
      description: 'Departed hub via worker callback',
    };
    const asyncShipSig = signWebhookPayload(JSON.stringify(asyncShipPayload), env.SHIPPING_WEBHOOK_SECRET);
    const asyncWhRes = await request(app)
      .post('/api/v1/webhooks/shipping?async=true')
      .set('X-Marketplace-Signature', asyncShipSig)
      .send(asyncShipPayload);
    expect(asyncWhRes.status).toBe(202);
    expect(asyncWhRes.body.data.queued).toBe(true);

    const queuedShipJob = await prisma.backgroundJobRecord.findUniqueOrThrow({
      where: { queueName_jobId: { queueName: 'marketsphere-maintenance', jobId: asyncWhRes.body.data.jobId } },
    });
    expect(queuedShipJob.status).toBe(BackgroundJobStatus.QUEUED);

    const replayShipRes = await request(app)
      .post(`/api/v1/admin/jobs/${queuedShipJob.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ executeNow: true });
    expect(replayShipRes.status).toBe(200);
    expect(replayShipRes.body.data.status).toBe(BackgroundJobStatus.COMPLETED);

    const updatedShip = await prisma.shipment.findUniqueOrThrow({ where: { trackingNumber } });
    expect(updatedShip.status).toBe(ShipmentStatus.IN_TRANSIT);

    // 4. Async feed import queues job -> admin replay persists SKU via Python FastAPI feed engine
    const uniqueSku = `WRK-FEED-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const csvFeed = `title,sku_code,price,category_slug,quantity,brand\nWorker Feed Mic,${uniqueSku},149.00,audio-studio,8,Apex`;
    const asyncFeedRes = await request(app)
      .post('/api/v1/seller/products/feed-import')
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({ format: 'csv', content: csvFeed, async: true });
    expect(asyncFeedRes.status).toBe(202);
    expect(asyncFeedRes.body.data.queued).toBe(true);

    const queuedFeedJob = await prisma.backgroundJobRecord.findUniqueOrThrow({
      where: { queueName_jobId: { queueName: 'marketsphere-feed-import', jobId: asyncFeedRes.body.data.jobId } },
    });
    const replayFeedRes = await request(app)
      .post(`/api/v1/admin/jobs/${queuedFeedJob.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ executeNow: true });
    expect(replayFeedRes.status).toBe(200);
    expect(replayFeedRes.body.data.status).toBe(BackgroundJobStatus.COMPLETED);

    const importedSku = await prisma.sku.findUnique({ where: { skuCode: uniqueSku } });
    expect(importedSku?.skuCode).toBe(uniqueSku);

    // 5. Prometheus metrics endpoint returns OpenMetrics exposition counters
    const metricsRes = await request(app).get('/api/v1/health/metrics');
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain('marketsphere_dependency_up{service="postgres"} 1');
    expect(metricsRes.text).toContain('marketsphere_background_jobs_total');
    expect(metricsRes.text).toContain('marketsphere_http_requests_total');

    // 6. Failed SANDBOX_SHIP webhook row recovers automatically via processFailedWebhookRecovery
    const failedShipEvtId = `shp_rec_${crypto.randomUUID()}`;
    await prisma.webhookEvent.create({
      data: {
        provider: 'SANDBOX_SHIP',
        providerEventId: failedShipEvtId,
        eventType: ShipmentStatus.OUT_FOR_DELIVERY,
        signatureValid: true,
        status: 'FAILED',
        retryCount: 1,
        lastError: 'Simulated transient delivery failure',
        payload: {
          eventId: failedShipEvtId,
          trackingNumber,
          status: ShipmentStatus.OUT_FOR_DELIVERY,
          location: 'Local Courier Depot',
          description: 'Recovered by worker',
        },
      },
    });
    const recShipRes = await workerProcessors.processFailedWebhookRecovery();
    expect(recShipRes.recovered).toBeGreaterThanOrEqual(1);
    const recoveredRow = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: 'SANDBOX_SHIP', providerEventId: failedShipEvtId } },
    });
    expect(recoveredRow.status).toBe('PROCESSED');
  });
});
