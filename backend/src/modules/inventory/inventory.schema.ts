import { z } from 'zod';
import { InventoryMovementType } from '@prisma/client';

export const createWarehouseSchema = z.object({
  body: z.object({
    code: z.string().trim().min(2).max(40).transform((v) => v.toUpperCase()),
    name: z.string().trim().min(2).max(150),
    sellerId: z.string().uuid().nullable().optional(),
    addressLine1: z.string().trim().min(2).max(255),
    city: z.string().trim().min(2).max(120),
    state: z.string().trim().min(2).max(120),
    postalCode: z.string().trim().min(2).max(30),
    country: z.string().trim().min(2).max(80).default('US'),
  }),
});

export const listInventorySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    warehouseId: z.string().uuid().optional(),
    lowStockOnly: z.enum(['true', 'false']).optional(),
    search: z.string().trim().optional(),
  }),
});

export const adjustStockSchema = z.object({
  body: z.object({
    skuId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    movementType: z.enum([
      InventoryMovementType.ADJUSTMENT_IN,
      InventoryMovementType.ADJUSTMENT_OUT,
      InventoryMovementType.DAMAGED,
      InventoryMovementType.RETURN_RESTOCK,
    ]),
    quantity: z.coerce.number().int().positive(),
    notes: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().max(160).optional(),
  }),
});
