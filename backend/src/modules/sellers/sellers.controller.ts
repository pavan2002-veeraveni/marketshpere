import { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../common/response';
import { sellersService } from './sellers.service';

export const sellersController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const seller = await sellersService.registerSeller(req.user!.userId, req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, seller, 'Seller application created', 201);
    } catch (err) {
      next(err);
    }
  },

  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const seller = await sellersService.getMySeller(req.user!.userId);
      return sendSuccess(req, res, seller, 'Seller profile retrieved');
    } catch (err) {
      next(err);
    }
  },

  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const seller = await sellersService.updateMySeller(req.user!.userId, req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, seller, 'Seller profile updated');
    } catch (err) {
      next(err);
    }
  },

  async uploadDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const record = await sellersService.uploadOnboardingDocument(req.user!.userId, req.file, req.body, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, record, 'Onboarding document uploaded', 201);
    } catch (err) {
      next(err);
    }
  },

  async resubmit(req: Request, res: Response, next: NextFunction) {
    try {
      const seller = await sellersService.resubmitOnboarding(req.user!.userId, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, seller, 'Onboarding resubmitted for review');
    } catch (err) {
      next(err);
    }
  },

  async getAnalytics(req: Request, res: Response, next: NextFunction) {
    try {
      const analytics = await sellersService.getMyAnalytics(req.user!.userId);
      return sendSuccess(req, res, analytics, 'Seller analytics retrieved');
    } catch (err) {
      next(err);
    }
  },

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await sellersService.listSellers(req.query as never);
      return sendSuccess(req, res, result.items, 'Sellers retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await sellersService.updateSellerStatus(
        req.params.sellerId!,
        req.body,
        req.user!.userId,
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, updated, 'Seller status updated');
    } catch (err) {
      next(err);
    }
  },
};
