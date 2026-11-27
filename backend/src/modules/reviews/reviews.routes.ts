import { Router, NextFunction, Request, Response } from 'express';
import { OrderStatus, ReviewModerationStatus, RoleName } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/response';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { recordAuditLog } from '../../common/audit';

const createReviewSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    orderId: z.string().uuid(),
    rating: z.coerce.number().int().min(1).max(5),
    title: z.string().trim().min(2).max(160),
    comment: z.string().trim().min(5).max(3000),
  }),
});

const moderateReviewSchema = z.object({
  params: z.object({ reviewId: z.string().uuid() }),
  body: z.object({
    moderationStatus: z.nativeEnum(ReviewModerationStatus),
  }),
});

export const reviewsRouter = Router();

reviewsRouter.get('/products/:productId/reviews', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.review.findMany({
      where: { productId: req.params.productId, moderationStatus: ReviewModerationStatus.APPROVED },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return sendSuccess(req, res, items, 'Reviews retrieved');
  } catch (err) {
    next(err);
  }
});

reviewsRouter.post(
  '/products/:productId/reviews',
  authenticate,
  validateRequest(createReviewSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.body.orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundError('Order not found');
      if (order.customerId !== req.user!.userId) {
        throw new ForbiddenError('Cannot review an order placed by another user');
      }
      if (order.status !== OrderStatus.DELIVERED) {
        throw new ForbiddenError('Verified purchase reviews require a delivered order', 'VERIFIED_PURCHASE_REQUIRED');
      }
      const purchasedProduct = order.items.some((i) => i.productId === req.params.productId);
      if (!purchasedProduct) {
        throw new ForbiddenError('This product was not part of the specified order', 'VERIFIED_PURCHASE_REQUIRED');
      }

      const existing = await prisma.review.findUnique({
        where: {
          productId_userId_orderId: {
            productId: req.params.productId!,
            userId: req.user!.userId,
            orderId: req.body.orderId,
          },
        },
      });
      if (existing) {
        throw new ConflictError('You already reviewed this product for this order', 'REVIEW_ALREADY_EXISTS');
      }

      const review = await prisma.review.create({
        data: {
          productId: req.params.productId!,
          userId: req.user!.userId,
          orderId: req.body.orderId,
          rating: req.body.rating,
          title: req.body.title,
          comment: req.body.comment,
          isVerifiedPurchase: true,
          moderationStatus: ReviewModerationStatus.APPROVED,
        },
      });
      return sendSuccess(req, res, review, 'Review submitted', 201);
    } catch (err) {
      next(err);
    }
  },
);

reviewsRouter.patch(
  '/reviews/:reviewId/moderate',
  authenticate,
  requireRoles(RoleName.ADMIN, RoleName.SUPPORT_AGENT),
  validateRequest(moderateReviewSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.review.findUnique({ where: { id: req.params.reviewId } });
      if (!existing) throw new NotFoundError('Review not found');
      const updated = await prisma.review.update({
        where: { id: existing.id },
        data: { moderationStatus: req.body.moderationStatus },
      });
      await recordAuditLog(prisma, {
        actorUserId: req.user!.userId,
        actorRole: req.user!.roles[0],
        action: 'REVIEW_MODERATED',
        resourceType: 'REVIEW',
        resourceId: existing.id,
        afterState: { moderationStatus: req.body.moderationStatus },
      });
      return sendSuccess(req, res, updated, 'Review moderation status updated');
    } catch (err) {
      next(err);
    }
  },
);
