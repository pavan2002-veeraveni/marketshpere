import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../common/logger';

export interface SandboxPaymentIntentRequest {
  orderId: string;
  orderNumber: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  requestId?: string;
}

export interface SandboxPaymentIntentResponse {
  provider: 'SANDBOX_PAY';
  providerPaymentId: string;
  status: 'INITIATED';
  checkoutToken: string;
}

export interface SandboxRefundResponse {
  providerRefundId: string;
  status: 'SUCCEEDED';
  processedAt: string;
}

export function signWebhookPayload(payloadString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

export function verifyWebhookSignature(rawPayload: string, providedSig: string | undefined, secret: string): boolean {
  if (!providedSig) return false;
  const normalized = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;
  const expected = signWebhookPayload(rawPayload, secret);
  const a = Buffer.from(normalized, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const paymentSandboxAdapter = {
  async initiatePayment(input: SandboxPaymentIntentRequest): Promise<SandboxPaymentIntentResponse> {
    // Deterministic provider payment id derived safely from idempotency key
    const digest = crypto.createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16);
    const providerPaymentId = `pay_sbx_${digest}`;
    logger.info(
      { requestId: input.requestId, orderId: input.orderId, providerPaymentId, amount: input.amount },
      'Initiated sandbox payment intent',
    );
    return {
      provider: 'SANDBOX_PAY',
      providerPaymentId,
      status: 'INITIATED',
      checkoutToken: `tok_sbx_${digest}`,
    };
  },

  async issueRefund(input: {
    providerPaymentId: string;
    amount: string;
    idempotencyKey: string;
    requestId?: string;
  }): Promise<SandboxRefundResponse> {
    const digest = crypto.createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16);
    const providerRefundId = `re_sbx_${digest}`;
    logger.info(
      { requestId: input.requestId, providerPaymentId: input.providerPaymentId, providerRefundId, amount: input.amount },
      'Processed sandbox refund',
    );
    return {
      providerRefundId,
      status: 'SUCCEEDED',
      processedAt: new Date().toISOString(),
    };
  },

  verifyPaymentWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
    return verifyWebhookSignature(rawBody, signatureHeader, env.PAYMENT_WEBHOOK_SECRET);
  },
};
