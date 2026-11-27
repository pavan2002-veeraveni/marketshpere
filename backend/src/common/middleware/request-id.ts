import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{8,120}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && SAFE_ID_RE.test(incoming) ? incoming : `req_${uuidv4()}`;
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}
