import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { usersController } from './users.controller';
import {
  addressIdParamSchema,
  createAddressSchema,
  updateAddressSchema,
  updateProfileSchema,
} from './users.schema';

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.patch('/me', validateRequest(updateProfileSchema), usersController.updateMe);
usersRouter.get('/me/addresses', usersController.listAddresses);
usersRouter.post('/me/addresses', validateRequest(createAddressSchema), usersController.createAddress);
usersRouter.patch('/me/addresses/:addressId', validateRequest(updateAddressSchema), usersController.updateAddress);
usersRouter.delete(
  '/me/addresses/:addressId',
  validateRequest(addressIdParamSchema),
  usersController.deleteAddress,
);
usersRouter.get('/me/notifications', usersController.listNotifications);
usersRouter.patch(
  '/me/notifications/:notificationId/read',
  validateRequest(z.object({ params: z.object({ notificationId: z.string().uuid() }) })),
  usersController.markNotificationRead,
);
