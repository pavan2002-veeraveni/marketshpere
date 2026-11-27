import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../common/prisma';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import { sendSuccess } from '../../common/response';

export const usersController = {
  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await prisma.user.update({
        where: { id: req.user!.userId },
        data: {
          firstName: req.body.firstName,
          lastName: req.body.lastName,
          phone: req.body.phone,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          primaryRole: true,
          status: true,
        },
      });
      return sendSuccess(req, res, updated, 'Profile updated');
    } catch (err) {
      next(err);
    }
  },

  async listAddresses(req: Request, res: Response, next: NextFunction) {
    try {
      const addresses = await prisma.address.findMany({
        where: { userId: req.user!.userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      return sendSuccess(req, res, addresses, 'Addresses retrieved');
    } catch (err) {
      next(err);
    }
  },

  async createAddress(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        if (req.body.isDefault) {
          await tx.address.updateMany({
            where: { userId: req.user!.userId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.address.create({
          data: {
            ...req.body,
            userId: req.user!.userId,
          },
        });
      });
      return sendSuccess(req, res, created, 'Address created', 201);
    } catch (err) {
      next(err);
    }
  },

  async updateAddress(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.address.findUnique({ where: { id: req.params.addressId } });
      if (!existing) throw new NotFoundError('Address not found');
      if (existing.userId !== req.user!.userId) throw new ForbiddenError('Cannot edit another user address');

      const updated = await prisma.$transaction(async (tx) => {
        if (req.body.isDefault) {
          await tx.address.updateMany({
            where: { userId: req.user!.userId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.address.update({
          where: { id: existing.id },
          data: req.body,
        });
      });
      return sendSuccess(req, res, updated, 'Address updated');
    } catch (err) {
      next(err);
    }
  },

  async deleteAddress(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.address.findUnique({ where: { id: req.params.addressId } });
      if (!existing) throw new NotFoundError('Address not found');
      if (existing.userId !== req.user!.userId) throw new ForbiddenError('Cannot delete another user address');

      await prisma.address.delete({ where: { id: existing.id } });
      return sendSuccess(req, res, { deleted: true }, 'Address deleted');
    } catch (err) {
      next(err);
    }
  },

  async listNotifications(req: Request, res: Response, next: NextFunction) {
    try {
      const items = await prisma.notification.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return sendSuccess(req, res, items, 'Notifications retrieved');
    } catch (err) {
      next(err);
    }
  },

  async markNotificationRead(req: Request, res: Response, next: NextFunction) {
    try {
      const notification = await prisma.notification.findUnique({ where: { id: req.params.notificationId } });
      if (!notification) throw new NotFoundError('Notification not found');
      if (notification.userId !== req.user!.userId) throw new ForbiddenError('Cannot access another user notification');

      const updated = await prisma.notification.update({
        where: { id: notification.id },
        data: { readAt: new Date() },
      });
      return sendSuccess(req, res, updated, 'Notification marked as read');
    } catch (err) {
      next(err);
    }
  },
};
