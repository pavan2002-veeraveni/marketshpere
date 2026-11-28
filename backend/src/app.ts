import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { allowedOrigins, env } from './config/env';
import { logger } from './common/logger';
import { requestIdMiddleware } from './common/middleware/request-id';
import { metricsMiddleware } from './common/metrics';
import { globalRateLimiter } from './common/middleware/rate-limit';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler';
import { openApiSpec } from './docs/openapi';
import { healthRouter } from './modules/health/health.routes';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { sellersRouter } from './modules/sellers/sellers.routes';
import {
  adminCatalogRouter,
  categoriesRouter,
  productsRouter,
  sellerCatalogRouter,
} from './modules/catalog/catalog.routes';
import { inventoryRouter, warehousesRouter } from './modules/inventory/inventory.routes';
import { discountsRouter } from './modules/promotions/promotions.routes';
import { cartRouter } from './modules/cart/cart.routes';
import { checkoutRouter } from './modules/checkout/checkout.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { paymentsRouter } from './modules/payments/payments.routes';
import { shipmentsRouter } from './modules/shipping/shipping.routes';
import { webhooksRouter } from './modules/webhooks/webhooks.routes';
import { refundsRouter, returnsRouter } from './modules/returns/returns.routes';
import { reviewsRouter } from './modules/reviews/reviews.routes';
import { commissionsRouter } from './modules/commissions/commissions.routes';
import { settlementsRouter } from './modules/settlements/settlements.routes';
import { disputesRouter, supportRouter } from './modules/support/support.routes';
import { adminRouter } from './modules/admin/admin.routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(requestIdMiddleware);
  app.use(metricsMiddleware);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
    }),
  );

  app.use(globalRateLimiter);

  // Static sandbox uploads for product images (never exposes onboarding docs)
  app.use('/uploads/products', express.static(path.resolve(process.cwd(), env.UPLOAD_STORAGE_DIR, 'products')));

  // OpenAPI / Swagger Docs (serve without trailing-slash redirect so Vercel slash normalization never loops)
  const localDistCandidates = [
    path.resolve(__dirname, '../../node_modules/swagger-ui-dist'),
    path.resolve(process.cwd(), 'node_modules/swagger-ui-dist'),
    path.resolve(process.cwd(), 'backend/node_modules/swagger-ui-dist'),
  ];
  const localDistDir = localDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'swagger-ui.css')));
  const rawSwaggerHtml = swaggerUi.generateHTML(openApiSpec);
  let swaggerHtml = rawSwaggerHtml.replace(/(href|src)="\.\//g, '$1="/api/docs/');
  let swaggerCsp: string | null = null;

  if (!localDistDir) {
    const pkgCandidate = localDistCandidates
      .map((dir) => path.join(dir, 'package.json'))
      .find((pkgPath) => fs.existsSync(pkgPath));
    let swaggerDistVersion = '5.36.0';
    if (pkgCandidate) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgCandidate, 'utf8')) as { version?: string };
        if (parsed.version) swaggerDistVersion = parsed.version;
      } catch {
        // Fallback to pinned swagger-ui-dist version
      }
    }
    const cdnOrigin = 'https://cdn.jsdelivr.net';
    const cdnBase = `${cdnOrigin}/npm/swagger-ui-dist@${swaggerDistVersion}`;
    swaggerHtml = rawSwaggerHtml
      .replace('src="./swagger-ui-init.js"', 'src="/api/docs/swagger-ui-init.js"')
      .replace(/(href|src)="\.\//g, `$1="${cdnBase}/`);
    swaggerCsp = [
      "default-src 'self'",
      `script-src 'self' ${cdnOrigin}`,
      `style-src 'self' 'unsafe-inline' ${cdnOrigin}`,
      `img-src 'self' data: ${cdnOrigin}`,
      "font-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
  }

  app.get('/api/docs.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serveWithOptions({ redirect: false }));
  app.get('/api/docs', (_req, res) => {
    if (swaggerCsp) {
      res.setHeader('Content-Security-Policy', swaggerCsp);
    }
    res.type('html').send(swaggerHtml);
  });

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/sellers', sellersRouter);
  api.use('/categories', categoriesRouter);
  api.use('/products', productsRouter);
  api.use('/seller', sellerCatalogRouter);
  api.use('/admin', adminCatalogRouter);
  api.use('/warehouses', warehousesRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/discounts', discountsRouter);
  api.use('/cart', cartRouter);
  api.use('/checkout', checkoutRouter);
  api.use('/orders', ordersRouter);
  api.use('/payments', paymentsRouter);
  api.use('/shipments', shipmentsRouter);
  api.use('/webhooks', webhooksRouter);
  api.use('/returns', returnsRouter);
  api.use('/refunds', refundsRouter);
  api.use('/', reviewsRouter);
  api.use('/commissions', commissionsRouter);
  api.use('/settlements', settlementsRouter);
  api.use('/support', supportRouter);
  api.use('/disputes', disputesRouter);
  api.use('/admin', adminRouter);

  app.use(env.API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
