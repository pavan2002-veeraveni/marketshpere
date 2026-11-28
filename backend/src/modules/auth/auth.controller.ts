import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { ForbiddenError } from '../../common/errors';
import { sendSuccess } from '../../common/response';
import { authService } from './auth.service';

const REFRESH_COOKIE_NAME = 'ms_refresh_token';
const CSRF_COOKIE_NAME = 'ms_csrf_token';

function shouldUseSecureCookie(req: Request): boolean {
  if (env.COOKIE_SECURE) {
    return env.COOKIE_SECURE === 'true';
  }
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function setRefreshCookie(req: Request, res: Response, token: string) {
  const secure = shouldUseSecureCookie(req);
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/v1/auth',
    maxAge,
  });
  res.cookie(CSRF_COOKIE_NAME, crypto.randomBytes(24).toString('hex'), {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge,
  });
}

function assertDoubleSubmitCsrfIfCookieAuth(req: Request): void {
  if (req.body?.refreshToken || !req.cookies?.[REFRESH_COOKIE_NAME]) {
    return;
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.header('x-csrf-token');
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string' || !cookieToken || !headerToken) {
    throw new ForbiddenError('Invalid or missing CSRF token', 'CSRF_TOKEN_INVALID');
  }
  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ForbiddenError('Invalid or missing CSRF token', 'CSRF_TOKEN_INVALID');
  }
}

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      setRefreshCookie(req, res, result.refreshToken);
      return sendSuccess(req, res, result, 'Account registered successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      setRefreshCookie(req, res, result.refreshToken);
      return sendSuccess(req, res, result, 'Logged in successfully');
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      assertDoubleSubmitCsrfIfCookieAuth(req);
      const rawToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
      const result = await authService.refresh(rawToken, {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      setRefreshCookie(req, res, result.refreshToken);
      return sendSuccess(req, res, result, 'Session refreshed');
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      assertDoubleSubmitCsrfIfCookieAuth(req);
      const rawToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
      await authService.logout(req.user!.userId, rawToken, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      res.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecureCookie(req),
        path: '/api/v1/auth',
      });
      res.clearCookie(CSRF_COOKIE_NAME, {
        httpOnly: false,
        sameSite: 'lax',
        secure: shouldUseSecureCookie(req),
        path: '/',
      });
      return sendSuccess(req, res, { loggedOut: true }, 'Logged out successfully');
    } catch (err) {
      next(err);
    }
  },

  async requestPasswordReset(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.requestPasswordReset(req.body.email, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, result, 'If the email exists, password reset instructions were queued');
    } catch (err) {
      next(err);
    }
  },

  async confirmPasswordReset(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.confirmPasswordReset(req.body.token, req.body.newPassword, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, result, 'Password reset successfully');
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await authService.getCurrentUser(req.user!.userId);
      return sendSuccess(req, res, user, 'Current user retrieved');
    } catch (err) {
      next(err);
    }
  },
};
