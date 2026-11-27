import { Router, NextFunction, Request, Response } from 'express';
import { DiscountType, Prisma, RoleName } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { money } from '../../common/decimal';
import { recordAuditLog } from '../../common/audit';

const createDiscountSchema = z.object({
  body: z.object({
    code: z.string().trim().min(3).max(60).transform((v) => v.toUpperCase()),
    discountType: z.nativeEnum(DiscountType),
    value: z.string().regex(/^\d+(\.\d{1,2})?$/),
    minCartAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    maxDiscountAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    usageLimitTotal: z.coerce.number().int().positive().optional(),
    usageLimitPerCustomer: z.coerce.number().int().positive().optional(),
    isStackable: z.boolean().default(false),
    startsAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    isActive: z.boolean().default(true),
  }),
});

const validateDiscountSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).transform((v) => v.toUpperCase()),
    cartSubtotal: z.string().regex(/^\d+(\.\d{1,2})?$/),
    sellerIds: z.array(z.string().uuid()).default([]),
  }),
});

export const promotionsService = {
  async validateCouponForUser(params: {
    tx?: Prisma.TransactionClient;
    code: string;
    userId: string;
    subtotal: string;
    eligibleSellerSubtotal?: string;
    sellerIdsInCart: string[];
  }) {
    const db = params.tx ?? prisma;
    const discount = await db.discount.findUnique({ where: { code: params.code.toUpperCase() } });
    if (!discount) {
      throw new NotFoundError(`Discount code ${params.code} not found`, 'DISCOUNT_NOT_FOUND');
    }
    if (!discount.isActive) {
      throw new ValidationError('Discount code is inactive', [], 'DISCOUNT_INACTIVE');
    }
    const now = new Date();
    if (now < discount.startsAt || now > discount.expiresAt) {
      throw new ValidationError('Discount code has expired or is not active yet', [], 'DISCOUNT_EXPIRED');
    }
    if (discount.sellerId && !params.sellerIdsInCart.includes(discount.sellerId)) {
      throw new ValidationError('Discount code does not apply to items in your cart', [], 'DISCOUNT_SELLER_MISMATCH');
    }
    if (discount.minCartAmount && money(params.subtotal).lt(money(discount.minCartAmount.toString()))) {
      throw new ValidationError(
        `Minimum cart subtotal of $${discount.minCartAmount.toString()} is required for this code`,
        [],
        'DISCOUNT_MIN_NOT_MET',
      );
    }
    if (discount.usageLimitTotal !== null && discount.usedCount >= discount.usageLimitTotal) {
      throw new ConflictError('Discount total usage limit has been reached', 'DISCOUNT_USAGE_LIMIT_EXCEEDED');
    }
    if (discount.usageLimitPerCustomer !== null) {
      const userRedemptions = await db.discountRedemption.count({
        where: { discountId: discount.id, userId: params.userId },
      });
      if (userRedemptions >= discount.usageLimitPerCustomer) {
        throw new ConflictError(
          'You have reached the usage limit for this discount code',
          'DISCOUNT_CUSTOMER_LIMIT_EXCEEDED',
        );
      }
    }
    return discount;
  },
};

export const discountsRouter = Router();
discountsRouter.use(authenticate);

discountsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAdmin = req.user!.roles.includes(RoleName.ADMIN);
    const isSeller = req.user!.roles.includes(RoleName.SELLER);
    const where: Prisma.DiscountWhereInput = isAdmin
      ? {}
      : isSeller && req.user!.sellerId
        ? { OR: [{ sellerId: req.user!.sellerId }, { sellerId: null, isActive: true }] }
        : { isActive: true, expiresAt: { gt: new Date() } };

    const items = await prisma.discount.findMany({ where, orderBy: { createdAt: 'desc' } });
    return sendSuccess(req, res, items, 'Discounts retrieved');
  } catch (err) {
    next(err);
  }
});

discountsRouter.post(
  '/',
  requireRoles(RoleName.ADMIN, RoleName.SELLER),
  validateRequest(createDiscountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.roles.includes(RoleName.ADMIN);
      if (!isAdmin && !req.user!.sellerId) {
        throw new ForbiddenError('Approved seller profile required');
      }
      if (req.body.discountType === DiscountType.PERCENTAGE && Number(req.body.value) > 90) {
        throw new ValidationError('Percentage discount cannot exceed 90%');
      }
      if (req.body.expiresAt <= req.body.startsAt) {
        throw new ValidationError('Expiry date must be after start date');
      }

      const created = await prisma.discount.create({
        data: {
          ...req.body,
          sellerId: isAdmin ? null : req.user!.sellerId,
        },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'DISCOUNT_CREATED',
        resourceType: 'DISCOUNT',
        resourceId: created.id,
        afterState: created,
      });
      return sendSuccess(req, res, created, 'Discount created', 201);
    } catch (err) {
      next(err);
    }
  },
);

discountsRouter.patch(
  '/:discountId',
  requireRoles(RoleName.ADMIN, RoleName.SELLER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.discount.findUnique({ where: { id: req.params.discountId } });
      if (!existing) throw new NotFoundError('Discount not found');
      if (!req.user!.roles.includes(RoleName.ADMIN) && existing.sellerId !== req.user!.sellerId) {
        throw new ForbiddenError('Cannot modify another seller discount');
      }
      const updated = await prisma.discount.update({
        where: { id: existing.id },
        data: {
          isActive: typeof req.body.isActive === 'boolean' ? req.body.isActive : undefined,
          expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
          usageLimitTotal: typeof req.body.usageLimitTotal === 'number' ? req.body.usageLimitTotal : undefined,
        },
      });
      return sendSuccess(req, res, updated, 'Discount updated');
    } catch (err) {
      next(err);
    }
  },
);

discountsRouter.post('/validate', validateRequest(validateDiscountSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const discount = await promotionsService.validateCouponForUser({
      code: req.body.code,
      userId: req.user!.userId,
      subtotal: req.body.cartSubtotal,
      sellerIdsInCart: req.body.sellerIds,
    });
    return sendSuccess(req, res, discount, 'Discount code is valid');
  } catch (err) {
    next(err);
  }
});
