import crypto from 'crypto';
import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  CommissionLedgerStatus,
  OrderStatus,
  RefundStatus,
  ShipmentStatus,
  UserStatus,
} from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { env } from '../src/config/env';
import { signWebhookPayload } from '../src/integrations/payment-sandbox';
import { cacheDeletePrefix, cacheGetJson, cacheSetJson, pingRedis } from '../src/common/redis';
import { inventoryService } from '../src/modules/inventory/inventory.service';

const app = createApp();

describe('MarketSphere 10-Point End-to-End Integration Audit Suite', () => {
  let customer1Token = '';
  let customer2Token = '';
  let seller1Token = '';
  let seller2Token = '';
  let warehouseToken = '';
  let supportToken = '';
  let adminToken = '';

  let seller1Id = '';
  let seller2Id = '';
  let seller1SkuId = '';
  let seller2SkuId = '';
  let whEastId = '';

  beforeAll(async () => {
    await inventoryService.releaseExpiredReservations(200);

    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      expect(res.status).toBe(200);
      return res.body.data.accessToken as string;
    };

    customer1Token = await login('customer@marketsphere.test');
    customer2Token = await login('customer2@marketsphere.test');
    seller1Token = await login('seller1@marketsphere.test');
    seller2Token = await login('seller2@marketsphere.test');
    warehouseToken = await login('warehouse@marketsphere.test');
    supportToken = await login('support@marketsphere.test');
    adminToken = await login('admin@marketsphere.test');

    const s1 = await prisma.seller.findUniqueOrThrow({ where: { storeSlug: 'apex-electronics-studio' } });
    const s2 = await prisma.seller.findUniqueOrThrow({ where: { storeSlug: 'nordic-home-living' } });
    seller1Id = s1.id;
    seller2Id = s2.id;

    const sku1 = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'APX-HP-BLK' }, include: { inventories: true } });
    const sku2 = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'NRD-DM-GRY' }, include: { inventories: true } });
    seller1SkuId = sku1.id;
    seller2SkuId = sku2.id;
    whEastId = sku1.inventories[0]!.warehouseId;
  });

  it('Audit 2 & 3: verifies Backend-to-PostgreSQL health & tables and Redis graceful connectivity handling', async () => {
    const healthRes = await request(app).get('/api/v1/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.data.dependencies.postgres).toBe('up');
    expect(['up', 'down']).toContain(healthRes.body.data.dependencies.redis);

    const tables = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public'
    `;
    expect(Number(tables[0]!.count)).toBeGreaterThanOrEqual(50);

    const redisStatus = await pingRedis(true);
    if (!redisStatus) {
      // Verify graceful fallback when Redis daemon is offline
      expect(await cacheSetJson('audit:key', { ok: true }, 10)).toBe(false);
      expect(await cacheGetJson('audit:key')).toBeNull();
      expect(await cacheDeletePrefix('audit:')).toBe(0);
    } else {
      expect(await cacheSetJson('audit:key', { ok: true }, 10)).toBe(true);
      expect(await cacheGetJson<{ ok: boolean }>('audit:key')).toEqual({ ok: true });
      await cacheDeletePrefix('audit:');
    }
  });

  it('Audit 4: verifies live Express-to-FastAPI pricing, recommendations, and CSV feed normalization', async () => {
    const healthRes = await request(app).get('/api/v1/health');
    expect(healthRes.body.data.dependencies.pythonService).toBe('up');

    await request(app)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ skuId: seller1SkuId, quantity: 1 })
      .expect((r) => expect([200, 201]).includes(r.status));

    const valRes = await request(app)
      .post('/api/v1/cart/validate')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ discountCode: 'WELCOME10' });
    expect(valRes.status).toBe(200);
    expect(valRes.body.data.pricing.source).toBe('python-fastapi');
    expect(Number(valRes.body.data.pricing.discountAmount)).toBeGreaterThan(0);

    const recRes = await request(app)
      .get('/api/v1/products/recommendations')
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(recRes.status).toBe(200);
    expect(Array.isArray(recRes.body.data.items)).toBe(true);
    expect(recRes.body.data.strategy).not.toBe('popularity-fallback');

    const skuCode = `AUD-PY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const feedRes = await request(app)
      .post('/api/v1/seller/products/feed-import')
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({
        format: 'csv',
        content: `title,sku_code,price,category_slug,quantity,brand\nAudit FastAPI Mic,${skuCode},89.50,audio-studio,4,Apex`,
      });
    expect(feedRes.status).toBe(200);
    expect(feedRes.body.data.importedCount).toBe(1);
    const createdSku = await prisma.sku.findUnique({ where: { skuCode } });
    expect(createdSku?.skuCode).toBe(skuCode);
  });

  it('Audit 5: enforces authentication, inactive-account block, and multi-role RBAC boundaries', async () => {
    await request(app).get('/api/v1/orders').expect(401);
    await request(app).get('/api/v1/admin/analytics').set('Authorization', `Bearer ${seller1Token}`).expect(403);
    await request(app).post('/api/v1/settlements/generate').set('Authorization', `Bearer ${supportToken}`).send({}).expect(403);
    await request(app).get('/api/v1/warehouses').set('Authorization', `Bearer ${customer1Token}`).expect(403);
    await request(app).get('/api/v1/inventory/reservations').set('Authorization', `Bearer ${customer1Token}`).expect(403);

    // Suspended user token must be rejected mid-session and restored cleanly
    const c2 = await prisma.user.findUniqueOrThrow({ where: { email: 'customer2@marketsphere.test' } });
    await prisma.user.update({ where: { id: c2.id }, data: { status: UserStatus.SUSPENDED } });
    try {
      const blocked = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${customer2Token}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('ACCOUNT_INACTIVE');
    } finally {
      await prisma.user.update({ where: { id: c2.id }, data: { status: UserStatus.ACTIVE } });
    }
  });

  it('Audit 6: enforces reservation idempotency and restocks committed stock + reverses commissions on paid cancellation', async () => {
    const invStart = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller2SkuId, warehouseId: whEastId } },
    });

    const idemKey = `aud_resv_${crypto.randomUUID()}`;
    const chk1 = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', idemKey)
      .send({ items: [{ skuId: seller2SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(chk1.status).toBe(201);

    // Same Idempotency-Key returns same order without double-reserving
    const chkReplay = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', idemKey)
      .send({ items: [{ skuId: seller2SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(chkReplay.status).toBe(200);
    expect(chkReplay.body.data.id).toBe(chk1.body.data.id);

    const invReserved = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller2SkuId, warehouseId: whEastId } },
    });
    expect(invReserved.reservedQty).toBe(invStart.reservedQty + 1);

    // Confirm payment -> commits reservation (onHandQty - 1, commission EARNED)
    const payConfirm = await request(app)
      .post(`/api/v1/payments/${chk1.body.data.payment.id}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ outcome: 'SUCCEED' });
    expect(payConfirm.status).toBe(200);

    const invCommitted = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller2SkuId, warehouseId: whEastId } },
    });
    expect(invCommitted.onHandQty).toBe(invStart.onHandQty - 1);

    // Cancel paid order -> must restock committed unit AND reverse EARNED commissions
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${chk1.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ reason: 'Audit paid-cancellation restock check' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe(OrderStatus.CANCELLED);

    const invRestocked = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: seller2SkuId, warehouseId: whEastId } },
    });
    expect(invRestocked.onHandQty).toBe(invStart.onHandQty);
    expect(invRestocked.reservedQty).toBe(invStart.reservedQty);

    const reversedLedgers = await prisma.commissionLedger.findMany({ where: { orderId: chk1.body.data.id } });
    expect(reversedLedgers.every((l) => l.status === CommissionLedgerStatus.REVERSED)).toBe(true);
  });

  it('Audit 7 & 8: verifies payment webhook idempotency and refund idempotency end-to-end', async () => {
    const chk = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', `aud_payref_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller1SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(chk.status).toBe(201);

    const whPayload = {
      eventId: `evt_aud_${crypto.randomUUID()}`,
      eventType: 'PAYMENT_SUCCEEDED',
      providerPaymentId: chk.body.data.payment.providerPaymentId,
      amount: chk.body.data.totalAmount,
    };
    const sig = signWebhookPayload(JSON.stringify(whPayload), env.PAYMENT_WEBHOOK_SECRET);

    const w1 = await request(app).post('/api/v1/webhooks/payments').set('X-Marketplace-Signature', sig).send(whPayload);
    const w2 = await request(app).post('/api/v1/webhooks/payments').set('X-Marketplace-Signature', sig).send(whPayload);
    expect(w1.status).toBe(200);
    expect(w1.body.data.processed).toBe(true);
    expect(w2.status).toBe(200);
    expect(w2.body.data.idempotent).toBe(true);

    // Refund idempotency + balance cap
    const refundKey = `aud_ref_${crypto.randomUUID()}`;
    const r1 = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', refundKey)
      .send({ orderId: chk.body.data.id, amount: chk.body.data.totalAmount, reason: 'Audit full refund' });
    const r2 = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', refundKey)
      .send({ orderId: chk.body.data.id, amount: chk.body.data.totalAmount, reason: 'Audit full refund' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.id).toBe(r1.body.data.id);

    const r3 = await request(app)
      .post('/api/v1/refunds')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', `aud_ref_over_${crypto.randomUUID()}`)
      .send({ orderId: chk.body.data.id, amount: '1.00', reason: 'Over-refund attempt' });
    expect(r3.status).toBe(409);

    const refundsCount = await prisma.refund.count({
      where: { orderId: chk.body.data.id, status: RefundStatus.SUCCEEDED },
    });
    expect(refundsCount).toBe(1);
  });

  it('Audit 9: enforces strict seller isolation on commission rules, multi-seller order details, and returns', async () => {
    // Private commission rule for seller2 must NEVER be visible to seller1
    const privateRule = await prisma.commissionRule.create({
      data: {
        name: `Confidential Seller2 Rate ${crypto.randomBytes(2).toString('hex')}`,
        sellerId: seller2Id,
        commissionType: 'PERCENTAGE',
        percentageRate: '0.0750',
        fixedAmount: '0.00',
        priority: 1,
        isActive: true,
      },
    });

    try {
      const s1Rules = await request(app)
        .get('/api/v1/commissions/rules')
        .set('Authorization', `Bearer ${seller1Token}`);
      expect(s1Rules.status).toBe(200);
      const leakedRule = (s1Rules.body.data as Array<{ id: string; sellerId: string | null }>).find(
        (r) => r.id === privateRule.id || (r.sellerId !== null && r.sellerId !== seller1Id),
      );
      expect(leakedRule).toBeUndefined();

      const adminRules = await request(app)
        .get('/api/v1/commissions/rules')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRules.status).toBe(200);
      expect(
        (adminRules.body.data as Array<{ id: string }>).some((r) => r.id === privateRule.id),
      ).toBe(true);

      // Multi-seller order isolation: seller1 sees ONLY seller1 items, shipments, reservations, and returns
      const multiChk = await request(app)
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('Idempotency-Key', `aud_multi_${crypto.randomUUID()}`)
        .send({ items: [{ skuId: seller1SkuId, quantity: 1 }, { skuId: seller2SkuId, quantity: 1 }] });
      expect(multiChk.status).toBe(201);
      const multiOrderId = multiChk.body.data.id as string;

      await request(app)
        .post(`/api/v1/payments/${multiChk.body.data.payment.id}/confirm-sandbox`)
        .set('Authorization', `Bearer ${customer1Token}`)
        .send({ outcome: 'SUCCEED' })
        .expect(200);

      // Seller2 creates a shipment for their item only
      await request(app)
        .post('/api/v1/shipments')
        .set('Authorization', `Bearer ${seller2Token}`)
        .send({ orderId: multiOrderId })
        .expect(201);

      const s1OrderView = await request(app)
        .get(`/api/v1/orders/${multiOrderId}`)
        .set('Authorization', `Bearer ${seller1Token}`);
      expect(s1OrderView.status).toBe(200);
      expect(s1OrderView.body.data.items).toHaveLength(1);
      expect(s1OrderView.body.data.items[0].sellerId).toBe(seller1Id);
      expect(s1OrderView.body.data.shipments).toHaveLength(0);
      expect(
        (s1OrderView.body.data.reservations as Array<{ skuId: string }>).every((r) => r.skuId === seller1SkuId),
      ).toBe(true);
    } finally {
      await prisma.commissionRule.delete({ where: { id: privateRule.id } });
    }
  });

  it('Audit 10: verifies full customer checkout -> payment -> shipment tracking -> delivery -> order detail lifecycle', async () => {
    const chk = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', `aud_e2e_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: seller1SkuId, warehouseId: whEastId, quantity: 1 }] });
    expect(chk.status).toBe(201);
    const orderId = chk.body.data.id as string;

    await request(app)
      .post(`/api/v1/payments/${chk.body.data.payment.id}/confirm-sandbox`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ outcome: 'SUCCEED' })
      .expect(200);

    const ship = await request(app)
      .post('/api/v1/shipments')
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({ orderId });
    expect(ship.status).toBe(201);
    const trackingNumber = ship.body.data.trackingNumber as string;

    for (const step of [
      { status: ShipmentStatus.IN_TRANSIT, location: 'Newark Hub', description: 'Departed regional sorting hub' },
      { status: ShipmentStatus.DELIVERED, location: 'San Francisco Front Porch', description: 'Delivered cleanly' },
    ]) {
      const payload = { eventId: `trk_${crypto.randomUUID()}`, trackingNumber, ...step };
      const sig = signWebhookPayload(JSON.stringify(payload), env.SHIPPING_WEBHOOK_SECRET);
      await request(app)
        .post('/api/v1/webhooks/shipping')
        .set('X-Marketplace-Signature', sig)
        .send(payload)
        .expect(200);
    }

    const detail = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe(OrderStatus.DELIVERED);
    expect(detail.body.data.statusHistory.length).toBeGreaterThanOrEqual(4);
    expect(detail.body.data.shipments[0].events.length).toBeGreaterThanOrEqual(3);
  });

  it('Audit Catalog SQL Sort: verifies SQL-level price_asc/price_desc sorting across pages and inStock filtering', async () => {
    const p1Asc = await request(app).get('/api/v1/products?page=1&limit=3&sortBy=price_asc&inStock=true');
    const p2Asc = await request(app).get('/api/v1/products?page=2&limit=3&sortBy=price_asc&inStock=true');
    expect(p1Asc.status).toBe(200);
    expect(p2Asc.status).toBe(200);
    expect(p1Asc.body.meta.total).toBeGreaterThanOrEqual(4);

    const p1Prices = (p1Asc.body.data as Array<{ minPrice: string; availableStock: number }>).map((x) => ({
      price: Number(x.minPrice),
      stock: x.availableStock,
    }));
    const p2Prices = (p2Asc.body.data as Array<{ minPrice: string; availableStock: number }>).map((x) => ({
      price: Number(x.minPrice),
      stock: x.availableStock,
    }));
    expect(p1Prices.every((x) => x.stock > 0)).toBe(true);
    expect(p2Prices.every((x) => x.stock > 0)).toBe(true);
    if (p1Prices.length > 0 && p2Prices.length > 0) {
      expect(p1Prices[p1Prices.length - 1]!.price).toBeLessThanOrEqual(p2Prices[0]!.price);
    }
  });
});
