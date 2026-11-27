import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../logger';
import { sendError } from '../response';

export function notFoundHandler(req: Request, res: Response): void {
  sendError(req, res, 404, `Route ${req.method} ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ requestId: req.requestId, code: err.code, message: err.message }, 'Operational server error');
    }
    sendError(req, res, err.statusCode, err.message, err.code, err.details);
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((e) => ({ path: e.path.join('.'), message: e.message }));
    sendError(req, res, 400, 'Validation failed', 'VALIDATION_ERROR', details);
    return;
  }

  if (err instanceof multer.MulterError) {
    sendError(req, res, 400, `Upload error: ${err.message}`, 'UPLOAD_ERROR');
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      sendError(req, res, 409, 'A record with this unique identifier already exists', 'DUPLICATE_RESOURCE');
      return;
    }
    if (err.code === 'P2025') {
      sendError(req, res, 404, 'Requested resource was not found', 'NOT_FOUND');
      return;
    }
    if (err.code === 'P2003') {
      sendError(req, res, 400, 'Referenced resource does not exist', 'INVALID_REFERENCE');
      return;
    }
    if (err.code === 'P2004') {
      sendError(req, res, 409, 'Operation violates database integrity constraint', 'CONSTRAINT_VIOLATION');
      return;
    }
  }

  logger.error(
    {
      requestId: req.requestId,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    },
    'Unhandled exception',
  );

  sendError(req, res, 500, 'An unexpected internal error occurred', 'INTERNAL_SERVER_ERROR');
}
