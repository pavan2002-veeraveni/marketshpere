import { Router } from 'express';
import { RoleName } from '@prisma/client';
import { authenticate, requireRoles } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { memoryUpload } from '../../common/upload';
import { sellersController } from './sellers.controller';
import {
  listSellersSchema,
  onboardingDocSchema,
  registerSellerSchema,
  updateSellerProfileSchema,
  updateSellerStatusSchema,
} from './sellers.schema';

export const sellersRouter = Router();

sellersRouter.use(authenticate);

sellersRouter.post('/register', validateRequest(registerSellerSchema), sellersController.register);
sellersRouter.get('/me', requireRoles(RoleName.SELLER, RoleName.ADMIN), sellersController.getMe);
sellersRouter.patch(
  '/me',
  requireRoles(RoleName.SELLER, RoleName.ADMIN),
  validateRequest(updateSellerProfileSchema),
  sellersController.updateMe,
);
sellersRouter.post(
  '/me/documents',
  requireRoles(RoleName.SELLER),
  memoryUpload.single('file'),
  validateRequest(onboardingDocSchema),
  sellersController.uploadDocument,
);
sellersRouter.post('/me/resubmit', requireRoles(RoleName.SELLER), sellersController.resubmit);
sellersRouter.get('/me/analytics', requireRoles(RoleName.SELLER, RoleName.ADMIN), sellersController.getAnalytics);

sellersRouter.get('/', requireRoles(RoleName.ADMIN), validateRequest(listSellersSchema), sellersController.list);
sellersRouter.patch(
  '/:sellerId/status',
  requireRoles(RoleName.ADMIN),
  validateRequest(updateSellerStatusSchema),
  sellersController.updateStatus,
);
