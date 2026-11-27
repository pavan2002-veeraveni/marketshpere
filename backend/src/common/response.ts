import { Request, Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function sendSuccess<T>(
  req: Request,
  res: Response,
  data: T,
  message = 'Operation completed',
  statusCode = 200,
  meta: Record<string, unknown> = {},
) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    meta,
    requestId: req.requestId ?? 'unknown',
  });
}

export function sendError(
  req: Request,
  res: Response,
  statusCode: number,
  message: string,
  code: string,
  details: unknown[] = [],
) {
  return res.status(statusCode).json({
    success: false,
    message,
    code,
    details,
    requestId: req.requestId ?? 'unknown',
  });
}

export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
