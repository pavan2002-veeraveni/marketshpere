import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  INTERNAL_SERVICE_TOKEN: z.string().min(12).default('marketsphere_local_internal_service_token'),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  UPLOAD_STORAGE_DIR: z.string().default(process.env.VERCEL ? '/tmp/marketsphere-uploads' : './uploads'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(12).default('marketsphere_sandbox_payment_webhook_secret'),
  SHIPPING_WEBHOOK_SECRET: z.string().min(12).default('marketsphere_sandbox_shipping_webhook_secret'),
  PYTHON_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  PYTHON_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DEFAULT_TAX_RATE: z.string().default('0.0825'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid backend environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
const vercelOrigins = [
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : null,
  process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null,
].filter((o): o is string => Boolean(o));

export const allowedOrigins = Array.from(
  new Set([
    ...env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    ...vercelOrigins,
  ]),
);
