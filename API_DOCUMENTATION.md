# MarketSphere — REST API Documentation (`API_DOCUMENTATION.md`)

**Base URL (API Gateway / Express):** `/api/v1`  
**Interactive Docs (Swagger UI):** `/api/docs` (OpenAPI JSON at `/api/docs.json`)  
**Python FastAPI Internal Base URL:** `/api/v1` (Swagger at `/docs`)

---

## 1. Standard Response Envelopes

### Success Response
```json
{
  "success": true,
  "message": "Operation completed",
  "data": {},
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  },
  "requestId": "req_01JXYZ..."
}
```

### Error Response
```json
{
  "success": false,
  "message": "Insufficient stock for SKU MS-HEAD-BLK",
  "code": "INSUFFICIENT_STOCK",
  "details": [
    { "skuId": "...", "requested": 2, "available": 1 }
  ],
  "requestId": "req_01JXYZ..."
}
```

---

## 2. Core Endpoint Directory (Express `/api/v1`)

### Health & Docs
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/health` | Public | Liveness & dependency readiness (PostgreSQL, Redis, Python) |
| GET | `/api/docs` | Public | Swagger / OpenAPI UI |

### Authentication (`/api/v1/auth`)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | Public | Register customer (or requested role restricted safely) |
| POST | `/auth/login` | Public (Rate-limited) | Authenticate & issue JWT access + rotating refresh token |
| POST | `/auth/refresh` | Refresh Token | Rotate refresh token (revokes family on reuse) |
| POST | `/auth/logout` | Bearer | Revoke current refresh token family |
| POST | `/auth/password-reset/request` | Public | Create single-use password reset token |
| POST | `/auth/password-reset/confirm` | Public | Verify token & rotate password |
| GET | `/auth/me` | Bearer | Get authenticated user profile, roles, permissions |

### Customer Profile & Addresses (`/api/v1/users`)
| Method | Path | Auth | Description |
|---|---|---|---|
| PATCH | `/users/me` | Bearer | Update customer profile |
| GET / POST | `/users/me/addresses` | Bearer | List / create shipping addresses |
| PATCH / DELETE | `/users/me/addresses/:addressId` | Bearer (Owner) | Update / remove address |
| GET / PATCH | `/users/me/notifications` | Bearer | List / mark notifications read |

### Seller Onboarding & Store Management (`/api/v1/sellers`)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/sellers/register` | Bearer | Apply for seller account & create profile |
| GET / PATCH | `/sellers/me` | SELLER | View / update own seller profile & onboarding status |
| POST | `/sellers/me/documents` | SELLER | Upload onboarding document metadata/file via safe upload validation |
| POST | `/sellers/me/resubmit` | SELLER | Resubmit rejected onboarding application |
| GET | `/sellers/me/analytics` | SELLER | Seller sales, orders, commission summary |
| GET | `/sellers` | ADMIN | List all sellers with status filters |
| PATCH | `/sellers/:sellerId/status` | ADMIN | Approve, reject, or suspend seller |

### Catalog & Categories (`/api/v1/categories`, `/api/v1/products`)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/categories` | Public | Hierarchical category tree |
| POST / PATCH / DELETE | `/categories` | ADMIN | Manage categories |
| GET | `/products` | Public | Search, filter (`category`, `minPrice`, `maxPrice`, `sellerId`, `inStock`), sort, paginate |
| GET | `/products/:slugOrId` | Public | Product details, variants, SKUs, stock availability, approved reviews |
| GET | `/products/:productId/recommendations` | Public | Product recommendations backed by Python FastAPI |
| POST | `/seller/products` | SELLER (Approved) | Create product, variants, initial SKUs, images |
| GET / PATCH / DELETE | `/seller/products/:productId` | SELLER (Owner) | Manage own products only |
| POST | `/seller/products/feed-import` | SELLER (Approved) | Bulk CSV/JSON catalog feed import via Python feed engine |
| PATCH | `/admin/products/:productId/moderate` | ADMIN | Approve or reject product listing |

### Warehouses & Inventory (`/api/v1/inventory`, `/api/v1/warehouses`)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET / POST | `/warehouses` | WAREHOUSE / ADMIN | List or create warehouses |
| GET | `/inventory` | SELLER (Own) / WAREHOUSE / ADMIN | View stock levels, reserved counts, low-stock flags |
| POST | `/inventory/adjust` | SELLER (Own) / WAREHOUSE / ADMIN | Transactional stock adjustment + ledger record |
| GET | `/inventory/ledger` | SELLER (Own) / WAREHOUSE / ADMIN | Paginated stock movement ledger |
| GET | `/inventory/reservations` | WAREHOUSE / ADMIN | Active & expired stock reservations |
| POST | `/inventory/reservations/release-expired` | ADMIN / Worker | Trigger idempotent expiry release |

### Cart, Promotions & Checkout (`/api/v1/cart`, `/api/v1/discounts`, `/api/v1/checkout`)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/cart` | Bearer | Get cart with server-recalculated prices & stock checks |
| POST | `/cart/items` | Bearer | Add SKU + quantity |
| PATCH / DELETE | `/cart/items/:itemId` | Bearer | Update quantity or remove cart item |
| POST | `/cart/validate` | Bearer | Validate cart & preview coupon pricing via Python engine |
| GET / POST / PATCH | `/discounts` | ADMIN / SELLER (Own) | Manage promotion rules |
| POST | `/checkout` | Bearer (`Idempotency-Key`) | Atomic validation, Python calculation, row-locked reservation, order creation, payment initiation |

