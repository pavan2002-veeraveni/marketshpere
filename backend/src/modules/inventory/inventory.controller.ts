import { NextFunction, Request, Response } from 'express';
import { ReservationStatus } from '@prisma/client';
import { sendSuccess } from '../../common/response';
import { inventoryService } from './inventory.service';

export const inventoryController = {
  async listWarehouses(req: Request, res: Response, next: NextFunction) {
    try {
      const items = await inventoryService.listWarehouses();
      return sendSuccess(req, res, items, 'Warehouses retrieved');
    } catch (err) {
      next(err);
    }
  },

  async createWarehouse(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await inventoryService.createWarehouse(req.body, req.user!.userId);
      return sendSuccess(req, res, created, 'Warehouse created', 201);
    } catch (err) {
      next(err);
    }
  },

  async listInventory(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await inventoryService.listInventory(req.query as never, {
        roles: req.user!.roles,
        sellerId: req.user!.sellerId,
      });
      return sendSuccess(req, res, result.items, 'Inventory retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async adjustStock(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await inventoryService.adjustStock(
        req.body,
        { userId: req.user!.userId, roles: req.user!.roles, sellerId: req.user!.sellerId },
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, updated, 'Inventory adjusted');
    } catch (err) {
      next(err);
    }
  },

  async listLedger(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : undefined;
      const skuId = typeof req.query.skuId === 'string' ? req.query.skuId : undefined;
      const result = await inventoryService.listLedger(
        { page, limit, warehouseId, skuId },
        {
          roles: req.user!.roles,
          sellerId: req.user!.sellerId,
        },
      );
      return sendSuccess(req, res, result.items, 'Inventory ledger retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async listReservations(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 20);
      const status = req.query.status as ReservationStatus | undefined;
      const result = await inventoryService.listReservations({ page, limit, status });
      return sendSuccess(req, res, result.items, 'Reservations retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async releaseExpired(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await inventoryService.releaseExpiredReservations();
      return sendSuccess(req, res, result, 'Expired reservations sweep completed');
    } catch (err) {
      next(err);
    }
  },
};
