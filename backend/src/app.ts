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

  // OpenAPI / Swagger Docs
  app.get('/api/docs.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

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
