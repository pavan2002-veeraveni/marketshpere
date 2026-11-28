import { Router, NextFunction, Request, Response } from 'express';
import {
  OrderItemFulfillmentStatus,
  OrderStatus,
  RoleName,
  ShipmentStatus,
  WebhookEventStatus,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../common/errors';
import { shippingSandboxAdapter } from '../../integrations/shipping-sandbox';
import { recordAuditLog } from '../../common/audit';

const createShipmentSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    warehouseId: z.string().uuid().optional(),
    carrier: z.string().trim().max(80).default('SANDBOX_EXPRESS'),
    serviceLevel: z.string().trim().max(60).default('STANDARD'),
    orderItemIds: z.array(z.string().uuid()).optional(),
  }),
});

const updateShipmentStatusSchema = z.object({
  params: z.object({ shipmentId: z.string().uuid() }),
  body: z.object({
    status: z.nativeEnum(ShipmentStatus),
    location: z.string().trim().max(180).optional(),
    description: z.string().trim().max(500).optional(),
    failedReason: z.string().trim().max(500).optional(),
  }),
});

const CAN_ADVANCE_ORDER_FOR_SHIPMENT: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.SHIPPED]: [OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, OrderStatus.READY_TO_SHIP],
  [OrderStatus.OUT_FOR_DELIVERY]: [
    OrderStatus.PAYMENT_CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.READY_TO_SHIP,
    OrderStatus.SHIPPED,
  ],
  [OrderStatus.DELIVERED]: [
    OrderStatus.PAYMENT_CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.READY_TO_SHIP,
    OrderStatus.SHIPPED,
    OrderStatus.OUT_FOR_DELIVERY,
  ],
};

function canAdvanceOrderFromShipment(current: OrderStatus, target: OrderStatus | null | undefined): target is OrderStatus {
  if (!target || current === target) return false;
  return (CAN_ADVANCE_ORDER_FOR_SHIPMENT[target] ?? []).includes(current);
}

export const shippingService = {
  async processShippingWebhook(params: {
    rawPayload: string;
    signatureHeader?: string;
    payload: {
      eventId: string;
      trackingNumber: string;
      status: ShipmentStatus;
      location?: string;
      description?: string;
      failedReason?: string;
    };
  }) {
    if (!shippingSandboxAdapter.verifyShippingWebhookSignature(params.rawPayload, params.signatureHeader)) {
      throw new UnauthorizedError('Invalid shipping webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
    }

    const provider = 'SANDBOX_SHIP';
    const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO webhook_events (id, provider, provider_event_id, event_type, signature_valid, payload, status, created_at, updated_at)
      VALUES (gen_random_uuid(), ${provider}, ${params.payload.eventId}, ${params.payload.status}, true, ${JSON.stringify(params.payload)}::jsonb, 'RECEIVED', NOW(), NOW())
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;
    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider, providerEventId: params.payload.eventId } },
    });
    if (inserted.length === 0 && event.status === WebhookEventStatus.PROCESSED) {
      return { idempotent: true, processed: false, eventId: params.payload.eventId };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const lockedEvents = await tx.$queryRaw<Array<{ id: string; status: WebhookEventStatus }>>`
          SELECT id, status FROM webhook_events WHERE id = ${event.id}::uuid FOR UPDATE
        `;
        if (lockedEvents[0]?.status === WebhookEventStatus.PROCESSED) {
          return { idempotent: true, processed: false, eventId: params.payload.eventId };
        }

        const shipment = await tx.shipment.findUnique({
          where: { trackingNumber: params.payload.trackingNumber },
          include: { order: true },
        });
        if (!shipment) {
          throw new NotFoundError('Shipment tracking number not found');
        }

        await tx.$executeRaw`
          INSERT INTO shipment_events (id, shipment_id, provider_event_id, status, location, description, occurred_at, raw_payload)
          VALUES (gen_random_uuid(), ${shipment.id}::uuid, ${params.payload.eventId}, ${params.payload.status}, ${params.payload.location ?? null}, ${params.payload.description ?? null}, NOW(), ${JSON.stringify(params.payload)}::jsonb)
          ON CONFLICT (shipment_id, provider_event_id) DO NOTHING
        `;

        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            status: params.payload.status,
            shippedAt: params.payload.status === ShipmentStatus.IN_TRANSIT ? shipment.shippedAt ?? new Date() : shipment.shippedAt,
            deliveredAt: params.payload.status === ShipmentStatus.DELIVERED ? new Date() : shipment.deliveredAt,
            failedReason: params.payload.status === ShipmentStatus.FAILED ? params.payload.failedReason ?? 'Carrier delivery exception' : shipment.failedReason,
          },
        });

        const orderStatusMap: Partial<Record<ShipmentStatus, OrderStatus>> = {
          [ShipmentStatus.IN_TRANSIT]: OrderStatus.SHIPPED,
          [ShipmentStatus.OUT_FOR_DELIVERY]: OrderStatus.OUT_FOR_DELIVERY,
          [ShipmentStatus.DELIVERED]: OrderStatus.DELIVERED,
        };
        const targetOrderStatus = orderStatusMap[params.payload.status];
        if (canAdvanceOrderFromShipment(shipment.order.status, targetOrderStatus)) {
          await tx.order.update({ where: { id: shipment.orderId }, data: { status: targetOrderStatus } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: shipment.orderId,
              fromStatus: shipment.order.status,
              toStatus: targetOrderStatus,
              reason: `Carrier webhook update: ${params.payload.status}`,
            },
          });
          if (targetOrderStatus === OrderStatus.DELIVERED) {
            await tx.orderItem.updateMany({
              where: { orderId: shipment.orderId, sellerId: shipment.sellerId },
              data: { fulfillmentStatus: OrderItemFulfillmentStatus.DELIVERED },
            });
          }
        }

        if (params.payload.status === ShipmentStatus.FAILED) {
          await tx.notification.create({
            data: {
              userId: shipment.order.customerId,
              type: 'SHIPMENT_FAILED',
              title: `Delivery alert for ${shipment.order.orderNumber}`,
              message: params.payload.failedReason ?? 'Carrier reported a delivery issue.',
            },
          });
        }

        await tx.webhookEvent.update({
          where: { id: event.id },
          data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date(), lastError: null },
        });

        return { idempotent: false, processed: true, eventId: params.payload.eventId };
      });
    } catch (err) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: WebhookEventStatus.FAILED,
          retryCount: { increment: 1 },
          lastError: err instanceof Error ? err.message : 'Shipping webhook failed',
        },
      });
      throw err;
    }
  },
};

