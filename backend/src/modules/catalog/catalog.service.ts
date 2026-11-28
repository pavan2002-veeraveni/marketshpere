import crypto from 'crypto';
import { InventoryMovementType, Prisma, ProductStatus, RoleName } from '@prisma/client';
import { prisma } from '../../common/prisma';
import { cacheDeletePrefix, cacheGetJson, cacheSetJson } from '../../common/redis';
import { recordAuditLog } from '../../common/audit';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { validateAndPersistSandboxUpload } from '../../common/upload';
import { pythonClient } from '../../integrations/python-client';
import { assertSellerOwnership } from '../sellers/sellers.service';

function makeSlug(value: string, uniqueSuffix = true): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  return uniqueSuffix ? `${base}-${crypto.randomBytes(2).toString('hex')}` : base;
}

export const catalogService = {
  async listCategories() {
    const cached = await cacheGetJson<Awaited<ReturnType<typeof prisma.category.findMany>>>('catalog:categories');
    if (cached) return cached;
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    await cacheSetJson('catalog:categories', categories, 120);
    return categories;
  },

  async createCategory(
    input: { name: string; slug?: string; description?: string; parentId?: string | null; sortOrder: number; isActive: boolean },
    actorUserId: string,
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const slug = input.slug ?? makeSlug(input.name, false);
    const created = await prisma.category.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
    await recordAuditLog(prisma, {
      actorUserId,
      actorRole: RoleName.ADMIN,
      action: 'CATEGORY_CREATED',
      resourceType: 'CATEGORY',
      resourceId: created.id,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
      afterState: created,
    });
    await cacheDeletePrefix('catalog:');
    return created;
  },

  async updateCategory(categoryId: string, input: Record<string, unknown>, actorUserId: string) {
    const existing = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing) throw new NotFoundError('Category not found');
    const updated = await prisma.category.update({ where: { id: categoryId }, data: input });
    await recordAuditLog(prisma, {
      actorUserId,
      actorRole: RoleName.ADMIN,
      action: 'CATEGORY_UPDATED',
      resourceType: 'CATEGORY',
      resourceId: categoryId,
      beforeState: existing,
      afterState: updated,
    });
    await cacheDeletePrefix('catalog:');
    return updated;
  },

  async deleteCategory(categoryId: string, actorUserId: string) {
    const existing = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing) throw new NotFoundError('Category not found');
    const count = await prisma.product.count({ where: { categoryId, deletedAt: null } });
    if (count > 0) {
      throw new ConflictError('Cannot delete category with active products', 'CATEGORY_IN_USE');
    }
    await prisma.category.delete({ where: { id: categoryId } });
    await recordAuditLog(prisma, {
      actorUserId,
      actorRole: RoleName.ADMIN,
      action: 'CATEGORY_DELETED',
      resourceType: 'CATEGORY',
      resourceId: categoryId,
    });
    await cacheDeletePrefix('catalog:');
    return { deleted: true };
  },

  async listPublicProducts(query: {
    page: number;
    limit: number;
    search?: string;
    categoryId?: string;
    categorySlug?: string;
    sellerId?: string;
    minPrice?: number;
    maxPrice?: number;
    inStock?: 'true' | 'false';
    sortBy: 'newest' | 'price_asc' | 'price_desc' | 'title';
  }) {
    const cacheKey = `catalog:products:${JSON.stringify(query)}`;
    const cached = await cacheGetJson<{ items: unknown[]; meta: ReturnType<typeof buildPaginationMeta> }>(cacheKey);
    if (cached) return cached;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`p.deleted_at IS NULL`,
      Prisma.sql`p.status = 'ACTIVE'`,
      Prisma.sql`sel.onboarding_status = 'APPROVED'`,
    ];

    if (query.categoryId) {
      conditions.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    }
    if (query.categorySlug) {
      conditions.push(Prisma.sql`c.slug = ${query.categorySlug}`);
    }
    if (query.sellerId) {
      conditions.push(Prisma.sql`p.seller_id = ${query.sellerId}::uuid`);
    }
    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(Prisma.sql`(
        p.title ILIKE ${pattern}
        OR p.description ILIKE ${pattern}
        OR COALESCE(p.brand, '') ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM skus s2
          WHERE s2.product_id = p.id AND s2.is_active = true AND s2.deleted_at IS NULL AND s2.sku_code ILIKE ${pattern}
        )
      )`);
    }
    if (query.minPrice !== undefined) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM skus sp
        WHERE sp.product_id = p.id AND sp.is_active = true AND sp.deleted_at IS NULL AND sp.price >= ${query.minPrice}::numeric
      )`);
    }
    if (query.maxPrice !== undefined) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM skus sp
        WHERE sp.product_id = p.id AND sp.is_active = true AND sp.deleted_at IS NULL AND sp.price <= ${query.maxPrice}::numeric
      )`);
    }
    if (query.inStock === 'true') {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM skus si
        JOIN inventory inv ON inv.sku_id = si.id
        WHERE si.product_id = p.id AND si.is_active = true AND si.deleted_at IS NULL AND (inv.on_hand_qty - inv.reserved_qty) > 0
      )`);
    }

    const whereSql = Prisma.join(conditions, ' AND ');
    const { skip, take } = getSkipTake(query.page, query.limit);

    const orderBySql =
      query.sortBy === 'price_asc'
        ? Prisma.sql`COALESCE(MIN(s.price), 0) ASC, p.created_at DESC`
        : query.sortBy === 'price_desc'
          ? Prisma.sql`COALESCE(MIN(s.price), 0) DESC, p.created_at DESC`
          : query.sortBy === 'title'
            ? Prisma.sql`p.title ASC, p.created_at DESC`
            : Prisma.sql`p.created_at DESC`;

    const [orderedRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p.id
        FROM products p
        JOIN sellers sel ON sel.id = p.seller_id
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN skus s ON s.product_id = p.id AND s.is_active = true AND s.deleted_at IS NULL
        WHERE ${whereSql}
        GROUP BY p.id, p.title, p.created_at
        ORDER BY ${orderBySql}
        LIMIT ${take} OFFSET ${skip}
      `,
      prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM products p
        JOIN sellers sel ON sel.id = p.seller_id
        JOIN categories c ON c.id = p.category_id
        WHERE ${whereSql}
      `,
    ]);

    const orderedIds = orderedRows.map((r) => r.id);
    const total = Number(countRows[0]?.total ?? 0);

    const fetched = orderedIds.length
      ? await prisma.product.findMany({
          where: { id: { in: orderedIds } },
          include: {
            category: { select: { id: true, name: true, slug: true } },
            seller: { select: { id: true, storeName: true, storeSlug: true } },
            images: { orderBy: { sortOrder: 'asc' } },
            skus: {
              where: { isActive: true, deletedAt: null },
              include: {
                variant: true,
                inventories: {
                  select: { id: true, warehouseId: true, onHandQty: true, reservedQty: true },
                },
              },
              orderBy: { price: 'asc' },
            },
            reviews: {
              where: { moderationStatus: 'APPROVED' },
              select: { rating: true },
            },
          },
        })
      : [];

    const orderIndex = new Map(orderedIds.map((id, idx) => [id, idx]));
    fetched.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));

    const mapped = fetched.map((p) => {
      const prices = p.skus.map((s) => Number(s.price));
      const minSkuPrice = prices.length ? Math.min(...prices) : 0;
      const totalAvailable = p.skus.reduce(
        (acc, s) => acc + s.inventories.reduce((a2, inv) => a2 + Math.max(0, inv.onHandQty - inv.reservedQty), 0),
        0,
      );
      const avgRating =
        p.reviews.length > 0
          ? Number((p.reviews.reduce((a, r) => a + r.rating, 0) / p.reviews.length).toFixed(2))
          : 0;
      return {
        ...p,
        minPrice: minSkuPrice.toFixed(2),
        availableStock: totalAvailable,
        averageRating: avgRating,
        reviewCount: p.reviews.length,
      };
    });

    const result = { items: mapped, meta: buildPaginationMeta(query.page, query.limit, total) };
    await cacheSetJson(cacheKey, result, 30);
    return result;
  },

  async getProductDetail(slugOrId: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
    const product = await prisma.product.findFirst({
      where: {
        deletedAt: null,
        ...(isUuid ? { id: slugOrId } : { slug: slugOrId }),
      },
      include: {
        category: true,
        seller: { select: { id: true, storeName: true, storeSlug: true, onboardingStatus: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        attributes: true,
        variants: { where: { isActive: true } },
        skus: {
          where: { isActive: true, deletedAt: null },
          include: {
            variant: true,
            inventories: {
              include: { warehouse: { select: { id: true, code: true, name: true } } },
            },
          },
        },
        reviews: {
          where: { moderationStatus: 'APPROVED' },
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 25,
        },
      },
    });

    if (!product) throw new NotFoundError('Product not found');

    const skusWithAvailability = product.skus.map((sku) => {
      const availableQty = sku.inventories.reduce(
        (acc, inv) => acc + Math.max(0, inv.onHandQty - inv.reservedQty),
        0,
      );
      return { ...sku, availableQty };
    });

    const avgRating =
      product.reviews.length > 0
        ? Number((product.reviews.reduce((a, r) => a + r.rating, 0) / product.reviews.length).toFixed(2))
        : 0;

    return {
      ...product,
      skus: skusWithAvailability,
      averageRating: avgRating,
      reviewCount: product.reviews.length,
    };
  },

  async getRecommendationsForProduct(productId: string | undefined, customerId?: string, requestId?: string) {
    const [products, customerOrders] = await Promise.all([
      prisma.product.findMany({
        where: { deletedAt: null, status: ProductStatus.ACTIVE },
        include: {
          images: { where: { isPrimary: true }, take: 1 },
          skus: { where: { isActive: true }, take: 1, orderBy: { price: 'asc' } },
          category: { select: { id: true, name: true, slug: true } },
          _count: { select: { orderItems: true, reviews: true } },
        },
        take: 100,
      }),
      customerId
        ? prisma.orderItem.findMany({
            where: { order: { customerId, status: { not: 'CANCELLED' } } },
            select: { productId: true, product: { select: { categoryId: true } } },
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    const catalogPayload = products.map((p) => ({
      product_id: p.id,
      category_id: p.categoryId,
      title: p.title,
      popularity_score: p._count.orderItems * 3 + p._count.reviews * 2 + 1,
      price: p.skus[0]?.price.toString() ?? '0.00',
    }));

    const purchasedProductIds = Array.from(new Set(customerOrders.map((o) => o.productId)));
    const viewedCategoryIds = Array.from(new Set(customerOrders.map((o) => o.product.categoryId)));

    const recResp = await pythonClient.getRecommendations({
      customerId,
      productId,
      catalog: catalogPayload,
      purchasedProductIds,
      viewedCategoryIds,
      limit: 6,
      requestId,
    });

    const productMap = new Map(products.map((p) => [p.id, p]));
    const items = recResp.recommendations
      .map((rec) => {
        const prod = productMap.get(rec.productId);
        if (!prod) return null;
        return {
          ...prod,
          recommendationScore: rec.score,
          recommendationReason: rec.reason,
        };
      })
      .filter(Boolean);

    return { strategy: recResp.strategy, items };
  },

  async listSellerProducts(sellerId: string, query: { page: number; limit: number; search?: string; status?: ProductStatus }) {
    const where: Prisma.ProductWhereInput = { sellerId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { skus: { some: { skuCode: { contains: query.search, mode: 'insensitive' } } } },
      ];
    }

    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          category: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          skus: {
            where: { deletedAt: null },
            include: { inventories: true, variant: true },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async createSellerProduct(
    sellerId: string,
    actorUserId: string,
    input: {
      categoryId: string;
      title: string;
      description: string;
      brand?: string;
      status: 'DRAFT' | 'PENDING_MODERATION' | 'ACTIVE';
      images: Array<{ url: string; altText?: string; isPrimary: boolean }>;
      attributes: Array<{ name: string; value: string }>;
      variants: Array<{
        name: string;
        optionValues: Record<string, string>;
        skuCode: string;
        price: string;
        compareAtPrice?: string;
        costPrice?: string;
        weightGrams?: number;
        initialStock: number;
        warehouseId?: string;
      }>;
    },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw new NotFoundError('Category not found');

    const defaultWarehouse = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!defaultWarehouse) throw new ValidationError('No active warehouse configured');

    const created = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sellerId,
          categoryId: input.categoryId,
          title: input.title,
          slug: makeSlug(input.title),
          description: input.description,
          brand: input.brand,
          status: input.status,
          images: {
            create: input.images.map((img, idx) => ({
              url: img.url,
              altText: img.altText ?? input.title,
              isPrimary: img.isPrimary || idx === 0,
              sortOrder: idx,
            })),
          },
          attributes: {
            create: input.attributes,
          },
        },
      });

      for (const v of input.variants) {
        const variant = await tx.productVariant.create({
          data: {
            productId: product.id,
            name: v.name,
            optionValues: v.optionValues,
          },
        });

        const sku = await tx.sku.create({
          data: {
            productId: product.id,
            variantId: variant.id,
            skuCode: v.skuCode.toUpperCase(),
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            costPrice: v.costPrice,
            weightGrams: v.weightGrams,
          },
        });

        const warehouseId = v.warehouseId ?? defaultWarehouse.id;
        const inv = await tx.inventory.create({
          data: {
            skuId: sku.id,
            warehouseId,
            onHandQty: v.initialStock,
            reservedQty: 0,
          },
        });

        if (v.initialStock > 0) {
          await tx.inventoryLedger.create({
            data: {
              inventoryId: inv.id,
              skuId: sku.id,
              warehouseId,
              movementType: InventoryMovementType.ADJUSTMENT_IN,
              quantityDelta: v.initialStock,
              balanceAfter: v.initialStock,
              referenceType: 'PRODUCT_CREATE',
              referenceId: product.id,
              actorUserId,
              notes: 'Initial SKU stock on product creation',
            },
          });
        }
      }

      await recordAuditLog(tx, {
        actorUserId,
        actorRole: RoleName.SELLER,
        action: 'PRODUCT_CREATED',
        resourceType: 'PRODUCT',
        resourceId: product.id,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        afterState: { title: product.title, skuCount: input.variants.length },
      });

      return tx.product.findUniqueOrThrow({
        where: { id: product.id },
        include: { images: true, attributes: true, variants: true, skus: { include: { inventories: true } } },
      });
    });
    await cacheDeletePrefix('catalog:');
    return created;
  },

  async getSellerProductById(productId: string, callerSellerId: string | null | undefined, roles: RoleName[]) {
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { images: true, attributes: true, variants: true, skus: { include: { inventories: true } } },
    });
    if (!product) throw new NotFoundError('Product not found');
    assertSellerOwnership(product.sellerId, callerSellerId, roles);
    return product;
  },

  async updateSellerProduct(
    productId: string,
    callerSellerId: string | null | undefined,
    roles: RoleName[],
    actorUserId: string,
    input: { categoryId?: string; title?: string; description?: string; brand?: string | null; status?: ProductStatus },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const existing = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!existing) throw new NotFoundError('Product not found');
    assertSellerOwnership(existing.sellerId, callerSellerId, roles);

    const updated = await prisma.product.update({
      where: { id: productId },
      data: input,
      include: { images: true, skus: true },
    });

    await recordAuditLog(prisma, {
      actorUserId,
      actorRole: roles[0] ?? RoleName.SELLER,
      action: 'PRODUCT_UPDATED',
      resourceType: 'PRODUCT',
      resourceId: productId,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
      beforeState: { title: existing.title, status: existing.status },
      afterState: { title: updated.title, status: updated.status },
    });
    await cacheDeletePrefix('catalog:');
    return updated;
  },

  async deleteSellerProduct(
    productId: string,
    callerSellerId: string | null | undefined,
    roles: RoleName[],
    actorUserId: string,
  ) {
    const existing = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!existing) throw new NotFoundError('Product not found');
    assertSellerOwnership(existing.sellerId, callerSellerId, roles);

    await prisma.product.update({
      where: { id: productId },
      data: { deletedAt: new Date(), status: ProductStatus.ARCHIVED },
    });
    await recordAuditLog(prisma, {
      actorUserId,
      actorRole: roles[0] ?? RoleName.SELLER,
      action: 'PRODUCT_ARCHIVED',
      resourceType: 'PRODUCT',
      resourceId: productId,
    });
    await cacheDeletePrefix('catalog:');
    return { deleted: true };
  },

  async uploadProductImage(
    productId: string,
    callerSellerId: string | null | undefined,
    roles: RoleName[],
    file: Express.Multer.File | undefined,
  ) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!product) throw new NotFoundError('Product not found');
    assertSellerOwnership(product.sellerId, callerSellerId, roles);
    if (!file) throw new ValidationError('Image file is required');

    const stored = await validateAndPersistSandboxUpload(file, 'products', [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    return prisma.productImage.create({
      data: {
        productId,
        url: `/uploads/${stored.storageKey}`,
        storageKey: stored.storageKey,
        altText: product.title,
        isPrimary: false,
      },
    });
  },

  async addProductSku(
    productId: string,
    callerSellerId: string | null | undefined,
    roles: RoleName[],
    actorUserId: string,
    input: {
      variantName: string;
      optionValues: Record<string, string>;
      skuCode: string;
      price: string;
      compareAtPrice?: string;
      initialStock: number;
      warehouseId?: string;
    },
  ) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!product) throw new NotFoundError('Product not found');
    assertSellerOwnership(product.sellerId, callerSellerId, roles);

    const warehouse = input.warehouseId
      ? await prisma.warehouse.findUnique({ where: { id: input.warehouseId } })
      : await prisma.warehouse.findFirst({ where: { isActive: true } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');

    const created = await prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.create({
        data: { productId, name: input.variantName, optionValues: input.optionValues },
      });
      const sku = await tx.sku.create({
        data: {
          productId,
          variantId: variant.id,
          skuCode: input.skuCode.toUpperCase(),
          price: input.price,
          compareAtPrice: input.compareAtPrice,
        },
      });
      const inv = await tx.inventory.create({
        data: { skuId: sku.id, warehouseId: warehouse.id, onHandQty: input.initialStock, reservedQty: 0 },
      });
      if (input.initialStock > 0) {
        await tx.inventoryLedger.create({
          data: {
            inventoryId: inv.id,
            skuId: sku.id,
            warehouseId: warehouse.id,
            movementType: InventoryMovementType.ADJUSTMENT_IN,
            quantityDelta: input.initialStock,
            balanceAfter: input.initialStock,
            referenceType: 'SKU_CREATE',
            referenceId: sku.id,
            actorUserId,
          },
        });
      }
      return sku;
    });
    await cacheDeletePrefix('catalog:');
    return created;
  },

  async importProductFeed(
    sellerId: string,
    actorUserId: string,
    format: 'csv' | 'json',
    content: string,
    warehouseId?: string,
    requestId?: string,
    uploadedFile?: { buffer: Buffer; filename: string; mimeType: string },
  ) {
    const processed = uploadedFile
      ? await pythonClient.processFeedUpload({
          buffer: uploadedFile.buffer,
          filename: uploadedFile.filename,
          mimeType: uploadedFile.mimeType,
          requestId,
        })
      : await pythonClient.processFeed({ format, content, requestId });
    const defaultCategory = await prisma.category.findFirst({ where: { isActive: true } });
    const warehouse = warehouseId
      ? await prisma.warehouse.findUnique({ where: { id: warehouseId } })
      : await prisma.warehouse.findFirst({ where: { isActive: true } });
    if (!defaultCategory || !warehouse) {
      throw new ValidationError('Active category and warehouse required for feed import');
    }

    const categories = await prisma.category.findMany();
    const catBySlug = new Map(categories.map((c) => [c.slug, c.id]));

    let importedCount = 0;
    const persistenceErrors: Array<{ skuCode: string; message: string }> = [];

    for (const item of processed.normalized_items) {
      try {
        const existingSku = await prisma.sku.findUnique({ where: { skuCode: item.sku_code } });
        if (existingSku) {
          persistenceErrors.push({ skuCode: item.sku_code, message: 'SKU already exists in catalog' });
          continue;
        }
        const categoryId = catBySlug.get(item.category_slug) ?? defaultCategory.id;
        await prisma.$transaction(async (tx) => {
          const prod = await tx.product.create({
            data: {
              sellerId,
              categoryId,
              title: item.title,
              slug: makeSlug(item.title),
              description: item.description,
              brand: item.brand,
              status: ProductStatus.ACTIVE,
            },
          });
          const variant = await tx.productVariant.create({
            data: { productId: prod.id, name: 'Default', optionValues: { source: 'feed' } },
          });
          const sku = await tx.sku.create({
            data: { productId: prod.id, variantId: variant.id, skuCode: item.sku_code, price: item.price },
          });
          const inv = await tx.inventory.create({
            data: { skuId: sku.id, warehouseId: warehouse.id, onHandQty: item.quantity, reservedQty: 0 },
          });
          if (item.quantity > 0) {
            await tx.inventoryLedger.create({
              data: {
                inventoryId: inv.id,
                skuId: sku.id,
                warehouseId: warehouse.id,
                movementType: InventoryMovementType.ADJUSTMENT_IN,
                quantityDelta: item.quantity,
                balanceAfter: item.quantity,
                referenceType: 'FEED_IMPORT',
                referenceId: sku.skuCode,
                actorUserId,
              },
            });
          }
        });
        importedCount++;
      } catch (err) {
        persistenceErrors.push({
          skuCode: item.sku_code,
          message: err instanceof Error ? err.message : 'Failed to import SKU',
        });
      }
    }

    await cacheDeletePrefix('catalog:');
    return {
      totalRows: processed.total_rows,
      validRows: processed.valid_rows,
      invalidRows: processed.invalid_rows,
      duplicateSkus: processed.duplicate_skus,
      importedCount,
      validationErrors: processed.errors,
      persistenceErrors,
    };
  },

  async listAdminProducts(query: { page: number; limit: number; status?: ProductStatus; search?: string }) {
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { seller: { storeName: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          seller: { select: { id: true, storeName: true } },
          category: { select: { id: true, name: true } },
          skus: { select: { id: true, skuCode: true, price: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);
    return { items, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async moderateProduct(
    productId: string,
    input: { status: 'ACTIVE' | 'REJECTED' | 'ARCHIVED'; moderationNotes?: string },
    adminUserId: string,
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { seller: { select: { userId: true } } },
    });
    if (!product) throw new NotFoundError('Product not found');

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { status: input.status, moderationNotes: input.moderationNotes },
    });

    await prisma.notification.create({
      data: {
        userId: product.seller.userId,
        type: 'PRODUCT_MODERATED',
        title: `Product "${product.title}" marked ${input.status}`,
        message: input.moderationNotes ?? `Moderation status updated to ${input.status}.`,
      },
    });

    await recordAuditLog(prisma, {
      actorUserId: adminUserId,
      actorRole: RoleName.ADMIN,
      action: 'PRODUCT_MODERATED',
      resourceType: 'PRODUCT',
      resourceId: productId,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
      beforeState: { status: product.status },
      afterState: { status: updated.status, moderationNotes: input.moderationNotes },
    });
    await cacheDeletePrefix('catalog:');
    return updated;
  },
};
