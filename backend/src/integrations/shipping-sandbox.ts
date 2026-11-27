import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../common/logger';
import { verifyWebhookSignature } from './payment-sandbox';

export const shippingSandboxAdapter = {
  async createShipmentLabel(input: {
    orderNumber: string;
    carrier?: string;
    serviceLevel?: string;
    requestId?: string;
  }): Promise<{ carrier: string; trackingNumber: string; labelUrl: string }> {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const trackingNumber = `SBX-TRK-${code}`;
    const carrier = input.carrier ?? 'SANDBOX_EXPRESS';
    logger.info(
      { requestId: input.requestId, orderNumber: input.orderNumber, trackingNumber, carrier },
      'Created sandbox shipping label',
    );
    return {
      carrier,
      trackingNumber,
      labelUrl: `/api/v1/shipments/sandbox-labels/${trackingNumber}`,
    };
  },

  verifyShippingWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
    return verifyWebhookSignature(rawBody, signatureHeader, env.SHIPPING_WEBHOOK_SECRET);
  },
};
