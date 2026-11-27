import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().trim().email().max(255).transform((v) => v.toLowerCase()),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128)
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[a-z]/, 'Password must contain a lowercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z.string().trim().max(30).optional(),
    accountType: z.enum(['CUSTOMER', 'SELLER']).default('CUSTOMER'),
    storeName: z.string().trim().min(2).max(150).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().email().transform((v) => v.toLowerCase()),
    password: z.string().min(1),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(20).optional(),
  }),
});

export const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(20).optional(),
  }),
});

export const passwordResetRequestSchema = z.object({
  body: z.object({
    email: z.string().trim().email().transform((v) => v.toLowerCase()),
  }),
});

export const passwordResetConfirmSchema = z.object({
  body: z.object({
    token: z.string().min(20),
    newPassword: z
      .string()
      .min(8)
      .max(128)
      .regex(/[A-Z]/)
      .regex(/[a-z]/)
      .regex(/[0-9]/),
  }),
});
