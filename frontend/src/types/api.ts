export type RoleName =
  | 'CUSTOMER'
  | 'SELLER'
  | 'WAREHOUSE_OPERATOR'
  | 'SUPPORT_AGENT'
  | 'ADMIN';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  meta: PaginationMeta & Record<string, unknown>;
  requestId: string;
}

export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  status: string;
  primaryRole: RoleName;
  roles: RoleName[];
  permissions: string[];
  seller?: {
    id: string;
    onboardingStatus: string;
    storeName: string;
    storeSlug: string;
  } | null;
}

export interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  parentId?: string | null;
}

export interface ProductSku {
  id: string;
  skuCode: string;
  price: string;
  compareAtPrice?: string | null;
  availableQty?: number;
  variant?: {
    id: string;
    name: string;
    optionValues: Record<string, string>;
  };
  inventories?: Array<{
    id: string;
    warehouseId: string;
    onHandQty: number;
    reservedQty: number;
    warehouse?: { id: string; code: string; name: string };
  }>;
}

export interface ProductItem {
  id: string;
  sellerId: string;
  categoryId: string;
  title: string;
  slug: string;
  description: string;
  brand?: string | null;
  status: string;
  minPrice?: string;
  availableStock?: number;
  averageRating?: number;
  reviewCount?: number;
  recommendationScore?: number;
  recommendationReason?: string;
  category?: { id: string; name: string; slug: string };
  seller?: { id: string; storeName: string; storeSlug: string };
  images: Array<{ id: string; url: string; altText?: string | null; isPrimary: boolean }>;
  attributes?: Array<{ id: string; name: string; value: string }>;
  skus: ProductSku[];
  reviews?: Array<{
    id: string;
    rating: number;
    title: string;
    comment: string;
    isVerifiedPurchase: boolean;
    createdAt: string;
    user: { firstName: string; lastName: string };
  }>;
}

export interface CartData {
  cartId: string;
  items: Array<{
    id: string;
    skuId: string;
    quantity: number;
    currentUnitPrice: string;
    availableQty: number;
    sku: ProductSku & {
      product: {
        id: string;
        title: string;
        slug: string;
        images: Array<{ url: string }>;
        seller: { id: string; storeName: string };
      };
    };
  }>;
  pricing: {
    currency: string;
    subtotalAmount: string;
    discountAmount: string;
    taxAmount: string;
    shippingAmount: string;
    totalAmount: string;
    source: string;
  };
  stockIssues: Array<{ skuId: string; skuCode: string; requested: number; available: number }>;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  discountCode?: string | null;
  shippingAddressSnapshot: Record<string, string>;
  placedAt: string;
  customer?: { id: string; email: string; firstName: string; lastName: string };
  items: Array<{
    id: string;
    sellerId: string;
    productId: string;
    skuId: string;
    productTitleSnapshot: string;
    skuCodeSnapshot: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
    fulfillmentStatus: string;
  }>;
  payments: Array<{
    id: string;
    status: string;
    amount: string;
    providerPaymentId?: string | null;
    failureMessage?: string | null;
  }>;
  shipments: Array<{
    id: string;
    carrier: string;
    trackingNumber?: string | null;
    status: string;
    failedReason?: string | null;
    events?: Array<{
      id: string;
      status: string;
      location?: string | null;
      description?: string | null;
      occurredAt: string;
    }>;
  }>;
  statusHistory?: Array<{
    id: string;
    fromStatus?: string | null;
    toStatus: string;
    reason?: string | null;
    createdAt: string;
  }>;
}
