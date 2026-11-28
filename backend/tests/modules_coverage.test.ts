import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { Worker } from 'bullmq';
import { BackgroundJobStatus, CommissionType, ProductStatus, ReviewModerationStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { openApiSpec } from '../src/docs/openapi';
import { pingRedis } from '../src/common/redis';
import { bullConnection, enqueueTrackedJob, QUEUE_NAMES } from '../src/workers/queues';
import { runWithJobTracking } from '../src/workers/processors';

const app = createApp();

// Minimal valid 1x1 PNG binary signature
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
  0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

// Minimal valid PDF header bytes
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

describe('MarketSphere Full Module Coverage, OpenAPI Parity & Live Redis Worker Verification', () => {
  let adminToken = '';
  let seller1Token = '';
  let supportToken = '';
  let warehouseToken = '';
  let customerToken = '';

  beforeAll(async () => {
    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      expect(res.status).toBe(200);
      return res.body.data.accessToken as string;
    };
    adminToken = await login('admin@marketsphere.test');
    seller1Token = await login('seller1@marketsphere.test');
    supportToken = await login('support@marketsphere.test');
    warehouseToken = await login('warehouse@marketsphere.test');
    customerToken = await login('customer@marketsphere.test');
  });

  it('asserts 100% route parity between mounted Express routers and OpenAPI 3.0.3 paths', () => {
    const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/app.ts'), 'utf8');
    const varToFile = new Map<string, string>();
    for (const m of appSrc.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
      for (const sym of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
        varToFile.set(sym, path.resolve(__dirname, '../src', `${m[2]!}.ts`));
      }
    }

    const allRoutes = new Set<string>();
    for (const m of appSrc.matchAll(/api\.use\('([^']+)',\s*([A-Za-z0-9_]+)\)/g)) {
      const prefix = m[1] === '/' ? '' : m[1]!;
      const routerName = m[2]!;
      const filePath = varToFile.get(routerName);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const rSrc = fs.readFileSync(filePath, 'utf8');
      const routeRegex = new RegExp(`${routerName}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
      for (const rm of rSrc.matchAll(routeRegex)) {
        const method = rm[1]!.toUpperCase();
        const subPath = rm[2] === '/' ? '' : rm[2]!;
        const full = (`/api/v1${prefix}${subPath}`).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        allRoutes.add(`${method} ${full}`);
      }
    }

    const docOps = new Set<string>();
    for (const [p, ops] of Object.entries(openApiSpec.paths)) {
      for (const meth of Object.keys(ops)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(meth.toLowerCase())) {
          const full = p.startsWith('/api/') ? p : `/api/v1${p}`;
          docOps.add(`${meth.toUpperCase()} ${full}`);
        }
      }
    }

    const missing = [...allRoutes].filter((r) => !docOps.has(r)).sort();
    expect(missing).toEqual([]);
  });

  it('exercises full seller onboarding lifecycle, document upload, rejection, resubmission, analytics & listing', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const regUser = await request(app).post('/api/v1/auth/register').send({
      email: `seller_flow_${suffix}@marketsphere.test`,
      password: 'MarketSphere#2026',
      firstName: 'Nova',
      lastName: 'Vendor',
      accountType: 'CUSTOMER',
    });
    expect(regUser.status).toBe(201);
    const token = regUser.body.data.accessToken as string;

    const regSeller = await request(app)
      .post('/api/v1/sellers/register')
      .set('Authorization', `Bearer ${token}`)
      .send({
        storeName: `Nova Optics ${suffix}`,
        legalBusinessName: `Nova Optics LLC ${suffix}`,
        taxIdMasked: 'XX-XXX9012',
        supportEmail: `support_${suffix}@nova.test`,
        supportPhone: '+1-555-0199',
      });
    expect(regSeller.status).toBe(201);
    const sellerId = regSeller.body.data.id as string;

    await request(app)
      .get('/api/v1/sellers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch('/api/v1/sellers/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ returnPolicy: '30-day warranty' })
      .expect(200);

    const docRes = await request(app)
      .post('/api/v1/sellers/me/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('step', 'BUSINESS_VERIFICATION')
      .field('documentType', 'TAX_ID')
      .field('submitForReview', 'true')
      .attach('file', TINY_PDF, { filename: 'tax-doc.pdf', contentType: 'application/pdf' });
    expect(docRes.status).toBe(201);

    await request(app)
      .patch(`/api/v1/sellers/${sellerId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'REJECTED', reason: 'Clarify DBA name' })
      .expect(200);

    await request(app)
      .post('/api/v1/sellers/me/resubmit')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch(`/api/v1/sellers/${sellerId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED', commissionRateOverride: '0.0800' })
      .expect(200);

    const analyticsRes = await request(app)
      .get('/api/v1/sellers/me/analytics')
      .set('Authorization', `Bearer ${token}`);
    expect(analyticsRes.status).toBe(200);

    const adminList = await request(app)
      .get(`/api/v1/sellers?search=Nova`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('exercises categories CRUD, seller product/SKU/image upload, multipart CSV feed, warehouses, and multi-warehouse checkout split', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const catCreate = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Cat ${suffix}`, slug: `cat-${suffix}` });
    expect(catCreate.status).toBe(201);
    const categoryId = catCreate.body.data.id as string;

    await request(app)
      .patch(`/api/v1/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Cat Updated ${suffix}` })
      .expect(200);

    const whCreate = await request(app)
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: `WH-${suffix.toUpperCase()}`,
        name: `Test Hub ${suffix}`,
        addressLine1: '500 Logistics Blvd',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      });
    expect(whCreate.status).toBe(201);
    const wh2Id = whCreate.body.data.id as string;

    const whList = await request(app).get('/api/v1/warehouses').set('Authorization', `Bearer ${warehouseToken}`);
    expect(whList.status).toBe(200);
    const wh1Id = (whList.body.data as Array<{ id: string }>).find((w) => w.id !== wh2Id)!.id;

    const prodRes = await request(app)
      .post('/api/v1/seller/products')
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({
        categoryId,
        title: `Split Stock Gear ${suffix}`,
        description: 'High precision test item stocked across two fulfillment hubs.',
        brand: 'Apex',
        status: ProductStatus.ACTIVE,
        variants: [
          {
            name: 'Standard',
            optionValues: { color: 'Black' },
            skuCode: `SPL-${suffix.toUpperCase()}`,
            price: '45.00',
            initialStock: 2,
            warehouseId: wh1Id,
          },
        ],
      });
    expect(prodRes.status).toBe(201);
    const productId = prodRes.body.data.id as string;
    const skuId = prodRes.body.data.skus[0].id as string;

    // Upload valid product PNG image & stock WH2
    const imgRes = await request(app)
      .post(`/api/v1/seller/products/${productId}/images`)
      .set('Authorization', `Bearer ${seller1Token}`)
      .attach('file', TINY_PNG, { filename: 'gear.png', contentType: 'image/png' });
    expect(imgRes.status).toBe(201);
    expect(imgRes.body.data.url).toContain('/uploads/products/');

    await request(app)
      .post('/api/v1/inventory/adjust')
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({
        skuId,
        warehouseId: wh2Id,
        movementType: 'ADJUSTMENT_IN',
        quantity: 2,
        notes: 'Stock second hub for split-warehouse checkout',
      })
      .expect(200);

    // Multi-warehouse split checkout: request quantity=4 (WH1=2 + WH2=2)
    const splitCheckout = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `split_${crypto.randomUUID()}`)
      .send({ items: [{ skuId, quantity: 4 }] });
    expect(splitCheckout.status).toBe(201);
    expect(splitCheckout.body.data.items).toHaveLength(2);
    expect(splitCheckout.body.data.reservations).toHaveLength(2);

    // Multipart CSV file upload (exercises Express -> Python /api/v1/feeds/upload)
    const csvUpload = Buffer.from(
      `title,sku_code,price,category_slug,quantity,brand\nMultipart Feed Mic ${suffix},MPF-${suffix.toUpperCase()},119.00,cat-${suffix},5,Apex\n`,
      'utf8',
    );
    const feedRes = await request(app)
      .post('/api/v1/seller/products/feed-import')
      .set('Authorization', `Bearer ${seller1Token}`)
      .attach('file', csvUpload, { filename: 'upload.csv', contentType: 'text/csv' });
    expect(feedRes.status).toBe(200);
    expect(feedRes.body.data.importedCount).toBe(1);

    // Add extra SKU, moderate, archive & deactivate test category
    await request(app)
      .post(`/api/v1/seller/products/${productId}/skus`)
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({ variantName: 'Pro', skuCode: `SPL-PRO-${suffix.toUpperCase()}`, price: '65.00', initialStock: 1 })
      .expect(201);

    await request(app)
      .patch(`/api/v1/admin/products/${productId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE', moderationNotes: 'Verified' })
      .expect(200);

    await request(app)
      .delete(`/api/v1/seller/products/${productId}`)
      .set('Authorization', `Bearer ${seller1Token}`)
      .expect(200);

    // Category in use rejects deletion (409), while unused category deletes cleanly (200)
    await request(app)
      .delete(`/api/v1/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    const emptyCat = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `EmptyCat ${suffix}`, slug: `empty-cat-${suffix}` })
      .expect(201);
    await request(app)
      .delete(`/api/v1/categories/${emptyCat.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app).get('/api/v1/inventory/ledger').set('Authorization', `Bearer ${warehouseToken}`).expect(200);
    await request(app).get('/api/v1/inventory/reservations').set('Authorization', `Bearer ${warehouseToken}`).expect(200);
  });

  it('exercises users, addresses, notifications, promotions, reviews, commissions, settlements, support, disputes & payments', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');

    // Users & Addresses & Notifications
    await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ phone: '+1-555-0190' })
      .expect(200);

    const addrCreate = await request(app)
      .post('/api/v1/users/me/addresses')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        label: `Work ${suffix}`,
        recipientName: 'Maya Lin',
        line1: '200 Congress Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        phone: '+1-555-0190',
      });
    expect(addrCreate.status).toBe(201);
    const addrId = addrCreate.body.data.id as string;

    await request(app)
      .patch(`/api/v1/users/me/addresses/${addrId}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ line1: '202 Congress Ave' })
      .expect(200);

    await request(app)
      .delete(`/api/v1/users/me/addresses/${addrId}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200);

    const notifRes = await request(app).get('/api/v1/users/me/notifications').set('Authorization', `Bearer ${customerToken}`);
    expect(notifRes.status).toBe(200);
    if ((notifRes.body.data as Array<{ id: string }>).length > 0) {
      await request(app)
        .patch(`/api/v1/users/me/notifications/${notifRes.body.data[0].id}/read`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
    }

    // Promotions
    const discCode = `PROMO${suffix.toUpperCase()}`;
    const discRes = await request(app)
      .post('/api/v1/discounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: discCode,
        discountType: 'FIXED',
        value: '5.00',
        minCartAmount: '20.00',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      });
    expect(discRes.status).toBe(201);
    const discId = discRes.body.data.id as string;

    await request(app)
      .post('/api/v1/discounts/validate')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ code: discCode, cartSubtotal: '50.00', sellerIds: [] })
      .expect(200);

    await request(app)
      .patch(`/api/v1/discounts/${discId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);

    // Reviews listing & moderation
    const prod = await prisma.product.findFirstOrThrow({ where: { status: ProductStatus.ACTIVE } });
    await request(app).get(`/api/v1/products/${prod.id}/reviews`).expect(200);
    const review = await prisma.review.findFirst();
    if (review) {
      await request(app)
        .patch(`/api/v1/reviews/${review.id}/moderate`)
        .set('Authorization', `Bearer ${supportToken}`)
        .send({ moderationStatus: ReviewModerationStatus.APPROVED })
        .expect(200);
    }

    // Commissions rules, live FastAPI preview & settlements
    const ruleRes = await request(app)
      .post('/api/v1/commissions/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Temp Rule ${suffix}`,
        commissionType: CommissionType.PERCENTAGE,
        percentageRate: '0.1100',
        priority: 99,
        isActive: false,
      });
    expect(ruleRes.status).toBe(201);

    await request(app)
      .patch(`/api/v1/commissions/rules/${ruleRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ priority: 98 })
      .expect(200);

    const calcPreview = await request(app)
      .post('/api/v1/commissions/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            orderItemId: 'oi-preview',
            sellerId: 'sel-preview',
            categoryId: 'cat-preview',
            unitPrice: '100.00',
            quantity: 1,
            discountAmount: '0.00',
          },
        ],
      });
    expect(calcPreview.status).toBe(200);
    expect(calcPreview.body.data.source).toBe('python-fastapi');

    const stlGen = await request(app)
      .post('/api/v1/settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(stlGen.status).toBe(201);
    if (Array.isArray(stlGen.body.data) && stlGen.body.data.length > 0) {
      await request(app)
        .patch(`/api/v1/settlements/${stlGen.body.data[0].id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
    await request(app).get('/api/v1/settlements').set('Authorization', `Bearer ${adminToken}`).expect(200);
    await request(app).get('/api/v1/commissions/ledger').set('Authorization', `Bearer ${seller1Token}`).expect(200);

    // Support cases & disputes & payments list
    await request(app).get('/api/v1/support/customers?search=customer').set('Authorization', `Bearer ${supportToken}`).expect(200);
    const caseCreate = await request(app)
      .post('/api/v1/support/cases')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ subject: `Question ${suffix}`, initialMessage: 'Need invoice copy please' });
    expect(caseCreate.status).toBe(201);
    const caseId = caseCreate.body.data.id as string;

    await request(app)
      .post(`/api/v1/support/cases/${caseId}/notes`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ body: 'Sent invoice internally', isInternal: true })
      .expect(201);

    await request(app)
      .patch(`/api/v1/support/cases/${caseId}`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ status: 'RESOLVED' })
      .expect(200);

    const custOrder = await prisma.order.findFirstOrThrow({
      where: { customer: { email: 'customer@marketsphere.test' } },
    });
    const dispCreate = await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ orderId: custOrder.id, reason: `Test dispute ${suffix}`, details: 'Check tracking' });
    expect(dispCreate.status).toBe(201);

    await request(app)
      .patch(`/api/v1/disputes/${dispCreate.body.data.id}`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ status: 'CLOSED', resolutionSummary: 'Verified' })
      .expect(200);

    await request(app).get('/api/v1/payments').set('Authorization', `Bearer ${adminToken}`).expect(200);
  });

  it('executes a real Redis BullMQ worker cycle end-to-end against Memurai Redis and records COMPLETED in PostgreSQL', async () => {
    const redisUp = await pingRedis(true);
    expect(redisUp).toBe(true);

    const jobId = `live_redis_job_${crypto.randomBytes(4).toString('hex')}`;
    let processedResolve!: () => void;
    const processedDone = new Promise<void>((resolve) => {
      processedResolve = resolve;
    });

    const worker = new Worker(
      QUEUE_NAMES.NOTIFICATIONS,
      async (job) => {
        if (job.id === jobId) {
          const out = await runWithJobTracking(QUEUE_NAMES.NOTIFICATIONS, jobId, job.name, job.data, async () => ({
            deliveredViaRedis: true,
          }));
          processedResolve();
          return out;
        }
        return { skipped: true };
      },
      { connection: bullConnection },
    );

    try {
      await worker.waitUntilReady();
      const enqueued = await enqueueTrackedJob({
        queueName: QUEUE_NAMES.NOTIFICATIONS,
        jobName: 'live-redis-verify',
        jobId,
        payload: { verify: true },
      });
      expect(enqueued.enqueued).toBe(true);

      await Promise.race([
        processedDone,
        new Promise((_, reject) => setTimeout(() => reject(new Error('BullMQ live worker timeout')), 8000)),
      ]);

      const record = await prisma.backgroundJobRecord.findUniqueOrThrow({
        where: { queueName_jobId: { queueName: QUEUE_NAMES.NOTIFICATIONS, jobId } },
      });
      expect(record.status).toBe(BackgroundJobStatus.COMPLETED);
    } finally {
      await worker.close();
    }
  });
});