export const shipmentsRouter = Router();
shipmentsRouter.use(authenticate);

shipmentsRouter.get(
  '/',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN, RoleName.SUPPORT_AGENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isSellerOnly =
        req.user!.roles.includes(RoleName.SELLER) &&
        !req.user!.roles.includes(RoleName.ADMIN) &&
        !req.user!.roles.includes(RoleName.WAREHOUSE_OPERATOR) &&
        !req.user!.roles.includes(RoleName.SUPPORT_AGENT);

      const items = await prisma.shipment.findMany({
        where: isSellerOnly ? { sellerId: req.user!.sellerId ?? '__none__' } : {},
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          order: { select: { orderNumber: true, status: true } },
          warehouse: { select: { code: true, name: true } },
          seller: { select: { storeName: true } },
          events: { orderBy: { occurredAt: 'desc' }, take: 5 },
        },
      });
      return sendSuccess(req, res, items, 'Shipments retrieved');
    } catch (err) {
      next(err);
    }
  },
);

shipmentsRouter.post(
  '/',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(createShipmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.body.orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundError('Order not found');
      if (
        order.status !== OrderStatus.PAYMENT_CONFIRMED &&
        order.status !== OrderStatus.PROCESSING &&
        order.status !== OrderStatus.READY_TO_SHIP
      ) {
        throw new ConflictError(`Cannot create shipment when order is ${order.status}`);
      }

      const sellerItems =
        req.user!.roles.includes(RoleName.SELLER) && req.user!.sellerId
          ? order.items.filter((i) => i.sellerId === req.user!.sellerId)
          : req.body.orderItemIds?.length
            ? order.items.filter((i) => req.body.orderItemIds.includes(i.id))
            : order.items;

      if (sellerItems.length === 0) {
        throw new ForbiddenError('No matching order items to ship');
      }

      const targetItem = sellerItems[0]!;
      const label = await shippingSandboxAdapter.createShipmentLabel({
        orderNumber: order.orderNumber,
        carrier: req.body.carrier,
        serviceLevel: req.body.serviceLevel,
        requestId: req.requestId,
      });

      const shipment = await prisma.$transaction(async (tx) => {
        const created = await tx.shipment.create({
          data: {
            orderId: order.id,
            sellerId: targetItem.sellerId,
            warehouseId: req.body.warehouseId ?? targetItem.warehouseId,
            carrier: label.carrier,
            serviceLevel: req.body.serviceLevel,
            trackingNumber: label.trackingNumber,
            status: ShipmentStatus.READY_TO_SHIP,
            events: {
              create: {
                providerEventId: `init_${label.trackingNumber}`,
                status: ShipmentStatus.READY_TO_SHIP,
                description: 'Sandbox carrier label generated',
                rawPayload: label,
              },
            },
          },
          include: { events: true },
        });

        await tx.orderItem.updateMany({
          where: { id: { in: sellerItems.map((i) => i.id) } },
          data: { fulfillmentStatus: OrderItemFulfillmentStatus.READY_TO_SHIP },
        });

        // If all items are now ready or shipped, move order to READY_TO_SHIP
        const unreadyCount = await tx.orderItem.count({
          where: {
            orderId: order.id,
            fulfillmentStatus: {
              notIn: [
                OrderItemFulfillmentStatus.READY_TO_SHIP,
                OrderItemFulfillmentStatus.SHIPPED,
                OrderItemFulfillmentStatus.DELIVERED,
              ],
            },
          },
        });

        if (unreadyCount === 0 && order.status !== OrderStatus.READY_TO_SHIP) {
          await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.READY_TO_SHIP } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: OrderStatus.READY_TO_SHIP,
              reason: 'All items packed and ready for carrier handoff',
              changedByUserId: req.user!.userId,
            },
          });
        }

        await recordAuditLog(tx, {
          actorUserId: req.user!.userId,
          actorRole: req.user!.roles[0],
          action: 'SHIPMENT_CREATED',
          resourceType: 'SHIPMENT',
          resourceId: created.id,
          requestId: req.requestId,
          afterState: { trackingNumber: created.trackingNumber },
        });
        return created;
      });

      return sendSuccess(req, res, shipment, 'Shipment created', 201);
    } catch (err) {
      next(err);
    }
  },
);

