import { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../common/response';
import { ValidationError } from '../../common/errors';
import { catalogService } from './catalog.service';
import { enqueueTrackedJob, QUEUE_NAMES } from '../../workers/queues';

export const catalogController = {
  async listCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const items = await catalogService.listCategories();
      return sendSuccess(req, res, items, 'Categories retrieved');
    } catch (err) {
      next(err);
    }
  },

  async createCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await catalogService.createCategory(req.body, req.user!.userId, {
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      return sendSuccess(req, res, created, 'Category created', 201);
    } catch (err) {
      next(err);
    }
  },

  async updateCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await catalogService.updateCategory(req.params.categoryId!, req.body, req.user!.userId);
      return sendSuccess(req, res, updated, 'Category updated');
    } catch (err) {
      next(err);
    }
  },

  async deleteCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await catalogService.deleteCategory(req.params.categoryId!, req.user!.userId);
      return sendSuccess(req, res, result, 'Category deleted');
    } catch (err) {
      next(err);
    }
  },

  async listPublicProducts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await catalogService.listPublicProducts(req.query as never);
      return sendSuccess(req, res, result.items, 'Products retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async getProductDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await catalogService.getProductDetail(req.params.slugOrId!);
      return sendSuccess(req, res, product, 'Product retrieved');
    } catch (err) {
      next(err);
    }
  },

  async getRecommendations(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await catalogService.getRecommendationsForProduct(
        req.params.productId,
        req.user?.userId,
        req.requestId,
      );
      return sendSuccess(req, res, data, 'Recommendations retrieved');
    } catch (err) {
      next(err);
    }
  },

  async listSellerProducts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await catalogService.listSellerProducts(req.user!.sellerId!, req.query as never);
      return sendSuccess(req, res, result.items, 'Seller products retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async createSellerProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await catalogService.createSellerProduct(
        req.user!.sellerId!,
        req.user!.userId,
        req.body,
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, created, 'Product created', 201);
    } catch (err) {
      next(err);
    }
  },

  async getSellerProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await catalogService.getSellerProductById(
        req.params.productId!,
        req.user!.sellerId,
        req.user!.roles,
      );
      return sendSuccess(req, res, product, 'Seller product retrieved');
    } catch (err) {
      next(err);
    }
  },

  async updateSellerProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await catalogService.updateSellerProduct(
        req.params.productId!,
        req.user!.sellerId,
        req.user!.roles,
        req.user!.userId,
        req.body,
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, updated, 'Product updated');
    } catch (err) {
      next(err);
    }
  },

  async deleteSellerProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await catalogService.deleteSellerProduct(
        req.params.productId!,
        req.user!.sellerId,
        req.user!.roles,
        req.user!.userId,
      );
      return sendSuccess(req, res, result, 'Product archived');
    } catch (err) {
      next(err);
    }
  },

  async uploadProductImage(req: Request, res: Response, next: NextFunction) {
    try {
      const img = await catalogService.uploadProductImage(
        req.params.productId!,
        req.user!.sellerId,
        req.user!.roles,
        req.file,
      );
      return sendSuccess(req, res, img, 'Product image uploaded', 201);
    } catch (err) {
      next(err);
    }
  },

  async addProductSku(req: Request, res: Response, next: NextFunction) {
    try {
      const sku = await catalogService.addProductSku(
        req.params.productId!,
        req.user!.sellerId,
        req.user!.roles,
        req.user!.userId,
        req.body,
      );
      return sendSuccess(req, res, sku, 'SKU added', 201);
    } catch (err) {
      next(err);
    }
  },

  async importFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const content = req.file ? req.file.buffer.toString('utf8') : req.body.content;
      if (!content) throw new ValidationError('Feed file or content string is required');
      const format = req.file?.originalname.toLowerCase().endsWith('.csv') ? 'csv' : req.body.format ?? 'json';

      if (req.query.async === 'true' || req.body.async === true) {
        const queued = await enqueueTrackedJob({
          queueName: QUEUE_NAMES.FEED_IMPORT,
          jobName: 'feed-import',
          jobId: `feed-${req.user!.sellerId}-${Date.now()}`,
          payload: {
            sellerId: req.user!.sellerId!,
            actorUserId: req.user!.userId,
            format,
            content,
            warehouseId: req.body.warehouseId,
          },
        });
        return sendSuccess(req, res, { queued: true, ...queued }, 'Catalog feed queued for background processing', 202);
      }

      const report = await catalogService.importProductFeed(
        req.user!.sellerId!,
        req.user!.userId,
        format,
        content,
        req.body.warehouseId,
        req.requestId,
      );
      return sendSuccess(req, res, report, 'Catalog feed processed');
    } catch (err) {
      next(err);
    }
  },

  async listAdminProducts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await catalogService.listAdminProducts(req.query as never);
      return sendSuccess(req, res, result.items, 'Admin products retrieved', 200, { ...result.meta });
    } catch (err) {
      next(err);
    }
  },

  async moderateProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const updated = await catalogService.moderateProduct(
        req.params.productId!,
        req.body,
        req.user!.userId,
        { requestId: req.requestId, ipAddress: req.ip },
      );
      return sendSuccess(req, res, updated, 'Product moderated');
    } catch (err) {
      next(err);
    }
  },
};
