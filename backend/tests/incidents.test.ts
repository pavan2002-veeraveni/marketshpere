import crypto from 'crypto';
import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { env } from '../src/config/env';
import { signWebhookPayload } from '../src/integrations/payment-sandbox';
import { workerProcessors } from '../src/workers/processors';
import { inventoryService } from '../src/modules/inventory/inventory.service';

const app = createApp();

describe('Assessment 15 — 6 Marketplace Incident Simulations & Regression Verifications', () => {
  let customerToken = '';
  let supportToken = '';
  let skuId = '';
  let warehouseId = '';

  beforeAll(async () => {
    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      return res.body.data.accessToken as string;
    };
    customerToken = await login('customer@marketsphere.test');
    supportToken = await login('support@marketsphere.test');

    const sku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'APX-HB-GRY' }, include: { inventories: true } });
    skuId = sku.id;
    warehouseId = sku.inventories[0]!.warehouseId;
  });

  it('Incident 1 (Overselling): PostgreSQL CHECK constraint & row-lock guard prevent negative available stock', async () => {
    // Request available + 1 within Zod max(50) limit by temporarily verifying on a low-stock SKU or exact available + 1
    const lowStockSku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'APX-HP-SLV' }, include: { inventories: true } });
    const lowInv = lowStockSku.inventories[0]!;
    const excessive = Math.max(1, lowInv.onHandQty - lowInv.reservedQty) + 1;

    const res = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `inc1_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: lowStockSku.id, warehouseId: lowInv.warehouseId, quantity: excessive }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    // Also verify PostgreSQL CHECK constraint blocks direct negative stock invariant violation
    await expect(
      prisma.$executeRaw`UPDATE inventory SET reserved_qty = on_hand_qty + 1 WHERE id = ${lowInv.id}::uuid`,
    ).rejects.toThrow();
  });

  it('Incident 2 (Stale Stock): Expired reservation sweep clears stuck reserved_qty cleanly', async () => {
    await inventoryService.releaseExpiredReservations(200);
    const invBefore = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId, warehouseId } },
    });
    const chk = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `inc2_${crypto.randomUUID()}`)
      .send({ items: [{ skuId, warehouseId, quantity: 2 }] });
    expect(chk.status).toBe(201);

    await prisma.inventoryReservation.updateMany({
      where: { orderId: chk.body.data.id },
      data: { expiresAt: new Date(Date.now() - 120_000) },
    });

    const sweep = await inventoryService.releaseExpiredReservations(50);
    expect(sweep.releasedCount).toBeGreaterThanOrEqual(1);

    const invAfter = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId, warehouseId } },
    });
    expect(invAfter.reservedQty).toBe(invBefore.reservedQty);
  });

  it('Incident 3 (Payment/Order Mismatch): Reconciliation job backfills missing commission ledgers for confirmed orders', async () => {
    const chk = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `inc3_${crypto.randomUUID()}`)
      .send({ items: [{ skuId, warehouseId, quantity: 1 }] });
    const orderId = chk.body.data.id as string;

    // Simulate payment/order state anomaly: order moved to PAYMENT_CONFIRMED without commission ledger
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.PAYMENT_CONFIRMED } });
    await prisma.payment.updateMany({ where: { orderId }, data: { status: PaymentStatus.CAPTURED } });

    const recon = await workerProcessors.processPaymentReconciliation();
    expect(recon.commissionsReconciled).toBeGreaterThanOrEqual(1);

    const ledgerCount = await prisma.commissionLedger.count({ where: { orderId } });
    expect(ledgerCount).toBe(1);
  });

  it('Incident 4 (Slow Search): Product search utilizes GIN trigram index and returns bounded paginated payload under 200ms', async () => {
    const idxRows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'products' AND indexname = 'products_title_trgm_idx'
    `;
    expect(idxRows).toHaveLength(1);
    expect(idxRows[0]!.indexdef.toLowerCase()).toContain('gin_trgm_ops');

    // Warm connection and verify search completes strictly under 200ms
    await request(app).get('/api/v1/products?search=Apex&page=1&limit=10').expect(200);
    const t0 = performance.now();
    const res = await request(app).get('/api/v1/products?search=Apex&page=1&limit=10');
    const elapsedMs = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.limit).toBe(10);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('Incident 5 (Failed Shipping Callback): Tampered signature rejected & failed carrier webhook recorded safely', async () => {
    const tampered = await request(app)
      .post('/api/v1/webhooks/shipping')
      .set('X-Marketplace-Signature', 'invalid_hmac')
      .send({ eventId: 'evt_bad', trackingNumber: 'SBX-TRK-NONE', status: ShipmentStatus.FAILED });
    expect(tampered.status).toBe(401);

    const missingEventId = `evt_missing_${crypto.randomUUID()}`;
    const unknownTracking = { eventId: missingEventId, trackingNumber: 'SBX-TRK-MISSING', status: ShipmentStatus.FAILED };
    const raw = JSON.stringify(unknownTracking);
    const sig = signWebhookPayload(raw, env.SHIPPING_WEBHOOK_SECRET);
    const missingRes = await request(app)
      .post('/api/v1/webhooks/shipping')
      .set('X-Marketplace-Signature', sig)
      .send(unknownTracking);
    expect(missingRes.status).toBe(404);

    const whRecord = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: 'SANDBOX_SHIP', providerEventId: missingEventId } },
    });
    expect(whRecord.status).toBe('FAILED');
    expect(whRecord.lastError?.toLowerCase()).toContain('not found');
  });

  it('Incident 6 (Duplicate Refund): Concurrent duplicate refund requests cannot exceed captured payment total', async () => {
    const chk = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `inc6_${crypto.randomUUID()}`)
      .send({ items: [{ skuId, warehouseId, quantity: 1 }] });
    const orderId = chk.body.data.id as string;
    const paymentId = chk.body.data.payment.id as string;
    const amount = chk.body.data.totalAmount as string;

    await request(app)
      .post(`/api/v1/payments/${paymentId}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ outcome: 'SUCCEED' });

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/v1/refunds')
        .set('Authorization', `Bearer ${supportToken}`)
        .set('Idempotency-Key', `inc6_r1_${crypto.randomUUID()}`)
        .send({ orderId, amount, reason: 'Incident 6 concurrent refund A' }),
      request(app)
        .post('/api/v1/refunds')
        .set('Authorization', `Bearer ${supportToken}`)
        .set('Idempotency-Key', `inc6_r2_${crypto.randomUUID()}`)
        .send({ orderId, amount, reason: 'Incident 6 concurrent refund B' }),
    ]);

    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);

    const refundCount = await prisma.refund.count({ where: { orderId } });
    expect(refundCount).toBe(1);
  });
});
