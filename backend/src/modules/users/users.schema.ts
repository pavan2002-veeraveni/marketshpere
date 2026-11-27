import { z } from 'zod';

export const updateProfileSchema = z.object({
  body: z.object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
  }),
});

export const createAddressSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1).max(80),
    recipientName: z.string().trim().min(1).max(150),
    line1: z.string().trim().min(1).max(255),
    line2: z.string().trim().max(255).optional(),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().min(2).max(30),
    country: z.string().trim().min(2).max(80).default('US'),
    phone: z.string().trim().min(4).max(30),
    isDefault: z.boolean().default(false),
  }),
});

export const updateAddressSchema = z.object({
  params: z.object({ addressId: z.string().uuid() }),
  body: createAddressSchema.shape.body.partial(),
});

export const addressIdParamSchema = z.object({
  params: z.object({ addressId: z.string().uuid() }),
});
