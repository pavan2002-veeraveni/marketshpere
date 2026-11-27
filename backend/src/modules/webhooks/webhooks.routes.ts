import { Router, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ShipmentStatus } from '@prisma/client';
import { sendSuccess } from '../../common/response';
import { paymentsService } from '../payments/payments.routes';
import { shippingService } from '../shipping/shipping.routes';
import { shippingSandboxAdapter } from '../../integrations/shipping-sandbox';
import { UnauthorizedError } from '../../common/errors';
import { validateRequest } from '../../common/middleware/validate';
import { enqueueTrackedJob, QUEUE_NAMES } from '../../workers/queues';

const paymentWebhookSchema = z.object({
  body: z.object({
    eventId: z.string().min(4).max(140),
    eventType: z.enum(['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'REFUND_SUCCEEDED']),
    providerPaymentId: z.string().min(4).max(120),
    providerRefundId: z.string().optional(),
    failureCode: z.string().optional(),
    failureMessage: z.string().optional(),
    amount: z.string().optional(),
  }),
});

const shippingWebhookSchema = z.object({
  body: z.object({
    eventId: z.string().min(4).max(140),
    trackingNumber: z.string().min(4).max(120),
    status: z.nativeEnum(ShipmentStatus),
    location: z.string().optional(),
    description: z.string().optional(),
    failedReason: z.string().optional(),
  }),
});

export const webhooksRouter = Router();

webhooksRouter.post(
  '/payments',
  validateRequest(paymentWebhookSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawPayload = req.rawBody ?? JSON.stringify(req.body);
      const sig = req.header('x-marketplace-signature');
      const result = await paymentsService.processPaymentWebhook({
        rawPayload,
        signatureHeader: sig,
        payload: req.body,
        requestId: req.requestId,
      });
      return sendSuccess(req, res, result, result.idempotent ? 'Duplicate webhook ignored idempotently' : 'Webhook processed');
    } catch (err) {
      next(err);
    }
  },
);

webhooksRouter.post(
  '/shipping',
  validateRequest(shippingWebhookSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawPayload = req.rawBody ?? JSON.stringify(req.body);
      const sig = req.header('x-marketplace-signature');
      if (req.query.async === 'true') {
        if (!shippingSandboxAdapter.verifyShippingWebhookSignature(rawPayload, sig)) {
          throw new UnauthorizedError('Invalid shipping webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
        }
        const job = await enqueueTrackedJob({
          queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
          jobName: 'shipping-status-callback',
          jobId: `shp-cb-${req.body.eventId}`,
          payload: req.body,
        });
        return sendSuccess(req, res, { queued: true, ...job }, 'Shipping webhook queued for worker processing', 202);
      }

      const result = await shippingService.processShippingWebhook({
        rawPayload,
        signatureHeader: sig,
        payload: req.body,
      });
      return sendSuccess(
        req,
        res,
        result,
        result.idempotent ? 'Duplicate shipping webhook ignored idempotently' : 'Shipping webhook processed',
      );
    } catch (err) {
      next(err);
    }
  },
);
