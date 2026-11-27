import { InventoryMovementType, OrderStatus, Prisma, ReservationStatus, RoleName } from '@prisma/client';
import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { logger } from '../../common/logger';

export interface StockReservationLine {
  skuId: string;
  warehouseId: string;
  quantity: number;
  skuCode?: string;
}

interface LockedInventoryRow {
  id: string;
  sku_id: string;
  warehouse_id: string;
  on_hand_qty: number;
  reserved_qty: number;
}

export const inventoryService = {
  /**
   * Concurrency-safe inventory reservation using deterministic row ordering + PostgreSQL FOR UPDATE.
   * Guarantees two concurrent buyers can never reserve the final available unit.
   */
  async reserveStockTx(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      idempotencyKey: string;
      expiresAt: Date;
      actorUserId?: string;
      items: StockReservationLine[];
    },
  ) {
    // Deterministic ordering prevents lock-order deadlocks on multi-SKU checkouts
    const sorted = [...params.items].sort((a, b) =>
      `${a.skuId}:${a.warehouseId}`.localeCompare(`${b.skuId}:${b.warehouseId}`),
    );

    const reservations = [];

    for (const item of sorted) {
      const itemIdemKey = `${params.idempotencyKey}:${item.skuId}:${item.warehouseId}`;
      const existing = await tx.inventoryReservation.findUnique({
        where: { idempotencyKey: itemIdemKey },
      });
      if (existing) {
        reservations.push(existing);
        continue;
      }

      const rows = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
        FROM inventory
        WHERE sku_id = ${item.skuId}::uuid AND warehouse_id = ${item.warehouseId}::uuid
        FOR UPDATE
      `;

      const row = rows[0];
      if (!row) {
        throw new ConflictError(`Inventory record missing for SKU ${item.skuCode ?? item.skuId}`, 'INSUFFICIENT_STOCK', [
          { skuId: item.skuId, requested: item.quantity, available: 0 },
        ]);
      }

      const available = row.on_hand_qty - row.reserved_qty;
      if (available < item.quantity) {
        throw new ConflictError(
          `Insufficient stock for SKU ${item.skuCode ?? item.skuId}`,
          'INSUFFICIENT_STOCK',
          [{ skuId: item.skuId, requested: item.quantity, available: Math.max(0, available) }],
        );
      }

      const updatedCount = await tx.$executeRaw`
        UPDATE inventory
        SET reserved_qty = reserved_qty + ${item.quantity}, version = version + 1, updated_at = NOW()
        WHERE id = ${row.id}::uuid AND (on_hand_qty - reserved_qty) >= ${item.quantity}
      `;

      if (updatedCount !== 1) {
        throw new ConflictError(
          `Concurrent stock conflict for SKU ${item.skuCode ?? item.skuId}`,
          'INSUFFICIENT_STOCK',
        );
      }

      const reservation = await tx.inventoryReservation.create({
        data: {
          inventoryId: row.id,
          skuId: item.skuId,
          warehouseId: item.warehouseId,
          orderId: params.orderId,
          quantity: item.quantity,
          status: ReservationStatus.ACTIVE,
          idempotencyKey: itemIdemKey,
          expiresAt: params.expiresAt,
        },
      });

      await tx.inventoryLedger.create({
        data: {
          inventoryId: row.id,
          skuId: item.skuId,
          warehouseId: item.warehouseId,
          movementType: InventoryMovementType.RESERVE,
          quantityDelta: -item.quantity,
          balanceAfter: available - item.quantity,
          referenceType: 'ORDER_RESERVATION',
          referenceId: params.orderId,
          idempotencyKey: `ledger:reserve:${itemIdemKey}`,
          actorUserId: params.actorUserId,
          notes: `Reserved ${item.quantity} unit(s) for order ${params.orderId}`,
        },
      });

      reservations.push(reservation);
    }

    return reservations;
  },

  /**
   * Commits active reservations when payment is confirmed, deducting on_hand_qty & reserved_qty atomically.
   */
  async commitOrderReservationsTx(
    tx: Prisma.TransactionClient,
    params: { orderId: string; actorUserId?: string },
  ) {
    const activeReservations = await tx.$queryRaw<
      Array<{ id: string; inventory_id: string; sku_id: string; warehouse_id: string; quantity: number }>
    >`
      SELECT id, inventory_id, sku_id, warehouse_id, quantity
      FROM inventory_reservations
      WHERE order_id = ${params.orderId}::uuid AND status = 'ACTIVE'
      ORDER BY inventory_id ASC
      FOR UPDATE
    `;

    for (const resv of activeReservations) {
      const updatedResv = await tx.$executeRaw`
        UPDATE inventory_reservations
        SET status = 'COMMITTED', released_at = NOW()
        WHERE id = ${resv.id}::uuid AND status = 'ACTIVE'
      `;
      if (updatedResv !== 1) continue;

      const invRows = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
        FROM inventory
        WHERE id = ${resv.inventory_id}::uuid
        FOR UPDATE
      `;
      const inv = invRows[0];
      if (!inv) continue;

      await tx.$executeRaw`
        UPDATE inventory
        SET on_hand_qty = on_hand_qty - ${resv.quantity},
            reserved_qty = reserved_qty - ${resv.quantity},
            version = version + 1,
            updated_at = NOW()
        WHERE id = ${inv.id}::uuid AND on_hand_qty >= ${resv.quantity} AND reserved_qty >= ${resv.quantity}
      `;

      const availableAfter = inv.on_hand_qty - inv.reserved_qty;
      await tx.inventoryLedger.create({
        data: {
          inventoryId: inv.id,
          skuId: resv.sku_id,
          warehouseId: resv.warehouse_id,
          movementType: InventoryMovementType.COMMIT_SALE,
          quantityDelta: -resv.quantity,
          balanceAfter: availableAfter,
          referenceType: 'ORDER_COMMIT',
          referenceId: params.orderId,
          idempotencyKey: `ledger:commit:${resv.id}`,
          actorUserId: params.actorUserId,
          notes: `Committed ${resv.quantity} unit(s) upon payment confirmation`,
        },
      });
    }

    return activeReservations.length;
  },

  /**
   * Releases active reservations on order cancellation, ensuring single release.
   */
  async releaseOrderReservationsTx(
    tx: Prisma.TransactionClient,
    params: { orderId: string; actorUserId?: string; reason?: string },
  ) {
    const activeReservations = await tx.$queryRaw<
      Array<{ id: string; inventory_id: string; sku_id: string; warehouse_id: string; quantity: number }>
    >`
      SELECT id, inventory_id, sku_id, warehouse_id, quantity
      FROM inventory_reservations
      WHERE order_id = ${params.orderId}::uuid AND status = 'ACTIVE'
      ORDER BY inventory_id ASC
      FOR UPDATE
    `;

    for (const resv of activeReservations) {
      const changed = await tx.$executeRaw`
        UPDATE inventory_reservations
        SET status = 'RELEASED', released_at = NOW()
        WHERE id = ${resv.id}::uuid AND status = 'ACTIVE'
      `;
      if (changed !== 1) continue;

      const invRows = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
        FROM inventory
        WHERE id = ${resv.inventory_id}::uuid
        FOR UPDATE
      `;
      const inv = invRows[0];
      if (!inv) continue;

      await tx.$executeRaw`
        UPDATE inventory
        SET reserved_qty = GREATEST(0, reserved_qty - ${resv.quantity}),
            version = version + 1,
            updated_at = NOW()
        WHERE id = ${inv.id}::uuid
      `;

      const availableAfter = inv.on_hand_qty - Math.max(0, inv.reserved_qty - resv.quantity);
      await tx.inventoryLedger.create({
        data: {
          inventoryId: inv.id,
          skuId: resv.sku_id,
          warehouseId: resv.warehouse_id,
          movementType: InventoryMovementType.RELEASE_CANCELLED,
          quantityDelta: resv.quantity,
          balanceAfter: availableAfter,
          referenceType: 'ORDER_CANCEL',
          referenceId: params.orderId,
          idempotencyKey: `ledger:release_cancel:${resv.id}`,
          actorUserId: params.actorUserId,
          notes: params.reason ?? 'Released cancelled order reservation',
        },
      });
    }

    // Also restock committed units if a paid order is cancelled prior to shipment
    const committedReservations = await tx.$queryRaw<
      Array<{ id: string; inventory_id: string; sku_id: string; warehouse_id: string; quantity: number }>
    >`
      SELECT id, inventory_id, sku_id, warehouse_id, quantity
      FROM inventory_reservations
      WHERE order_id = ${params.orderId}::uuid AND status = 'COMMITTED'
      ORDER BY inventory_id ASC
      FOR UPDATE
    `;

    for (const resv of committedReservations) {
      const changed = await tx.$executeRaw`
        UPDATE inventory_reservations
        SET status = 'RELEASED', released_at = NOW()
        WHERE id = ${resv.id}::uuid AND status = 'COMMITTED'
      `;
      if (changed !== 1) continue;

      const invRows = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
        FROM inventory
        WHERE id = ${resv.inventory_id}::uuid
        FOR UPDATE
      `;
      const inv = invRows[0];
      if (!inv) continue;

      await tx.$executeRaw`
        UPDATE inventory
        SET on_hand_qty = on_hand_qty + ${resv.quantity},
            version = version + 1,
            updated_at = NOW()
        WHERE id = ${inv.id}::uuid
      `;

      const availableAfter = inv.on_hand_qty + resv.quantity - inv.reserved_qty;
      await tx.inventoryLedger.create({
        data: {
          inventoryId: inv.id,
          skuId: resv.sku_id,
          warehouseId: resv.warehouse_id,
          movementType: InventoryMovementType.RETURN_RESTOCK,
          quantityDelta: resv.quantity,
          balanceAfter: availableAfter,
          referenceType: 'ORDER_CANCEL_RESTOCK',
          referenceId: params.orderId,
          idempotencyKey: `ledger:restock_cancel:${resv.id}`,
          actorUserId: params.actorUserId,
          notes: params.reason ?? 'Restocked committed units after paid order cancellation',
        },
      });
    }

    return activeReservations.length + committedReservations.length;
  },

  /**
   * Idempotent expiry release sweep: expired reservations are released exactly once.
   */
  async releaseExpiredReservations(limit = 100) {
    const expiredCandidates = await prisma.inventoryReservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        expiresAt: { lte: new Date() },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });

    let releasedCount = 0;
    const affectedOrderIds = new Set<string>();

    for (const candidate of expiredCandidates) {
      const released = await prisma.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw<
          Array<{ id: string; inventory_id: string; sku_id: string; warehouse_id: string; quantity: number; order_id: string }>
        >`
          UPDATE inventory_reservations
          SET status = 'EXPIRED', released_at = NOW()
          WHERE id = ${candidate.id}::uuid AND status = 'ACTIVE'
          RETURNING id, inventory_id, sku_id, warehouse_id, quantity, order_id
        `;

        const resv = claimed[0];
        if (!resv) return false;

        const invRows = await tx.$queryRaw<LockedInventoryRow[]>`
          SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
          FROM inventory
          WHERE id = ${resv.inventory_id}::uuid
          FOR UPDATE
        `;
        const inv = invRows[0];
        if (inv) {
          await tx.$executeRaw`
            UPDATE inventory
            SET reserved_qty = GREATEST(0, reserved_qty - ${resv.quantity}),
                version = version + 1,
                updated_at = NOW()
            WHERE id = ${inv.id}::uuid
          `;

          const availableAfter = inv.on_hand_qty - Math.max(0, inv.reserved_qty - resv.quantity);
          await tx.inventoryLedger.create({
            data: {
              inventoryId: inv.id,
              skuId: resv.sku_id,
              warehouseId: resv.warehouse_id,
              movementType: InventoryMovementType.RELEASE_EXPIRED,
              quantityDelta: resv.quantity,
              balanceAfter: availableAfter,
              referenceType: 'RESERVATION_EXPIRY',
              referenceId: resv.id,
              idempotencyKey: `ledger:release_expired:${resv.id}`,
              notes: `Released expired reservation for order ${resv.order_id}`,
            },
          });
        }

        affectedOrderIds.add(resv.order_id);
        return true;
      });

      if (released) releasedCount++;
    }

    // Cancel orders still in PENDING_PAYMENT if no ACTIVE reservations remain
    for (const orderId of affectedOrderIds) {
      await prisma.$transaction(async (tx) => {
        const remainingActive = await tx.inventoryReservation.count({
          where: { orderId, status: ReservationStatus.ACTIVE },
        });
        if (remainingActive > 0) return;

        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (order && order.status === OrderStatus.PENDING_PAYMENT) {
          await tx.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
          });
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.CANCELLED,
              reason: 'Inventory reservation expired prior to payment confirmation',
            },
          });
        }
      });
    }

    if (releasedCount > 0) {
      logger.info({ releasedCount }, 'Released expired inventory reservations');
    }

    return { scanned: expiredCandidates.length, releasedCount };
  },

  async listWarehouses() {
    return prisma.warehouse.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
    });
  },

  async createWarehouse(
    input: {
      code: string;
      name: string;
      sellerId?: string | null;
      addressLine1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    },
    actorUserId: string,
  ) {
    const created = await prisma.warehouse.create({ data: input });
    await recordAuditLog(prisma, {
      actorUserId,
      action: 'WAREHOUSE_CREATED',
      resourceType: 'WAREHOUSE',
      resourceId: created.id,
      afterState: created,
    });
    return created;
  },

  async listInventory(
    query: { page: number; limit: number; warehouseId?: string; lowStockOnly?: 'true' | 'false'; search?: string },
    caller: { roles: RoleName[]; sellerId?: string | null },
  ) {
    const where: Prisma.InventoryWhereInput = {};
    if (query.warehouseId) where.warehouseId = query.warehouseId;

    const isSellerOnly =
      caller.roles.includes(RoleName.SELLER) &&
      !caller.roles.includes(RoleName.ADMIN) &&
      !caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);

    if (isSellerOnly) {
      where.sku = { product: { sellerId: caller.sellerId ?? '__none__' } };
    }

    if (query.search) {
      where.sku = {
        ...(where.sku as Prisma.SkuWhereInput),
        OR: [
          { skuCode: { contains: query.search, mode: 'insensitive' } },
          { product: { title: { contains: query.search, mode: 'insensitive' } } },
        ],
      };
    }

    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.inventory.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          sku: {
            include: {
              variant: { select: { id: true, name: true } },
              product: {
                select: { id: true, title: true, sellerId: true, seller: { select: { storeName: true } } },
              },
            },
          },
        },
      }),
      prisma.inventory.count({ where }),
    ]);

    let mapped = items.map((inv) => {
      const availableQty = inv.onHandQty - inv.reservedQty;
      return {
        ...inv,
        availableQty,
        isLowStock: availableQty <= inv.reorderPoint,
      };
    });

    if (query.lowStockOnly === 'true') {
      mapped = mapped.filter((i) => i.isLowStock);
    }

    return { items: mapped, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async adjustStock(
    input: {
      skuId: string;
      warehouseId: string;
      movementType: InventoryMovementType;
      quantity: number;
      notes?: string;
      idempotencyKey?: string;
    },
    caller: { userId: string; roles: RoleName[]; sellerId?: string | null },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const sku = await prisma.sku.findUnique({
      where: { id: input.skuId },
      include: { product: { select: { sellerId: true } } },
    });
    if (!sku) throw new NotFoundError('SKU not found');

    const isPrivileged =
      caller.roles.includes(RoleName.ADMIN) || caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);
    if (!isPrivileged && sku.product.sellerId !== caller.sellerId) {
      throw new ForbiddenError('Sellers can only adjust stock for their own SKUs');
    }

    const result = await prisma.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existingLedger = await tx.inventoryLedger.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existingLedger) {
          return tx.inventory.findUniqueOrThrow({ where: { id: existingLedger.inventoryId } });
        }
      }

      let inv = await tx.inventory.findUnique({
        where: { skuId_warehouseId: { skuId: input.skuId, warehouseId: input.warehouseId } },
      });
      if (!inv) {
        inv = await tx.inventory.create({
          data: { skuId: input.skuId, warehouseId: input.warehouseId, onHandQty: 0, reservedQty: 0 },
        });
      }

      const lockedRows = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT id, sku_id, warehouse_id, on_hand_qty, reserved_qty
        FROM inventory
        WHERE id = ${inv.id}::uuid
        FOR UPDATE
      `;
      const current = lockedRows[0]!;
      const isIncrease =
        input.movementType === InventoryMovementType.ADJUSTMENT_IN ||
        input.movementType === InventoryMovementType.RETURN_RESTOCK;

      const delta = isIncrease ? input.quantity : -input.quantity;
      const nextOnHand = current.on_hand_qty + delta;

      if (nextOnHand < current.reserved_qty) {
        throw new ValidationError(
          `Cannot reduce on-hand stock below active reserved quantity (${current.reserved_qty})`,
          [],
          'STOCK_BELOW_RESERVED',
        );
      }

      const updated = await tx.inventory.update({
        where: { id: current.id },
        data: {
          onHandQty: nextOnHand,
          damagedQty:
            input.movementType === InventoryMovementType.DAMAGED
              ? { increment: input.quantity }
              : undefined,
          version: { increment: 1 },
        },
      });

      const availableAfter = updated.onHandQty - updated.reservedQty;
      await tx.inventoryLedger.create({
        data: {
          inventoryId: updated.id,
          skuId: input.skuId,
          warehouseId: input.warehouseId,
          movementType: input.movementType,
          quantityDelta: delta,
          balanceAfter: availableAfter,
          referenceType: 'MANUAL_ADJUSTMENT',
          referenceId: updated.id,
          idempotencyKey: input.idempotencyKey,
          actorUserId: caller.userId,
          notes: input.notes,
        },
      });

      await recordAuditLog(tx, {
        actorUserId: caller.userId,
        actorRole: caller.roles[0],
        action: 'INVENTORY_ADJUSTED',
        resourceType: 'INVENTORY',
        resourceId: updated.id,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        beforeState: { onHandQty: current.on_hand_qty, reservedQty: current.reserved_qty },
        afterState: { onHandQty: updated.onHandQty, reservedQty: updated.reservedQty, movementType: input.movementType },
      });

      return updated;
    });

    return {
      ...result,
      availableQty: result.onHandQty - result.reservedQty,
    };
  },

  async listLedger(
    query: { page: number; limit: number; warehouseId?: string; skuId?: string },
    caller: { roles: RoleName[]; sellerId?: string | null },
  ) {
    const where: Prisma.InventoryLedgerWhereInput = {};
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.skuId) where.skuId = query.skuId;

    const isSellerOnly =
      caller.roles.includes(RoleName.SELLER) &&
      !caller.roles.includes(RoleName.ADMIN) &&
      !caller.roles.includes(RoleName.WAREHOUSE_OPERATOR);
    if (isSellerOnly) {
      where.sku = { product: { sellerId: caller.sellerId ?? '__none__' } };
    }

    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.inventoryLedger.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          sku: { select: { skuCode: true, product: { select: { title: true } } } },
          warehouse: { select: { code: true, name: true } },
          actorUser: { select: { email: true, firstName: true, lastName: true } },
        },
      }),
      prisma.inventoryLedger.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async listReservations(query: { page: number; limit: number; status?: ReservationStatus }) {
    const where: Prisma.InventoryReservationWhereInput = {};
    if (query.status) where.status = query.status;
    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.inventoryReservation.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          sku: { select: { skuCode: true } },
          warehouse: { select: { code: true, name: true } },
          order: { select: { orderNumber: true, status: true } },
        },
      }),
      prisma.inventoryReservation.count({ where }),
    ]);
    return { items, meta: buildPaginationMeta(query.page, query.limit, total) };
  },
};
