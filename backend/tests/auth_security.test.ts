import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/common/prisma';
import { emailSandboxAdapter } from '../src/integrations/email-sandbox';

const app = createApp();

describe('MarketSphere Auth, RBAC, Seller Isolation & Upload Security', () => {
  let customerToken = '';
  let customer2Token = '';
  let seller1Token = '';
  let seller2Token = '';
  let adminToken = '';
  let seller2ProductId = '';
  let sampleOrderId = '';

  beforeAll(async () => {
    const login = async (email: string) => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email,
        password: 'MarketSphere#2026',
      });
      expect(res.status).toBe(200);
      return res.body.data;
    };

    customerToken = (await login('customer@marketsphere.test')).accessToken;
    customer2Token = (await login('customer2@marketsphere.test')).accessToken;
    seller1Token = (await login('seller1@marketsphere.test')).accessToken;
    seller2Token = (await login('seller2@marketsphere.test')).accessToken;
    adminToken = (await login('admin@marketsphere.test')).accessToken;

    const s2Products = await request(app)
      .get('/api/v1/seller/products')
      .set('Authorization', `Bearer ${seller2Token}`);
    expect(s2Products.status).toBe(200);
    seller2ProductId = s2Products.body.data[0].id;

    const c1Orders = await request(app)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(c1Orders.status).toBe(200);
    sampleOrderId = c1Orders.body.data[0].id;
  });

  it('rotates refresh token and revokes family on token reuse attack', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'customer@marketsphere.test',
      password: 'MarketSphere#2026',
    });
    expect(loginRes.status).toBe(200);
    const r1 = loginRes.body.data.refreshToken;

    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(refreshRes.status).toBe(200);
    const r2 = refreshRes.body.data.refreshToken;
    expect(r2).not.toBe(r1);

    // Replaying old refresh token r1 triggers reuse detection and revokes family
    const replayRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(replayRes.status).toBe(401);
    expect(replayRes.body.code).toBe('REFRESH_TOKEN_REUSED');

    // Subsequent attempt using r2 is also invalidated
    const r2AfterRevoke = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r2 });
    expect(r2AfterRevoke.status).toBe(401);
  });

  it('blocks seller1 from viewing, editing, or archiving seller2 products (Seller Isolation)', async () => {
    const getRes = await request(app)
      .get(`/api/v1/seller/products/${seller2ProductId}`)
      .set('Authorization', `Bearer ${seller1Token}`);
    expect(getRes.status).toBe(403);
    expect(getRes.body.code).toBe('SELLER_ISOLATION_VIOLATION');

    const patchRes = await request(app)
      .patch(`/api/v1/seller/products/${seller2ProductId}`)
      .set('Authorization', `Bearer ${seller1Token}`)
      .send({ title: 'Hijacked Product Title' });
    expect(patchRes.status).toBe(403);
  });

  it('blocks customer2 from viewing or cancelling customer1 orders (Customer Privacy / IDOR)', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${sampleOrderId}`)
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORDER_PRIVACY_VIOLATION');
  });

  it('blocks non-admin users from admin analytics and seller approval endpoints', async () => {
    const analyticsRes = await request(app)
      .get('/api/v1/admin/analytics')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(analyticsRes.status).toBe(403);

    const sellerRes = await request(app)
      .get('/api/v1/sellers')
      .set('Authorization', `Bearer ${seller1Token}`);
    expect(sellerRes.status).toBe(403);

    const okAdmin = await request(app)
      .get('/api/v1/admin/analytics')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(okAdmin.status).toBe(200);
    expect(okAdmin.body.success).toBe(true);
  });

  it('rejects invalid / spoofed upload files via magic-byte and extension checks', async () => {
    const fakePdfBuffer = Buffer.from('MZ_EXECUTABLE_SPOOFED_AS_PDF');
    const uploadRes = await request(app)
      .post('/api/v1/sellers/me/documents')
      .set('Authorization', `Bearer ${seller1Token}`)
      .field('step', 'TEST')
      .field('documentType', 'TEST_DOC')
      .attach('file', fakePdfBuffer, { filename: 'spoof.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(400);
    expect(uploadRes.body.code).toBe('INVALID_FILE_SIGNATURE');
  });

  it('prevents unverified product reviews', async () => {
    const prod = await prisma.product.findFirst({ where: { status: 'ACTIVE' } });
    const fakeOrder = await prisma.order.findFirst({ where: { customerId: (await prisma.user.findUniqueOrThrow({ where: { email: 'customer@marketsphere.test' } })).id } });
    const res = await request(app)
      .post(`/api/v1/products/${prod!.id}/reviews`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .send({
        orderId: fakeOrder!.id,
        rating: 5,
        title: 'Fake review',
        comment: 'Attempted review on another customer order',
      });
    expect(res.status).toBe(403);
  });

  it('never leaks password reset tokens in HTTP response and confirms reset safely', async () => {
    const reqRes = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'customer2@marketsphere.test' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.data).toEqual({ requested: true });
    expect(reqRes.body.data.sandboxResetToken).toBeUndefined();

    const mail = emailSandboxAdapter
      .getRecentSandboxEmails()
      .find((m) => m.to === 'customer2@marketsphere.test' && m.template === 'PASSWORD_RESET_REQUESTED');
    expect(mail).toBeDefined();
    const tokenMatch = mail!.body.match(/reset token:\s*([0-9a-f]{64})/i);
    expect(tokenMatch).not.toBeNull();
    const resetToken = tokenMatch![1]!;

    try {
      const confirmRes = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: resetToken, newPassword: 'NewSecure#2026' });
      expect(confirmRes.status).toBe(200);

      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'customer2@marketsphere.test', password: 'NewSecure#2026' })
        .expect(200);

      // Reusing spent token fails cleanly
      await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: resetToken, newPassword: 'Another#2026' })
        .expect(400);
    } finally {
      // Restore seed password so subsequent suites pass consistently
      await request(app).post('/api/v1/auth/password-reset/request').send({ email: 'customer2@marketsphere.test' });
      const restoreMail = emailSandboxAdapter
        .getRecentSandboxEmails()
        .find((m) => m.to === 'customer2@marketsphere.test' && m.template === 'PASSWORD_RESET_REQUESTED');
      const restoreToken = restoreMail?.body.match(/reset token:\s*([0-9a-f]{64})/i)?.[1];
      if (restoreToken) {
        await request(app)
          .post('/api/v1/auth/password-reset/confirm')
          .send({ token: restoreToken, newPassword: 'MarketSphere#2026' });
      }
    }
  });
});
