type OpenApiOp = {
  tags: string[];
  summary: string;
  auth?: 'bearer' | 'webhook';
  pathParams?: string[];
  queryParams?: Array<{ name: string; type: string }>;
  bodyProps?: Record<string, { type: string; example?: unknown }>;
  requiredBody?: string[];
  successStatus?: '200' | '201' | '202';
};

function op(def: OpenApiOp) {
  const parameters = [
    ...(def.pathParams ?? []).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...(def.queryParams ?? []).map((q) => ({
      name: q.name,
      in: 'query',
      required: false,
      schema: { type: q.type },
    })),
  ];

  const entry: Record<string, unknown> = {
    tags: def.tags,
    summary: def.summary,
    responses: {
      [def.successStatus ?? '200']: {
        description: def.summary,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } },
      },
      '400': {
        description: 'Validation / Bad Request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden / RBAC or Ownership Violation' },
    },
  };

  if (def.auth === 'bearer') entry.security = [{ bearerAuth: [] }];
  if (def.auth === 'webhook') entry.security = [{ webhookSignature: [] }];
  if (parameters.length > 0) entry.parameters = parameters;
  if (def.bodyProps) {
    entry.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: def.bodyProps,
            ...(def.requiredBody ? { required: def.requiredBody } : {}),
          },
        },
      },
    };
  }
  return entry;
}

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'MarketSphere Commerce API',
    version: '1.0.0',
    description:
      'Enterprise Multi-Vendor Commerce, Concurrency-Safe Inventory, Order Lifecycle, Payment Webhook, Settlement & Background Job API.',
  },
  servers: [{ url: '/api/v1', description: 'API v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Marketplace-Signature' },
    },
    schemas: {
      SuccessEnvelope: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: { type: 'object' },
          meta: { type: 'object' },
          requestId: { type: 'string' },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string' },
          code: { type: 'string' },
          details: { type: 'array', items: { type: 'object' } },
          requestId: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/health': { get: op({ tags: ['System'], summary: 'Dependency readiness check (PostgreSQL, Redis, Python FastAPI)' }) },
    '/health/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus OpenMetrics exposition endpoint',
        responses: { '200': { description: 'Prometheus text metrics', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
    '/auth/register': {
      post: op({
        tags: ['Auth'],
        summary: 'Register customer or seller account',
        successStatus: '201',
        requiredBody: ['email', 'password', 'firstName', 'lastName'],
        bodyProps: {
          email: { type: 'string', example: 'buyer@marketsphere.test' },
          password: { type: 'string', example: 'SecurePass#2026' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          accountType: { type: 'string', example: 'CUSTOMER' },
          storeName: { type: 'string' },
        },
      }),
    },
    '/auth/login': {
      post: op({
        tags: ['Auth'],
        summary: 'Authenticate and obtain JWT access token + HttpOnly refresh cookie',
        requiredBody: ['email', 'password'],
        bodyProps: { email: { type: 'string' }, password: { type: 'string' } },
      }),
    },
    '/auth/refresh': {
      post: op({
        tags: ['Auth'],
        summary: 'Rotate refresh token (supports HttpOnly cookie or request body)',
        bodyProps: { refreshToken: { type: 'string' } },
      }),
    },
    '/auth/logout': {
      post: op({
        tags: ['Auth'],
        auth: 'bearer',
        summary: 'Revoke refresh token family and clear cookie',
        bodyProps: { refreshToken: { type: 'string' } },
      }),
    },
    '/auth/me': { get: op({ tags: ['Auth'], auth: 'bearer', summary: 'Get authenticated profile & role permissions' }) },
    '/auth/password-reset/request': {
      post: op({
        tags: ['Auth'],
        summary: 'Queue password reset email without exposing token in response',
        requiredBody: ['email'],
        bodyProps: { email: { type: 'string' } },
      }),
    },
    '/auth/password-reset/confirm': {
      post: op({
        tags: ['Auth'],
        summary: 'Confirm password reset token and revoke existing refresh sessions',
        requiredBody: ['token', 'newPassword'],
        bodyProps: { token: { type: 'string' }, newPassword: { type: 'string' } },
      }),
    },
    '/users/me': {
      patch: op({
        tags: ['Users'],
        auth: 'bearer',
        summary: 'Update user profile',
        bodyProps: { firstName: { type: 'string' }, lastName: { type: 'string' }, phone: { type: 'string' } },
      }),
    },
    '/users/me/addresses': {
      get: op({ tags: ['Users'], auth: 'bearer', summary: 'List own shipping addresses' }),
      post: op({
        tags: ['Users'],
        auth: 'bearer',
        summary: 'Create shipping address',
        successStatus: '201',
        requiredBody: ['recipientName', 'line1', 'city', 'state', 'postalCode', 'phone'],
        bodyProps: {
          label: { type: 'string' },
          recipientName: { type: 'string' },
          line1: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          postalCode: { type: 'string' },
          country: { type: 'string' },
          phone: { type: 'string' },
        },
      }),
    },
    '/users/me/notifications': { get: op({ tags: ['Users'], auth: 'bearer', summary: 'List account notifications' }) },
    '/categories': {
      get: op({ tags: ['Catalog'], summary: 'List active categories' }),
      post: op({
        tags: ['Catalog'],
        auth: 'bearer',
        summary: 'Admin create category',
        successStatus: '201',
        requiredBody: ['name'],
        bodyProps: { name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' } },
      }),
    },
    '/products': {
      get: op({
        tags: ['Catalog'],
        summary: 'SQL-sorted, filtered, paginated active catalog search',
        queryParams: [
          { name: 'page', type: 'integer' },
          { name: 'limit', type: 'integer' },
          { name: 'search', type: 'string' },
          { name: 'categorySlug', type: 'string' },
          { name: 'minPrice', type: 'number' },
          { name: 'maxPrice', type: 'number' },
          { name: 'inStock', type: 'string' },
          { name: 'sortBy', type: 'string' },
        ],
      }),
    },
    '/products/{slugOrId}': {
      get: op({ tags: ['Catalog'], summary: 'Get product detail, SKUs, warehouse availability & approved reviews', pathParams: ['slugOrId'] }),
    },
    '/products/{productId}/recommendations': {
      get: op({ tags: ['Catalog'], summary: 'Explainable recommendations backed by FastAPI', pathParams: ['productId'] }),
    },
    '/sellers/register': {
      post: op({
        tags: ['Sellers'],
        auth: 'bearer',
        summary: 'Register seller store & business profile',
        successStatus: '201',
        requiredBody: ['storeName', 'legalBusinessName', 'taxIdMasked', 'supportEmail', 'supportPhone'],
        bodyProps: {
          storeName: { type: 'string' },
          legalBusinessName: { type: 'string' },
          taxIdMasked: { type: 'string' },
          supportEmail: { type: 'string' },
          supportPhone: { type: 'string' },
        },
      }),
    },
    '/sellers/me': { get: op({ tags: ['Sellers'], auth: 'bearer', summary: 'Get own seller profile & onboarding state' }) },
    '/sellers/me/analytics': { get: op({ tags: ['Sellers'], auth: 'bearer', summary: 'Seller GMV, net earnings & top products' }) },
    '/sellers': { get: op({ tags: ['Sellers'], auth: 'bearer', summary: 'Admin list all sellers' }) },
    '/sellers/{sellerId}/status': {
      patch: op({
        tags: ['Sellers'],
        auth: 'bearer',
        summary: 'Admin approve, reject, or suspend seller',
        pathParams: ['sellerId'],
        requiredBody: ['status'],
        bodyProps: { status: { type: 'string' }, reason: { type: 'string' } },
      }),
    },
    '/seller/products': {
      get: op({ tags: ['Seller Catalog'], auth: 'bearer', summary: 'List own seller products' }),
      post: op({
        tags: ['Seller Catalog'],
        auth: 'bearer',
        summary: 'Create product with variants & initial warehouse inventory',
        successStatus: '201',
        bodyProps: { title: { type: 'string' }, categoryId: { type: 'string' }, description: { type: 'string' } },
      }),
    },
    '/seller/products/{productId}': {
      get: op({ tags: ['Seller Catalog'], auth: 'bearer', summary: 'Get own seller product (isolated)', pathParams: ['productId'] }),
      patch: op({ tags: ['Seller Catalog'], auth: 'bearer', summary: 'Update own seller product', pathParams: ['productId'], bodyProps: { title: { type: 'string' }, status: { type: 'string' } } }),
      delete: op({ tags: ['Seller Catalog'], auth: 'bearer', summary: 'Archive own seller product', pathParams: ['productId'] }),
    },
    '/seller/products/feed-import': {
      post: op({
        tags: ['Seller Catalog'],
        auth: 'bearer',
        summary: 'Bulk CSV/JSON catalog import via FastAPI (supports async: true worker queue)',
        bodyProps: { format: { type: 'string', example: 'csv' }, content: { type: 'string' }, async: { type: 'boolean' } },
      }),
    },
    '/admin/products': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'List products for moderation' }) },
    '/admin/products/{productId}/moderate': {
      patch: op({
        tags: ['Admin'],
        auth: 'bearer',
        summary: 'Approve, reject, or archive product listing',
        pathParams: ['productId'],
        requiredBody: ['status'],
        bodyProps: { status: { type: 'string' }, moderationNotes: { type: 'string' } },
      }),
    },
    '/warehouses': {
      get: op({ tags: ['Inventory'], auth: 'bearer', summary: 'List active warehouses' }),
      post: op({ tags: ['Inventory'], auth: 'bearer', summary: 'Create warehouse', successStatus: '201', bodyProps: { code: { type: 'string' }, name: { type: 'string' } } }),
    },
    '/inventory': { get: op({ tags: ['Inventory'], auth: 'bearer', summary: 'View stock levels & low-stock alerts (seller-scoped)' }) },
    '/inventory/adjust': {
      post: op({
        tags: ['Inventory'],
        auth: 'bearer',
        summary: 'Atomic stock adjustment & immutable inventory_ledger entry',
        requiredBody: ['skuId', 'warehouseId', 'movementType', 'quantityDelta'],
        bodyProps: { skuId: { type: 'string' }, warehouseId: { type: 'string' }, movementType: { type: 'string' }, quantityDelta: { type: 'integer' } },
      }),
    },
    '/inventory/ledger': { get: op({ tags: ['Inventory'], auth: 'bearer', summary: 'Paginated stock ledger history' }) },
    '/inventory/reservations': { get: op({ tags: ['Inventory'], auth: 'bearer', summary: 'Monitor active & expired reservations' }) },
    '/inventory/reservations/release-expired': { post: op({ tags: ['Inventory'], auth: 'bearer', summary: 'Idempotently release expired stock reservations' }) },
    '/discounts': {
      get: op({ tags: ['Promotions'], auth: 'bearer', summary: 'List discounts & coupon rules' }),
      post: op({
        tags: ['Promotions'],
        auth: 'bearer',
        summary: 'Create promotion code',
        successStatus: '201',
        bodyProps: { code: { type: 'string' }, discountType: { type: 'string' }, value: { type: 'string' } },
      }),
    },
    '/cart': { get: op({ tags: ['Cart'], auth: 'bearer', summary: 'Get server-priced cart', queryParams: [{ name: 'discountCode', type: 'string' }] }) },
    '/cart/items': {
      post: op({
        tags: ['Cart'],
        auth: 'bearer',
        summary: 'Add SKU item to cart',
        successStatus: '201',
        requiredBody: ['skuId', 'quantity'],
        bodyProps: { skuId: { type: 'string' }, quantity: { type: 'integer' } },
      }),
    },
    '/cart/items/{itemId}': {
      patch: op({ tags: ['Cart'], auth: 'bearer', summary: 'Update cart item quantity', pathParams: ['itemId'], bodyProps: { quantity: { type: 'integer' } } }),
      delete: op({ tags: ['Cart'], auth: 'bearer', summary: 'Remove cart item', pathParams: ['itemId'] }),
    },
    '/cart/validate': {
      post: op({
        tags: ['Cart'],
        auth: 'bearer',
        summary: 'Validate cart stock & calculate coupon totals via Python FastAPI',
        bodyProps: { discountCode: { type: 'string' } },
      }),
    },
    '/checkout': {
      post: op({
        tags: ['Checkout'],
        auth: 'bearer',
        summary: 'Transactional row-locked stock reservation, FastAPI pricing, order creation & payment intent',
        successStatus: '201',
        bodyProps: { addressId: { type: 'string' }, discountCode: { type: 'string' }, idempotencyKey: { type: 'string' } },
      }),
    },
    '/orders': { get: op({ tags: ['Orders'], auth: 'bearer', summary: 'List role-scoped orders' }) },
    '/orders/{orderId}': { get: op({ tags: ['Orders'], auth: 'bearer', summary: 'Order detail, tracking milestones & timelines (privacy-scoped)', pathParams: ['orderId'] }) },
    '/orders/{orderId}/cancel': {
      post: op({
        tags: ['Orders'],
        auth: 'bearer',
        summary: 'Cancel order, release/restock inventory & reverse commissions',
        pathParams: ['orderId'],
        bodyProps: { reason: { type: 'string' } },
      }),
    },
    '/orders/{orderId}/status': {
      patch: op({
        tags: ['Orders'],
        auth: 'bearer',
        summary: 'State-machine validated order transition',
        pathParams: ['orderId'],
        requiredBody: ['toStatus'],
        bodyProps: { toStatus: { type: 'string' }, reason: { type: 'string' } },
      }),
    },
    '/payments': { get: op({ tags: ['Payments'], auth: 'bearer', summary: 'Admin/Support payment monitoring' }) },
    '/payments/{paymentId}/confirm-sandbox': {
      post: op({
        tags: ['Payments'],
        auth: 'bearer',
        summary: 'Simulate sandbox payment capture or failure',
        pathParams: ['paymentId'],
        bodyProps: { outcome: { type: 'string', example: 'SUCCEED' }, failureMessage: { type: 'string' } },
      }),
    },
    '/payments/{paymentId}/retry': { post: op({ tags: ['Payments'], auth: 'bearer', summary: 'Retry failed payment intent', pathParams: ['paymentId'] }) },
    '/webhooks/payments': {
      post: op({
        tags: ['Webhooks'],
        auth: 'webhook',
        summary: 'Idempotent HMAC-SHA256 payment/refund webhook handler',
        requiredBody: ['eventId', 'eventType', 'providerPaymentId'],
        bodyProps: { eventId: { type: 'string' }, eventType: { type: 'string' }, providerPaymentId: { type: 'string' }, amount: { type: 'string' } },
      }),
    },
    '/webhooks/shipping': {
      post: op({
        tags: ['Webhooks'],
        auth: 'webhook',
        summary: 'Idempotent HMAC-SHA256 carrier webhook handler (supports ?async=true)',
        queryParams: [{ name: 'async', type: 'string' }],
        requiredBody: ['eventId', 'trackingNumber', 'status'],
        bodyProps: { eventId: { type: 'string' }, trackingNumber: { type: 'string' }, status: { type: 'string' }, location: { type: 'string' } },
      }),
    },
    '/shipments': {
      get: op({ tags: ['Shipping'], auth: 'bearer', summary: 'List seller/warehouse shipments' }),
      post: op({
        tags: ['Shipping'],
        auth: 'bearer',
        summary: 'Create shipment & generate sandbox tracking number',
        successStatus: '201',
        requiredBody: ['orderId'],
        bodyProps: { orderId: { type: 'string' }, carrier: { type: 'string' }, serviceLevel: { type: 'string' } },
      }),
    },
    '/shipments/{shipmentId}/status': {
      patch: op({
        tags: ['Shipping'],
        auth: 'bearer',
        summary: 'Update shipment tracking status & timeline',
        pathParams: ['shipmentId'],
        requiredBody: ['status'],
        bodyProps: { status: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } },
      }),
    },
    '/returns': {
      get: op({ tags: ['Returns'], auth: 'bearer', summary: 'List role-scoped return requests' }),
      post: op({
        tags: ['Returns'],
        auth: 'bearer',
        summary: 'Submit return request for delivered order',
        successStatus: '201',
        requiredBody: ['orderId', 'reason', 'items'],
        bodyProps: { orderId: { type: 'string' }, reason: { type: 'string' }, description: { type: 'string' } },
      }),
    },
    '/returns/{returnId}/decision': {
      patch: op({
        tags: ['Returns'],
        auth: 'bearer',
        summary: 'Seller/Support/Admin review & restock decision on return',
        pathParams: ['returnId'],
        requiredBody: ['status'],
        bodyProps: { status: { type: 'string' }, resolutionNotes: { type: 'string' }, restockInventory: { type: 'boolean' } },
      }),
    },
    '/refunds': {
      get: op({ tags: ['Refunds'], auth: 'bearer', summary: 'List refunds' }),
      post: op({
        tags: ['Refunds'],
        auth: 'bearer',
        summary: 'Issue FOR UPDATE idempotent refund',
        successStatus: '201',
        requiredBody: ['orderId', 'amount', 'reason'],
        bodyProps: { orderId: { type: 'string' }, returnId: { type: 'string' }, amount: { type: 'string' }, reason: { type: 'string' } },
      }),
    },
    '/products/{productId}/reviews': {
      post: op({
        tags: ['Reviews'],
        auth: 'bearer',
        summary: 'Submit verified-purchase product review',
        pathParams: ['productId'],
        successStatus: '201',
        requiredBody: ['orderId', 'rating', 'title', 'comment'],
        bodyProps: { orderId: { type: 'string' }, rating: { type: 'integer' }, title: { type: 'string' }, comment: { type: 'string' } },
      }),
    },
    '/commissions/rules': {
      get: op({ tags: ['Commissions'], auth: 'bearer', summary: 'List commission rules (seller-isolated for non-admin sellers)' }),
      post: op({ tags: ['Commissions'], auth: 'bearer', summary: 'Admin create commission rule', successStatus: '201', bodyProps: { name: { type: 'string' }, percentageRate: { type: 'string' } } }),
    },
    '/commissions/ledger': { get: op({ tags: ['Commissions'], auth: 'bearer', summary: 'View Decimal-exact commission ledger' }) },
    '/settlements': { get: op({ tags: ['Settlements'], auth: 'bearer', summary: 'View seller settlement statements' }) },
    '/settlements/generate': {
      post: op({
        tags: ['Settlements'],
        auth: 'bearer',
        summary: 'Generate pending seller settlement batch (supports async: true queue)',
        successStatus: '201',
        bodyProps: { sellerId: { type: 'string' }, async: { type: 'boolean' } },
      }),
    },
    '/settlements/{settlementId}/approve': { patch: op({ tags: ['Settlements'], auth: 'bearer', summary: 'Approve and mark settlement paid', pathParams: ['settlementId'] }) },
    '/support/customers': { get: op({ tags: ['Support'], auth: 'bearer', summary: 'Search customer accounts (Support/Admin)' }) },
    '/support/cases': {
      get: op({ tags: ['Support'], auth: 'bearer', summary: 'List support tickets' }),
      post: op({ tags: ['Support'], auth: 'bearer', summary: 'Open support case', successStatus: '201', bodyProps: { subject: { type: 'string' }, initialMessage: { type: 'string' } } }),
    },
    '/support/cases/{caseId}/notes': {
      post: op({ tags: ['Support'], auth: 'bearer', summary: 'Add public or internal agent note to support case', pathParams: ['caseId'], successStatus: '201', bodyProps: { body: { type: 'string' }, isInternal: { type: 'boolean' } } }),
    },
    '/disputes': {
      get: op({ tags: ['Support'], auth: 'bearer', summary: 'List order disputes (scoped by role)' }),
      post: op({ tags: ['Support'], auth: 'bearer', summary: 'Open dispute on order', successStatus: '201', bodyProps: { orderId: { type: 'string' }, reason: { type: 'string' } } }),
    },
    '/disputes/{disputeId}': {
      patch: op({ tags: ['Support'], auth: 'bearer', summary: 'Resolve or update dispute status', pathParams: ['disputeId'], requiredBody: ['status'], bodyProps: { status: { type: 'string' }, resolutionSummary: { type: 'string' } } }),
    },
    '/admin/analytics': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'Marketplace GMV, commission & alert KPIs' }) },
    '/admin/users': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'List platform users' }) },
    '/admin/users/{userId}/status': { patch: op({ tags: ['Admin'], auth: 'bearer', summary: 'Suspend or reactivate user account', pathParams: ['userId'], requiredBody: ['status'], bodyProps: { status: { type: 'string' } } }) },
    '/admin/audit-logs': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'Query immutable audit log timeline' }) },
    '/admin/webhooks': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'Inspect payment & shipping webhook delivery records' }) },
    '/admin/jobs': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'List background_job_records' }) },
    '/admin/jobs/trigger': {
      post: op({
        tags: ['Admin'],
        auth: 'bearer',
        summary: 'Trigger maintenance/worker job with optional synchronous execution',
        successStatus: '201',
        requiredBody: ['jobName'],
        bodyProps: { jobName: { type: 'string', example: 'outbox-dispatch' }, executeNow: { type: 'boolean' } },
      }),
    },
    '/admin/jobs/{jobId}/replay': {
      post: op({
        tags: ['Admin'],
        auth: 'bearer',
        summary: 'Re-queue or replay-execute failed/dead-letter job',
        pathParams: ['jobId'],
        bodyProps: { executeNow: { type: 'boolean' } },
      }),
    },
    '/admin/config': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'List system configuration settings' }) },
    '/admin/config/{key}': { put: op({ tags: ['Admin'], auth: 'bearer', summary: 'Upsert system configuration entry', pathParams: ['key'], bodyProps: { value: { type: 'object' }, description: { type: 'string' } } }) },
    '/admin/sandbox-emails': { get: op({ tags: ['Admin'], auth: 'bearer', summary: 'Inspect recent sandbox notification emails' }) },
  },
};
