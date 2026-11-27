import { Router } from 'express';
import { RoleName } from '@prisma/client';
import {
  authenticate,
  optionalAuthenticate,
  requireApprovedSeller,
  requireRoles,
} from '../../common/middleware/auth';
import { validateRequest } from '../../common/middleware/validate';
import { memoryUpload } from '../../common/upload';
import { catalogController } from './catalog.controller';
import {
  addSkuSchema,
  createCategorySchema,
  createProductSchema,
  feedImportSchema,
  listProductsSchema,
  moderateProductSchema,
  updateCategorySchema,
  updateProductSchema,
} from './catalog.schema';

export const categoriesRouter = Router();
categoriesRouter.get('/', catalogController.listCategories);
categoriesRouter.post(
  '/',
  authenticate,
  requireRoles(RoleName.ADMIN),
  validateRequest(createCategorySchema),
  catalogController.createCategory,
);
categoriesRouter.patch(
  '/:categoryId',
  authenticate,
  requireRoles(RoleName.ADMIN),
  validateRequest(updateCategorySchema),
  catalogController.updateCategory,
);
categoriesRouter.delete(
  '/:categoryId',
  authenticate,
  requireRoles(RoleName.ADMIN),
  catalogController.deleteCategory,
);

export const productsRouter = Router();
productsRouter.get('/', validateRequest(listProductsSchema), catalogController.listPublicProducts);
productsRouter.get('/recommendations', optionalAuthenticate, catalogController.getRecommendations);
productsRouter.get('/:slugOrId', catalogController.getProductDetail);
productsRouter.get('/:productId/recommendations', optionalAuthenticate, catalogController.getRecommendations);

export const sellerCatalogRouter = Router();
sellerCatalogRouter.use(authenticate, requireApprovedSeller);
sellerCatalogRouter.get('/products', validateRequest(listProductsSchema), catalogController.listSellerProducts);
sellerCatalogRouter.post('/products', validateRequest(createProductSchema), catalogController.createSellerProduct);
sellerCatalogRouter.post(
  '/products/feed-import',
  memoryUpload.single('file'),
  validateRequest(feedImportSchema),
  catalogController.importFeed,
);
sellerCatalogRouter.get('/products/:productId', catalogController.getSellerProduct);
sellerCatalogRouter.patch(
  '/products/:productId',
  validateRequest(updateProductSchema),
  catalogController.updateSellerProduct,
);
sellerCatalogRouter.delete('/products/:productId', catalogController.deleteSellerProduct);
sellerCatalogRouter.post(
  '/products/:productId/images',
  memoryUpload.single('file'),
  catalogController.uploadProductImage,
);
sellerCatalogRouter.post('/products/:productId/skus', validateRequest(addSkuSchema), catalogController.addProductSku);

export const adminCatalogRouter = Router();
adminCatalogRouter.use(authenticate, requireRoles(RoleName.ADMIN));
adminCatalogRouter.get('/products', validateRequest(listProductsSchema), catalogController.listAdminProducts);
adminCatalogRouter.patch(
  '/products/:productId/moderate',
  validateRequest(moderateProductSchema),
  catalogController.moderateProduct,
);