shipmentsRouter.patch(
  '/:shipmentId/status',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(updateShipmentStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const shipment = await prisma.shipment.findUnique({
        where: { id: req.params.shipmentId },
        include: { order: true },
      });
      if (!shipment) throw new NotFoundError('Shipment not found');
      if (
        req.user!.roles.includes(RoleName.SELLER) &&
        !req.user!.roles.includes(RoleName.ADMIN) &&
        !req.user!.roles.includes(RoleName.WAREHOUSE_OPERATOR) &&
        shipment.sellerId !== req.user!.sellerId
      ) {
        throw new ForbiddenError('Cannot update another seller shipment');
      }

      const nextStatus: ShipmentStatus = req.body.status;
      const updated = await prisma.$transaction(async (tx) => {
        const s = await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            status: nextStatus,
            shippedAt: nextStatus === ShipmentStatus.IN_TRANSIT ? shipment.shippedAt ?? new Date() : shipment.shippedAt,
            deliveredAt: nextStatus === ShipmentStatus.DELIVERED ? new Date() : shipment.deliveredAt,
            failedReason: nextStatus === ShipmentStatus.FAILED ? req.body.failedReason : shipment.failedReason,
          },
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: shipment.id,
            providerEventId: `manual_${Date.now()}`,
            status: nextStatus,
            location: req.body.location,
            description: req.body.description ?? `Status updated to ${nextStatus}`,
            rawPayload: req.body,
          },
        });

        const orderTarget =
          nextStatus === ShipmentStatus.IN_TRANSIT
            ? OrderStatus.SHIPPED
            : nextStatus === ShipmentStatus.OUT_FOR_DELIVERY
              ? OrderStatus.OUT_FOR_DELIVERY
              : nextStatus === ShipmentStatus.DELIVERED
                ? OrderStatus.DELIVERED
                : null;

        if (canAdvanceOrderFromShipment(shipment.order.status, orderTarget)) {
          await tx.order.update({ where: { id: shipment.orderId }, data: { status: orderTarget } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: shipment.orderId,
              fromStatus: shipment.order.status,
              toStatus: orderTarget,
              reason: `Shipment updated to ${nextStatus}`,
              changedByUserId: req.user!.userId,
            },
          });
          if (orderTarget === OrderStatus.SHIPPED || orderTarget === OrderStatus.DELIVERED) {
            await tx.orderItem.updateMany({
              where: { orderId: shipment.orderId, sellerId: shipment.sellerId },
              data: {
                fulfillmentStatus:
                  orderTarget === OrderStatus.DELIVERED
                    ? OrderItemFulfillmentStatus.DELIVERED
                    : OrderItemFulfillmentStatus.SHIPPED,
              },
            });
          }
        }
        return s;
      });

      return sendSuccess(req, res, updated, 'Shipment status updated');
    } catch (err) {
      next(err);
    }
  },
);
