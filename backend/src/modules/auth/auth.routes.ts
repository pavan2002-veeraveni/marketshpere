import { Router } from 'express';
import { authenticate } from '../../common/middleware/auth';
import { authRateLimiter } from '../../common/middleware/rate-limit';
import { validateRequest } from '../../common/middleware/validate';
import { authController } from './auth.controller';
import {
  loginSchema,
  logoutSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  registerSchema,
} from './auth.schema';

export const authRouter = Router();

authRouter.post('/register', authRateLimiter, validateRequest(registerSchema), authController.register);
authRouter.post('/login', authRateLimiter, validateRequest(loginSchema), authController.login);
authRouter.post('/refresh', validateRequest(refreshSchema), authController.refresh);
authRouter.post('/logout', authenticate, validateRequest(logoutSchema), authController.logout);
authRouter.post(
  '/password-reset/request',
  authRateLimiter,
  validateRequest(passwordResetRequestSchema),
  authController.requestPasswordReset,
);
authRouter.post(
  '/password-reset/confirm',
  authRateLimiter,
  validateRequest(passwordResetConfirmSchema),
  authController.confirmPasswordReset,
);
authRouter.get('/me', authenticate, authController.me);
