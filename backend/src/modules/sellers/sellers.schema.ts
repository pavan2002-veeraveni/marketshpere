import { z } from 'zod';
import { SellerOnboardingStatus } from '@prisma/client';

export const registerSellerSchema = z.object({
  body: z.object({
    storeName: z.string().trim().min(2).max(150),
    legalBusinessName: z.string().trim().min(2).max(200),
    taxIdMasked: z.string().trim().min(4).max(40),
    supportEmail: z.string().trim().email().max(255),
    supportPhone: z.string().trim().min(4).max(30),
    payoutAccountMasked: z.string().trim().min(4).max(80).optional(),
    returnPolicy: z.string().trim().max(2000).optional(),
    bio: z.string().trim().max(2000).optional(),
  }),
});

export const updateSellerProfileSchema = z.object({
  body: z.object({
    storeName: z.string().trim().min(2).max(150).optional(),
    legalBusinessName: z.string().trim().min(2).max(200).optional(),
    supportEmail: z.string().trim().email().max(255).optional(),
    supportPhone: z.string().trim().min(4).max(30).optional(),
    payoutAccountMasked: z.string().trim().max(80).optional(),
    returnPolicy: z.string().trim().max(2000).optional(),
    bio: z.string().trim().max(2000).optional(),
  }),
});

export const onboardingDocSchema = z.object({
  body: z.object({
    step: z.string().trim().min(2).max(60).default('BUSINESS_VERIFICATION'),
    documentType: z.string().trim().min(2).max(80).default('BUSINESS_LICENSE'),
    submitForReview: z.coerce.boolean().default(true),
  }),
});

export const listSellersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.nativeEnum(SellerOnboardingStatus).optional(),
    search: z.string().trim().optional(),
  }),
});

export const updateSellerStatusSchema = z.object({
  params: z.object({ sellerId: z.string().uuid() }),
  body: z.object({
    status: z.nativeEnum(SellerOnboardingStatus),
    reason: z.string().trim().max(1000).optional(),
    commissionRateOverride: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().optional(),
  }),
});