### Orders, Payments & Webhooks (`/api/v1/orders`, `/api/v1/payments`, `/api/v1/webhooks`)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/orders` | Bearer (Scoped by Role) | Customer own orders, Seller own order items, Warehouse allocated queue, Support/Admin all |
| GET | `/orders/:orderId` | Bearer (Resource Auth) | Detailed order, items, timeline, shipments, payment, returns |
| POST | `/orders/:orderId/cancel` | CUSTOMER (Owner) / ADMIN | State-machine validated cancellation + reservation release |
| PATCH | `/orders/:orderId/status` | SELLER / WAREHOUSE / ADMIN | Validated state transition |
| POST | `/payments/:paymentId/confirm-sandbox` | CUSTOMER (Owner) | Trigger sandbox payment success/failure flow |
| POST | `/payments/:paymentId/retry` | CUSTOMER (Owner) | Retry failed payment safely |
| GET | `/payments` | ADMIN | Payment monitoring & reconciliation |
| POST | `/webhooks/payments` | HMAC Signature | Idempotent payment & refund webhook processor |
| POST | `/webhooks/shipping` | HMAC Signature | Idempotent carrier tracking callback processor |

### Shipping, Returns, Refunds & Reviews
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/shipments` | SELLER / WAREHOUSE | Create shipment & request sandbox carrier tracking |
| PATCH | `/shipments/:shipmentId/status` | WAREHOUSE / SELLER / ADMIN | Pick, pack, handoff, or fail shipment |
| POST | `/returns` | CUSTOMER (Order Owner) | Request return with reason & evidence metadata |
| PATCH | `/returns/:returnId/decision` | SELLER / SUPPORT / ADMIN | Approve, reject, escalate, or mark received |
| POST | `/refunds` | SUPPORT / ADMIN (`Idempotency-Key`) | Initiate idempotent refund |
| POST | `/products/:productId/reviews` | CUSTOMER (Verified Buyer) | Submit rating + review |
| PATCH | `/reviews/:reviewId/moderate` | ADMIN / SUPPORT | Approve or hide review |

### Commissions, Settlements, Support, Disputes, Audit & Admin
| Method | Path | Auth | Description |
|---|---|---|---|
| GET / POST / PATCH | `/commissions/rules` | ADMIN | Configure global/seller/category commission rules |
| GET | `/commissions/ledger` | SELLER (Own) / ADMIN | View commission breakdown |
| GET | `/settlements` | SELLER (Own) / ADMIN | View seller settlement statements |
| POST | `/settlements/generate` | ADMIN | Generate period settlement batch (`async: true` queues `settlement-batch`) |
| PATCH | `/settlements/:settlementId/approve` | ADMIN | Approve & mark settlement payout |
| GET / POST / PATCH | `/support/cases`, `/support/cases/:id/notes` | CUSTOMER (Own) / SUPPORT / ADMIN | Support tickets & internal notes |
| GET / POST / PATCH | `/disputes` | CUSTOMER / SELLER / SUPPORT / ADMIN | Dispute workflow & resolution |
| GET | `/admin/analytics`, `/admin/audit-logs`, `/admin/jobs`, `/admin/config` | ADMIN | Analytics, audit timeline, BullMQ jobs, webhooks & system settings |
| POST | `/admin/jobs/trigger` | ADMIN | Dispatch or execute tracked maintenance/worker jobs (`outbox-dispatch`, `reservation-expiry-sweep`, etc.) |
| POST | `/admin/jobs/:jobId/replay` | ADMIN | Re-queue or immediately execute (`{ executeNow: true }`) failed/dead-lettered jobs |
| POST | `/auth/password-reset/request` | Public | Request password reset email (`200 { requested: true }`; token delivered via email adapter only) |
| POST | `/auth/password-reset/confirm` | Public | Confirm single-use reset token and revoke prior refresh tokens |
| GET | `/health`, `/health/metrics` | Public | JSON dependency health & Prometheus (`text/plain; version=0.0.4`) metrics |

---

## 3. Python FastAPI Endpoints (`/api/v1`, internal `http://python-service:8000`)

Authenticated via internal header `X-Internal-Service-Token` (plus `X-Request-ID` propagation):

1. `GET /api/v1/health` — FastAPI service health check.
2. `POST /api/v1/pricing/calculate` — Deterministic cart/line-item pricing, promotion rules, tax, rounding (`ROUND_HALF_UP`).
3. `POST /api/v1/commissions/calculate` — Deterministic commission calculation per item & net seller earnings.
4. `POST /api/v1/feeds/process` — Streaming CSV or JSON product feed validation, field mapping, SKU normalization, duplicate detection, invalid row report.
5. `POST /api/v1/feeds/upload` — Multipart CSV/JSON file upload normalization endpoint.
6. `POST /api/v1/recommendations` & `GET /api/v1/recommendations/{customer_id}` — Explainable ranking combining popular products, category affinity, item similarity, and purchase history with deterministic cold-start fallback.

Full OpenAPI 3.0.3 path/parameter/body/envelope schemas are served live at `/api/docs` (`/api/docs.json`) and exported in [`docs/postman/marketsphere.postman_collection.json`](./docs/postman/marketsphere.postman_collection.json).
