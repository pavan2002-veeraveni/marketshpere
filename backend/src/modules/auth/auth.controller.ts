import { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { sendSuccess } from '../../common/response';
import { authService } from './auth.service';

const REFRESH_COOKIE_NAME = 'ms_refresh_token';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      setRefreshCookie(res, result.refreshToken);
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
      setRefreshCookie(res, result.refreshToken);
      return sendSuccess(req, res, result, 'Logged in successfully');
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const rawToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
      const result = await authService.refresh(rawToken, {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      setRefreshCookie(res, result.refreshToken);
      return sendSuccess(req, res, result, 'Session refreshed');
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const rawToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
      await authService.logout(req.user!.userId, rawToken, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
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
