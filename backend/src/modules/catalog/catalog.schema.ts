import { z } from 'zod';
import { ProductStatus } from '@prisma/client';

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(2).max(140).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().trim().max(1000).optional(),
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.coerce.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({ categoryId: z.string().uuid() }),
  body: createCategorySchema.shape.body.partial(),
});

export const listProductsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(200).optional(),
    categoryId: z.string().uuid().optional(),
    categorySlug: z.string().trim().optional(),
    sellerId: z.string().uuid().optional(),
    minPrice: z.coerce.number().nonnegative().optional(),
    maxPrice: z.coerce.number().nonnegative().optional(),
    inStock: z.enum(['true', 'false']).optional(),
    sortBy: z.enum(['newest', 'price_asc', 'price_desc', 'title']).default('newest'),
    status: z.nativeEnum(ProductStatus).optional(),
  }),
});

export const createProductSchema = z.object({
  body: z.object({
    categoryId: z.string().uuid(),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().min(10).max(5000),
    brand: z.string().trim().max(120).optional(),
    status: z.enum(['DRAFT', 'PENDING_MODERATION', 'ACTIVE']).default('ACTIVE'),
    images: z
      .array(
        z.object({
          url: z.string().trim().min(1).max(500),
          altText: z.string().trim().max(255).optional(),
          isPrimary: z.boolean().default(false),
        }),
      )
      .default([]),
    attributes: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(100),
          value: z.string().trim().min(1).max(255),
        }),
      )
      .default([]),
    variants: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(150),
          optionValues: z.record(z.string()).default({}),
          skuCode: z.string().trim().min(2).max(80),
          price: z.string().regex(/^\d+(\.\d{1,2})?$/),
          compareAtPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          costPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          weightGrams: z.coerce.number().int().positive().optional(),
          initialStock: z.coerce.number().int().min(0).default(0),
          warehouseId: z.string().uuid().optional(),
        }),
      )
      .min(1, 'At least one variant/SKU is required'),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    categoryId: z.string().uuid().optional(),
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().min(10).max(5000).optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    status: z.nativeEnum(ProductStatus).optional(),
  }),
});

export const addSkuSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    variantName: z.string().trim().min(1).max(150),
    optionValues: z.record(z.string()).default({}),
    skuCode: z.string().trim().min(2).max(80),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/),
    compareAtPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    initialStock: z.coerce.number().int().min(0).default(0),
    warehouseId: z.string().uuid().optional(),
  }),
});

export const moderateProductSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    status: z.enum(['ACTIVE', 'REJECTED', 'ARCHIVED']),
    moderationNotes: z.string().trim().max(1000).optional(),
  }),
});

export const feedImportSchema = z.object({
  body: z.object({
    format: z.enum(['csv', 'json']).default('json'),
    content: z.string().min(2).optional(),
    warehouseId: z.string().uuid().optional(),
    async: z.boolean().optional().default(false),
  }),
});
