import express from 'express';
import { env } from './config/env';
import { logger } from './common/logger';
import { prisma } from './common/prisma';
import { closeRedis } from './common/redis';
import { createApp } from './app';

const app: express.Express = createApp();

if (!process.env.VERCEL) {
  const server = app.listen(env.BACKEND_PORT, () => {
    logger.info(
      { port: env.BACKEND_PORT, apiPrefix: env.API_PREFIX },
      'MarketSphere Express API listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Graceful shutdown initiated');
    server.close(async () => {
      await prisma.$disconnect();
      await closeRedis();
      logger.info('MarketSphere Express API stopped cleanly');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
