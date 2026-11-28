import crypto from 'crypto';
import { Router, NextFunction, Request, Response } from 'express';
import { OrderStatus, PaymentStatus, ProductStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../common/prisma';
import { authenticate } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { recordAuditLog } from '../../common/audit';
import { pythonClient } from '../../integrations/python-client';
import { paymentSandboxAdapter } from '../../integrations/payment-sandbox';
import { inventoryService } from '../inventory/inventory.service';
import { promotionsService } from '../promotions/promotions.routes';
import { enqueueTrackedJob, QUEUE_NAMES } from '../../workers/queues';

const checkoutSchema = z.object({
  body: z.object({
    addressId: z.string().uuid().optional(),
    shippingAddress: z
      .object({
        recipientName: z.string().trim().min(1),
        line1: z.string().trim().min(1),
        line2: z.string().trim().optional(),
        city: z.string().trim().min(1),
        state: z.string().trim().min(1),
        postalCode: z.string().trim().min(2),
        country: z.string().trim().default('US'),
        phone: z.string().trim().min(4),
      })
      .optional(),
    discountCode: z.string().trim().optional(),
    idempotencyKey: z.string().trim().min(8).max(160).optional(),
    items: z
      .array(
        z.object({
          skuId: z.string().uuid(),
          quantity: z.coerce.number().int().min(1).max(50),
          warehouseId: z.string().uuid().optional(),
        }),
      )
      .optional(),
  }),
});

export const checkoutRouter = Router();
checkoutRouter.use(authenticate);

checkoutRouter.post('/', validateRequest(checkoutSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const idempotencyKey =
      req.header('idempotency-key') ??
      req.body.idempotencyKey ??
      `chk_${userId}_${crypto.randomUUID()}`;

    // Idempotent replay check
    const existingOrder = await prisma.order.findUnique({
      where: { idempotencyKey },
      include: { items: true, payments: true, reservations: true },
    });
    if (existingOrder) {
      return sendSuccess(req, res, existingOrder, 'Checkout retrieved idempotently', 200);
    }

    // Resolve shipping address
    let shippingAddressSnapshot = req.body.shippingAddress;
    if (!shippingAddressSnapshot && req.body.addressId) {
      const addr = await prisma.address.findFirst({
        where: { id: req.body.addressId, userId },
      });
      if (!addr) throw new NotFoundError('Shipping address not found');
      shippingAddressSnapshot = {
        recipientName: addr.recipientName,
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postalCode,
        country: addr.country,
        phone: addr.phone,
      };
    }
    if (!shippingAddressSnapshot) {
      const defaultAddr = await prisma.address.findFirst({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      if (!defaultAddr) {
        throw new ValidationError('Shipping address is required for checkout', [], 'SHIPPING_ADDRESS_REQUIRED');
      }
      shippingAddressSnapshot = {
        recipientName: defaultAddr.recipientName,
        line1: defaultAddr.line1,
        line2: defaultAddr.line2,
        city: defaultAddr.city,
        state: defaultAddr.state,
        postalCode: defaultAddr.postalCode,
        country: defaultAddr.country,
        phone: defaultAddr.phone,
      };
    }

    // Load items from explicit payload or persisted cart
    let requestedItems: Array<{ skuId: string; quantity: number; warehouseId?: string }> = req.body.items ?? [];
    let cartIdToClear: string | null = null;
    if (requestedItems.length === 0) {
      const cart = await prisma.cart.findUnique({
        where: { userId },
        include: { items: true },
      });
      if (!cart || cart.items.length === 0) {
        throw new ValidationError('Cart is empty', [], 'CART_EMPTY');
      }
      cartIdToClear = cart.id;
      requestedItems = cart.items.map((i) => ({ skuId: i.skuId, quantity: i.quantity }));
    }

    // Fetch authoritative SKUs, products & warehouses from DB (NEVER trust client prices)
    const skuIds = requestedItems.map((i) => i.skuId);
    const skus = await prisma.sku.findMany({
      where: { id: { in: skuIds }, isActive: true, deletedAt: null },
      include: {
        product: {
          include: { seller: true },
        },
        inventories: {
          orderBy: { onHandQty: 'desc' },
        },
      },
    });
    const skuMap = new Map(skus.map((s) => [s.id, s]));

    const mergedLinesMap = new Map<
      string,
      { sku: (typeof skus)[number]; warehouseId: string; quantity: number }
    >();
    const addResolvedLine = (sku: (typeof skus)[number], warehouseId: string, quantity: number) => {
      const mergeKey = `${sku.id}:${warehouseId}`;
      const prev = mergedLinesMap.get(mergeKey);
      if (prev) {
        const nextQty = prev.quantity + quantity;
        if (nextQty > 50) {
          throw new ValidationError(
            `Maximum quantity per checkout line is 50 for SKU ${sku.skuCode}`,
            [],
            'MAX_LINE_QTY_EXCEEDED',
          );
        }
        prev.quantity = nextQty;
      } else {
        mergedLinesMap.set(mergeKey, { sku, warehouseId, quantity });
      }
    };

    for (const reqItem of requestedItems) {
      const sku = skuMap.get(reqItem.skuId);
      if (!sku || sku.product.status !== ProductStatus.ACTIVE || sku.product.seller.onboardingStatus !== 'APPROVED') {
        throw new ValidationError(`SKU ${reqItem.skuId} is unavailable for purchase`, [], 'SKU_UNAVAILABLE');
      }

      if (reqItem.warehouseId) {
        const explicitInv = sku.inventories.find((inv) => inv.warehouseId === reqItem.warehouseId);
        if (!explicitInv) {
          throw new ConflictError(`Insufficient stock for SKU ${sku.skuCode}`, 'INSUFFICIENT_STOCK');
        }
        addResolvedLine(sku, explicitInv.warehouseId, reqItem.quantity);
        continue;
      }

      const sortedInvs = [...sku.inventories].sort(
        (a, b) => Math.max(0, b.onHandQty - b.reservedQty) - Math.max(0, a.onHandQty - a.reservedQty),
      );
      const singleFull = sortedInvs.find((inv) => inv.onHandQty - inv.reservedQty >= reqItem.quantity);
      if (singleFull) {
        addResolvedLine(sku, singleFull.warehouseId, reqItem.quantity);
        continue;
      }

      const totalAvailable = sortedInvs.reduce((acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty), 0);
      if (totalAvailable >= reqItem.quantity) {
        let remaining = reqItem.quantity;
        for (const inv of sortedInvs) {
          const avail = Math.max(0, inv.onHandQty - inv.reservedQty);
          if (avail <= 0) continue;
          const take = Math.min(remaining, avail);
          addResolvedLine(sku, inv.warehouseId, take);
          remaining -= take;
          if (remaining === 0) break;
        }
        continue;
      }

      const fallbackInv = sortedInvs[0];
      if (!fallbackInv) {
        throw new ConflictError(`Insufficient stock for SKU ${sku.skuCode}`, 'INSUFFICIENT_STOCK');
      }
      addResolvedLine(sku, fallbackInv.warehouseId, reqItem.quantity);
    }
    const resolvedLines = Array.from(mergedLinesMap.values());

    const pricingInputs = resolvedLines.map((line) => ({
      productId: line.sku.productId,
      skuId: line.sku.id,
      skuCode: line.sku.skuCode,
      sellerId: line.sku.product.sellerId,
      categoryId: line.sku.product.categoryId,
      unitPrice: line.sku.price.toString(),
      quantity: line.quantity,
    }));

    const prelimPricing = await pythonClient.calculatePricing({
      items: pricingInputs,
      promotion: null,
      requestId: req.requestId,
    });

    let discountRecord: Awaited<ReturnType<typeof promotionsService.validateCouponForUser>> | null = null;
    if (req.body.discountCode) {
      const sellerIdsInCart = Array.from(new Set(pricingInputs.map((i) => i.sellerId)));
      discountRecord = await promotionsService.validateCouponForUser({
        code: req.body.discountCode,
        userId,
        subtotal: prelimPricing.subtotalAmount,
        sellerIdsInCart,
      });
    }

    const finalPricing = discountRecord
      ? await pythonClient.calculatePricing({
          items: pricingInputs,
          promotion: {
            code: discountRecord.code,
            discountType: discountRecord.discountType,
            value: discountRecord.value.toString(),
            sellerId: discountRecord.sellerId,
            minCartAmount: discountRecord.minCartAmount?.toString() ?? null,
            maxDiscountAmount: discountRecord.maxDiscountAmount?.toString() ?? null,
          },
          requestId: req.requestId,
        })
      : prelimPricing;

    const orderNumber = `MS-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const reservationExpiresAt = new Date(Date.now() + env.RESERVATION_TTL_MINUTES * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      // Re-validate discount atomically under lock inside checkout transaction
      if (discountRecord) {
        const lockedDiscounts = await tx.$queryRaw<
          Array<{ id: string; usage_limit_total: number | null; used_count: number }>
        >`
          SELECT id, usage_limit_total, used_count
          FROM discounts
          WHERE id = ${discountRecord.id}::uuid
          FOR UPDATE
        `;
        const lockedDisc = lockedDiscounts[0];
        if (
          !lockedDisc ||
          (lockedDisc.usage_limit_total !== null && lockedDisc.used_count >= lockedDisc.usage_limit_total)
        ) {
          throw new ConflictError('Discount usage limit reached', 'DISCOUNT_USAGE_LIMIT_EXCEEDED');
        }
        if (discountRecord.usageLimitPerCustomer !== null) {
          const countForUser = await tx.discountRedemption.count({
            where: { discountId: discountRecord.id, userId },
          });
          if (countForUser >= discountRecord.usageLimitPerCustomer) {
            throw new ConflictError(
              'You have reached the usage limit for this discount code',
              'DISCOUNT_CUSTOMER_LIMIT_EXCEEDED',
            );
          }
        }
      }

      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId: userId,
          status: OrderStatus.PENDING_PAYMENT,
          currency: finalPricing.currency,
          subtotalAmount: finalPricing.subtotalAmount,
          discountAmount: finalPricing.discountAmount,
          taxAmount: finalPricing.taxAmount,
          shippingAmount: finalPricing.shippingAmount,
          totalAmount: finalPricing.totalAmount,
          shippingAddressSnapshot,
          discountCode: discountRecord?.code ?? null,
          idempotencyKey,
          items: {
            create: resolvedLines.map((line, idx) => {
              const priced = finalPricing.items[idx]!;
              return {
                sellerId: line.sku.product.sellerId,
                productId: line.sku.productId,
                skuId: line.sku.id,
                warehouseId: line.warehouseId,
                productTitleSnapshot: line.sku.product.title,
                skuCodeSnapshot: line.sku.skuCode,
                quantity: line.quantity,
                unitPrice: priced.unitPrice,
                discountAmount: priced.discountAmount,
                taxAmount: priced.taxAmount,
                lineTotal: priced.lineTotal,
              };
            }),
          },
          statusHistory: {
            create: {
              fromStatus: null,
              toStatus: OrderStatus.PENDING_PAYMENT,
              reason: 'Order created and stock reserved pending payment',
              changedByUserId: userId,
            },
          },
        },
        include: { items: true },
      });

      // Concurrency-safe row-locked inventory reservation
      const reservations = await inventoryService.reserveStockTx(tx, {
        orderId: order.id,
        idempotencyKey,
        expiresAt: reservationExpiresAt,
        actorUserId: userId,
        items: resolvedLines.map((l) => ({
          skuId: l.sku.id,
          warehouseId: l.warehouseId,
          quantity: l.quantity,
          skuCode: l.sku.skuCode,
        })),
      });

      if (discountRecord && Number(finalPricing.discountAmount) > 0) {
        await tx.discount.update({
          where: { id: discountRecord.id },
          data: { usedCount: { increment: 1 } },
        });
        await tx.discountRedemption.create({
          data: {
            discountId: discountRecord.id,
            orderId: order.id,
            userId,
            discountAmount: finalPricing.discountAmount,
          },
        });
      }

      const paymentIntent = await paymentSandboxAdapter.initiatePayment({
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: finalPricing.totalAmount,
        currency: finalPricing.currency,
        idempotencyKey: `pay_${idempotencyKey}`,
        requestId: req.requestId,
      });

      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: paymentIntent.provider,
          providerPaymentId: paymentIntent.providerPaymentId,
          idempotencyKey: `pay_${idempotencyKey}`,
          amount: finalPricing.totalAmount,
          currency: finalPricing.currency,
          status: PaymentStatus.INITIATED,
        },
      });

      if (cartIdToClear) {
        await tx.cartItem.deleteMany({ where: { cartId: cartIdToClear } });
      }

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'ORDER',
          aggregateId: order.id,
          eventType: 'ORDER_CREATED',
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerId: userId,
            reservationExpiresAt: reservationExpiresAt.toISOString(),
          },
        },
      });

      await recordAuditLog(tx, {
        actorUserId: userId,
        actorRole: req.user!.roles[0],
        action: 'CHECKOUT_COMPLETED',
        resourceType: 'ORDER',
        resourceId: order.id,
        requestId: req.requestId,
        ipAddress: req.ip,
        afterState: { orderNumber: order.orderNumber, totalAmount: finalPricing.totalAmount },
      });

      return {
        ...order,
        reservations,
        payment,
        pricingSource: finalPricing.source,
      };
    });

    await Promise.all([
      enqueueTrackedJob({
        queueName: QUEUE_NAMES.COMMERCE_MAINTENANCE,
        jobName: 'reservation-expiry-sweep',
        jobId: `resv-exp-${result.id}`,
        payload: {
          orderId: result.id,
          orderNumber: result.orderNumber,
          expiresAt: reservationExpiresAt.toISOString(),
        },
        delayMs: env.RESERVATION_TTL_MINUTES * 60 * 1000,
      }),
      enqueueTrackedJob({
        queueName: QUEUE_NAMES.NOTIFICATIONS,
        jobName: 'outbox-dispatch',
        jobId: `outbox-created-${result.id}`,
        payload: { orderId: result.id, eventType: 'ORDER_CREATED' },
      }),
    ]);

    return sendSuccess(req, res, result, 'Checkout completed; awaiting payment confirmation', 201);
  } catch (err) {
    next(err);
  }
});
