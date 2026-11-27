import crypto from 'crypto';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { OrderStatus, ProductStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { inventoryService } from '../src/modules/inventory/inventory.service';

const app = createApp();

describe('MarketSphere Concurrency, Inventory Reservations, Promotions & Order Lifecycle', () => {
  let customer1Token = '';
  let customer2Token = '';
  let adminToken = '';
  let testProductId = '';
  let lastUnitSkuId = '';
  let warehouseId = '';
  let limitDiscountCode = '';

  beforeAll(async () => {
    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      return res.body.data.accessToken as string;
    };
    customer1Token = await login('customer@marketsphere.test');
    customer2Token = await login('customer2@marketsphere.test');
    adminToken = await login('admin@marketsphere.test');

    // Ensure customer2 has a default address for checkout
    const c2 = await prisma.user.findUniqueOrThrow({ where: { email: 'customer2@marketsphere.test' } });
    const c2Addr = await prisma.address.findFirst({ where: { userId: c2.id } });
    if (!c2Addr) {
      await prisma.address.create({
        data: {
          userId: c2.id,
          label: 'Home',
          recipientName: 'Liam Patel',
          line1: '100 Market St',
          city: 'Seattle',
          state: 'WA',
          postalCode: '98101',
          country: 'US',
          phone: '+1-555-0107',
          isDefault: true,
        },
      });
    }

    const seller = await prisma.seller.findFirstOrThrow({ where: { storeSlug: 'apex-electronics-studio' } });
    const category = await prisma.category.findFirstOrThrow();
    const warehouse = await prisma.warehouse.findFirstOrThrow();
    warehouseId = warehouse.id;

    // Create dedicated product with exact stock = 1 for concurrency testing
    const uniqueSuffix = crypto.randomBytes(3).toString('hex');
    const prod = await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId: category.id,
        title: `Limited Edition DAC ${uniqueSuffix}`,
        slug: `limited-dac-${uniqueSuffix}`,
        description: 'Concurrency test item with single unit.',
        status: ProductStatus.ACTIVE,
      },
    });
    testProductId = prod.id;
    const variant = await prisma.productVariant.create({
      data: { productId: prod.id, name: 'Standard', optionValues: { edition: '1/1' } },
    });
    const sku = await prisma.sku.create({
      data: {
        productId: prod.id,
        variantId: variant.id,
        skuCode: `CONC-${uniqueSuffix.toUpperCase()}`,
        price: '199.00',
      },
    });
    lastUnitSkuId = sku.id;
    await prisma.inventory.create({
      data: {
        skuId: sku.id,
        warehouseId,
        onHandQty: 1,
        reservedQty: 0,
      },
    });

    limitDiscountCode = `ONEUSE${uniqueSuffix.toUpperCase()}`;
    await prisma.discount.create({
      data: {
        code: limitDiscountCode,
        discountType: 'FIXED',
        value: '15.00',
        minCartAmount: '50.00',
        usageLimitTotal: 1,
        usageLimitPerCustomer: 1,
        startsAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 86400_000),
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    if (testProductId) {
      await prisma.product.updateMany({ where: { id: testProductId }, data: { status: ProductStatus.ARCHIVED } });
    }
  });

  it('prevents overselling when two customers simultaneously purchase the final available unit', async () => {
    const key1 = `conc_c1_${crypto.randomUUID()}`;
    const key2 = `conc_c2_${crypto.randomUUID()}`;

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('Idempotency-Key', key1)
        .send({ items: [{ skuId: lastUnitSkuId, warehouseId, quantity: 1 }] }),
      request(app)
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer2Token}`)
        .set('Idempotency-Key', key2)
        .send({ items: [{ skuId: lastUnitSkuId, warehouseId, quantity: 1 }] }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = res1.status === 201 ? res1 : res2;
    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.code).toBe('INSUFFICIENT_STOCK');

    const inv = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: lastUnitSkuId, warehouseId } },
    });
    expect(inv.onHandQty).toBe(1);
    expect(inv.reservedQty).toBe(1);

    // Cleanly cancel winner order to verify stock release back to 0 reserved
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${winner.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Concurrency test cleanup' });
    expect(cancelRes.status).toBe(200);

    const invAfterCancel = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: lastUnitSkuId, warehouseId } },
    });
    expect(invAfterCancel.reservedQty).toBe(0);
  });

  it('releases expired reservations exactly once and cancels unpaid order', async () => {
    // Clear any leftover expired reservations from prior E2E runs first
    await inventoryService.releaseExpiredReservations(100);

    const checkoutRes = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', `exp_test_${crypto.randomUUID()}`)
      .send({ items: [{ skuId: lastUnitSkuId, warehouseId, quantity: 1 }] });
    expect(checkoutRes.status).toBe(201);
    const orderId = checkoutRes.body.data.id as string;
    const reservationId = checkoutRes.body.data.reservations[0].id as string;

    // Simulate TTL expiry in database
    await prisma.inventoryReservation.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // Run two parallel sweeps to prove single-release idempotency
    const [sweep1, sweep2] = await Promise.all([
      inventoryService.releaseExpiredReservations(100),
      inventoryService.releaseExpiredReservations(100),
    ]);
    expect(sweep1.releasedCount + sweep2.releasedCount).toBe(1);

    const releaseLedgerCount = await prisma.inventoryLedger.count({
      where: { referenceType: 'RESERVATION_EXPIRY', referenceId: reservationId },
    });
    expect(releaseLedgerCount).toBe(1);

    const inv = await prisma.inventory.findUniqueOrThrow({
      where: { skuId_warehouseId: { skuId: lastUnitSkuId, warehouseId } },
    });
    expect(inv.reservedQty).toBe(0);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('enforces discount total usage limit and rejects invalid order state transitions', async () => {
    // Use discount once
    const first = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer1Token}`)
      .set('Idempotency-Key', `disc1_${crypto.randomUUID()}`)
      .send({
        discountCode: limitDiscountCode,
        items: [{ skuId: lastUnitSkuId, warehouseId, quantity: 1 }],
      });
    expect(first.status).toBe(201);
    expect(Number(first.body.data.discountAmount)).toBe(15);

    // Invalid state transition PENDING_PAYMENT -> DELIVERED must be rejected
    const badTransition = await request(app)
      .patch(`/api/v1/orders/${first.body.data.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'DELIVERED' });
    expect(badTransition.status).toBe(409);
    expect(badTransition.body.code).toBe('INVALID_ORDER_TRANSITION');

    // Release unit back
    await request(app)
      .post(`/api/v1/orders/${first.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Release for second discount check' });

    // Second customer attempting same 1-use discount gets rejected
    const second = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer2Token}`)
      .set('Idempotency-Key', `disc2_${crypto.randomUUID()}`)
      .send({
        discountCode: limitDiscountCode,
        items: [{ skuId: lastUnitSkuId, warehouseId, quantity: 1 }],
      });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DISCOUNT_USAGE_LIMIT_EXCEEDED');
  });
});
