import { Router } from 'express';
import { RoleName } from '@prisma/client';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { inventoryController } from './inventory.controller';
import { adjustStockSchema, createWarehouseSchema, listInventorySchema } from './inventory.schema';

export const warehousesRouter = Router();
warehousesRouter.use(authenticate);
warehousesRouter.get(
  '/',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  inventoryController.listWarehouses,
);
warehousesRouter.post(
  '/',
  requireRoles(RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(createWarehouseSchema),
  inventoryController.createWarehouse,
);

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);
inventoryRouter.get(
  '/',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(listInventorySchema),
  inventoryController.listInventory,
);
inventoryRouter.post(
  '/adjust',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  validateRequest(adjustStockSchema),
  inventoryController.adjustStock,
);
inventoryRouter.get(
  '/ledger',
  requireRoles(RoleName.SELLER, RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  inventoryController.listLedger,
);
inventoryRouter.get(
  '/reservations',
  requireRoles(RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  inventoryController.listReservations,
);
inventoryRouter.post(
  '/reservations/release-expired',
  requireRoles(RoleName.WAREHOUSE_OPERATOR, RoleName.ADMIN),
  inventoryController.releaseExpired,
);
