import { Router, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ProductStatus } from '@prisma/client';
import { prisma } from '../../common/prisma';
import { authenticate } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { pythonClient } from '../../integrations/python-client';
import { promotionsService } from '../promotions/promotions.routes';

const addCartItemSchema = z.object({
  body: z.object({
    skuId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(50),
  }),
});

const updateCartItemSchema = z.object({
  params: z.object({ itemId: z.string().uuid() }),
  body: z.object({
    quantity: z.coerce.number().int().min(1).max(50),
  }),
});

const validateCartSchema = z.object({
  body: z.object({
    discountCode: z.string().trim().optional(),
  }),
});

async function getOrCreateCart(userId: string) {
  let cart = await prisma.cart.findUnique({ where: { userId } });
  if (!cart) {
    cart = await prisma.cart.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  }
  return cart;
}

export async function loadHydratedCart(userId: string, discountCode?: string, requestId?: string) {
  const cart = await getOrCreateCart(userId);
  const items = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    include: {
      sku: {
        include: {
          variant: true,
          product: {
            include: {
              images: { where: { isPrimary: true }, take: 1 },
              seller: { select: { id: true, storeName: true, onboardingStatus: true } },
            },
          },
          inventories: { select: { id: true, warehouseId: true, onHandQty: true, reservedQty: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (items.length === 0) {
    return {
      cartId: cart.id,
      items: [],
      pricing: {
        currency: 'USD',
        subtotalAmount: '0.00',
        discountAmount: '0.00',
        taxAmount: '0.00',
        shippingAmount: '0.00',
        totalAmount: '0.00',
        items: [],
        source: 'deterministic-fallback',
      },
      stockIssues: [],
    };
  }

  const stockIssues: Array<{ skuId: string; skuCode: string; requested: number; available: number }> = [];
  const pricingLines = items.map((item) => {
    const available = item.sku.inventories.reduce(
      (acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty),
      0,
    );
    if (available < item.quantity || !item.sku.isActive || item.sku.product.status !== ProductStatus.ACTIVE) {
      stockIssues.push({
        skuId: item.skuId,
        skuCode: item.sku.skuCode,
        requested: item.quantity,
        available,
      });
    }
    return {
      productId: item.sku.productId,
      skuId: item.skuId,
      skuCode: item.sku.skuCode,
      sellerId: item.sku.product.sellerId,
      categoryId: item.sku.product.categoryId,
      unitPrice: item.sku.price.toString(),
      quantity: item.quantity,
    };
  });

  const preliminaryPricing = await pythonClient.calculatePricing({
    items: pricingLines,
    promotion: null,
    requestId,
  });

  let promotion = null;
  if (discountCode) {
    const sellerIdsInCart = Array.from(new Set(pricingLines.map((i) => i.sellerId)));
    const discount = await promotionsService.validateCouponForUser({
      code: discountCode,
      userId,
      subtotal: preliminaryPricing.subtotalAmount,
      sellerIdsInCart,
    });
    promotion = {
      code: discount.code,
      discountType: discount.discountType,
      value: discount.value.toString(),
      sellerId: discount.sellerId,
      minCartAmount: discount.minCartAmount?.toString() ?? null,
      maxDiscountAmount: discount.maxDiscountAmount?.toString() ?? null,
    };
  }

  const pricing = promotion
    ? await pythonClient.calculatePricing({ items: pricingLines, promotion, requestId })
    : preliminaryPricing;

  return {
    cartId: cart.id,
    items: items.map((item) => {
      const available = item.sku.inventories.reduce(
        (acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty),
        0,
      );
      return {
        id: item.id,
        skuId: item.skuId,
        quantity: item.quantity,
        currentUnitPrice: item.sku.price.toString(),
        availableQty: available,
        sku: item.sku,
      };
    }),
    pricing,
    stockIssues,
  };
}

export const cartRouter = Router();
cartRouter.use(authenticate);

cartRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const discountCode = typeof req.query.discountCode === 'string' ? req.query.discountCode : undefined;
    const data = await loadHydratedCart(req.user!.userId, discountCode, req.requestId);
    return sendSuccess(req, res, data, 'Cart retrieved');
  } catch (err) {
    next(err);
  }
});

cartRouter.post('/items', validateRequest(addCartItemSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sku = await prisma.sku.findFirst({
      where: { id: req.body.skuId, isActive: true, deletedAt: null },
      include: {
        product: { include: { seller: true } },
        inventories: true,
      },
    });
    if (!sku || sku.product.status !== ProductStatus.ACTIVE || sku.product.seller.onboardingStatus !== 'APPROVED') {
      throw new NotFoundError('Active product SKU not found');
    }

    const totalAvailable = sku.inventories.reduce((acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty), 0);
    const cart = await getOrCreateCart(req.user!.userId);
    const existingItem = await prisma.cartItem.findUnique({
      where: { cartId_skuId: { cartId: cart.id, skuId: sku.id } },
    });
    const nextQty = (existingItem?.quantity ?? 0) + req.body.quantity;
    if (nextQty > totalAvailable) {
      throw new ConflictError(`Only ${totalAvailable} unit(s) available for ${sku.skuCode}`, 'INSUFFICIENT_STOCK');
    }

    if (existingItem) {
      await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: nextQty, unitPriceSnapshot: sku.price },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          skuId: sku.id,
          quantity: req.body.quantity,
          unitPriceSnapshot: sku.price,
        },
      });
    }

    const hydrated = await loadHydratedCart(req.user!.userId, undefined, req.requestId);
    return sendSuccess(req, res, hydrated, 'Item added to cart', 201);
  } catch (err) {
    next(err);
  }
});

cartRouter.patch(
  '/items/:itemId',
  validateRequest(updateCartItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cart = await getOrCreateCart(req.user!.userId);
      const item = await prisma.cartItem.findFirst({
        where: { id: req.params.itemId, cartId: cart.id },
        include: { sku: { include: { inventories: true } } },
      });
      if (!item) throw new NotFoundError('Cart item not found');

      const totalAvailable = item.sku.inventories.reduce(
        (acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty),
        0,
      );
      if (req.body.quantity > totalAvailable) {
        throw new ConflictError(`Only ${totalAvailable} unit(s) available`, 'INSUFFICIENT_STOCK');
      }

      await prisma.cartItem.update({
        where: { id: item.id },
        data: { quantity: req.body.quantity, unitPriceSnapshot: item.sku.price },
      });
      const hydrated = await loadHydratedCart(req.user!.userId, undefined, req.requestId);
      return sendSuccess(req, res, hydrated, 'Cart item updated');
    } catch (err) {
      next(err);
    }
  },
);

cartRouter.delete('/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cart = await getOrCreateCart(req.user!.userId);
    const deleted = await prisma.cartItem.deleteMany({
      where: { id: req.params.itemId, cartId: cart.id },
    });
    if (deleted.count === 0) throw new NotFoundError('Cart item not found');
    const hydrated = await loadHydratedCart(req.user!.userId, undefined, req.requestId);
    return sendSuccess(req, res, hydrated, 'Cart item removed');
  } catch (err) {
    next(err);
  }
});

cartRouter.post('/validate', validateRequest(validateCartSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadHydratedCart(req.user!.userId, req.body.discountCode, req.requestId);
    if (data.items.length === 0) {
      throw new ValidationError('Cart is empty', [], 'CART_EMPTY');
    }
    return sendSuccess(req, res, data, 'Cart validated');
  } catch (err) {
    next(err);
  }
});
