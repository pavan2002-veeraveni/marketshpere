# MarketSphere End-to-End Integration Test & Audit Report

**Repository:** [Marketsphere](file:///C:/Users/chinn/Downloads/Marketsphere)  
**Audit Date:** 2026-11-28  
**Runtime Stack Verified Live:** Next.js (`127.0.0.1:3000`) -> Express (`127.0.0.1:4000`) -> Python FastAPI (`127.0.0.1:8000`) -> PostgreSQL 18.7 (`127.0.0.1:5435`) + Redis Memurai (`127.0.0.1:6379`) + BullMQ Workers

---

## 1. 10-Point Verification Matrix

| # | Audit Area | Status | Findings, Fixes & Live Verification Evidence |
|---|---|---|---|
| **1** | **Frontend-to-backend connectivity** | `FIXED & VERIFIED` | Next.js `/api/v1/*` proxy rewrites in [next.config.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/next.config.ts) & Axios auth/retry client in [api-client.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/lib/api-client.ts) verified live (`GET http://127.0.0.1:3000/api/v1/health` -> `200 OK`, Playwright E2E `1 passed` in `21.6s`). **Fixed:** Removed unused `_refreshToken` ESLint warning in [api-client.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/lib/api-client.ts) (plus [login/page.tsx](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/app/login/page.tsx) & [register/page.tsx](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/app/register/page.tsx)) and updated [auth.controller.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/auth/auth.controller.ts) + [env.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/config/env.ts) (`COOKIE_SECURE` / `req.secure` / `X-Forwarded-Proto`) so HttpOnly `ms_refresh_token` cookies work in local/Docker HTTP production builds as well as HTTPS proxies. |
| **2** | **Backend-to-PostgreSQL connectivity** | `VERIFIED` | Live `/api/v1/health` and `/api/v1/health/metrics` report `dependencies.postgres: "up"` and `marketsphere_dependency_up{service="postgres"} 1`; Prisma checks verified >50 tables and transactional integrity across all 33 backend tests. |
| **3** | **Backend-to-Redis connectivity** | `VERIFIED` | Live Memurai Redis (`127.0.0.1:6379`) & BullMQ worker (`dist/worker.js`) verified live: `/api/v1/health` reports `dependencies.redis: "up"`, `/api/v1/health/metrics` reports `marketsphere_dependency_up{service="redis"} 1`, `pingRedis(true)` and `cacheSetJson`/`cacheGetJson`/`cacheDeletePrefix` succeed cleanly, and BullMQ processed live `outbox-dispatch` jobs (`ORDER_CREATED`, `ORDER_PAYMENT_CONFIRMED` sandbox emails) leaving `marketsphere_outbox_events_pending 0`. |
| **4** | **Express-to-FastAPI communication** | `VERIFIED` | Live `/api/v1/health` reports `dependencies.pythonService: "up"` and Prometheus reports `marketsphere_dependency_up{service="python"} 1`. Verified `POST /api/v1/cart/validate` (`pricing.source === "python-fastapi"`), `GET /api/v1/products/recommendations`, and `POST /api/v1/seller/products/feed-import`. |
| **5** | **Authentication and authorization** | `FIXED & VERIFIED` | Verified JWT access tokens (`401`), mid-session suspended account blocking (`403 ACCOUNT_INACTIVE`), rotating refresh token replay family revocation (`401 REFRESH_TOKEN_REUSED`), RBAC across customer/seller/warehouse/support/admin (`403`), customer order privacy (`ORDER_PRIVACY_VIOLATION`), and added HTTP/HTTPS cookie regression test in [auth_security.test.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/auth_security.test.ts). |
| **6** | **Inventory reservation transactions** | `FIXED & VERIFIED` | **Bug found & fixed:** `POST /api/v1/checkout` with duplicate `(skuId, warehouseId)` request lines created multiple `OrderItem`s while `reserveStockTx` hit its own `idempotencyKey` (`${idempotencyKey}:${skuId}:${warehouseId}`) on the second pass and skipped reserving subsequent units, bypassing stock checks. Consolidated identical `(skuId, warehouseId)` lines in [checkout.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/checkout/checkout.routes.ts) and [inventory.service.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/inventory/inventory.service.ts), verified by `Audit Regression 1`. |
| **7** | **Payment webhook idempotency** | `FIXED & VERIFIED` | HMAC signature enforcement (`401`) and `ON CONFLICT (provider, provider_event_id)` deduplication (`200 { idempotent: true, processed: false }`) verified cleanly. **Also fixed:** Added monotonic `canAdvanceOrderFromShipment` guard in [shipping.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/shipping/shipping.routes.ts) so out-of-order `IN_TRANSIT` carrier webhooks never regress a `DELIVERED`, `CANCELLED`, or `REFUNDED` order backward. |
| **8** | **Refund idempotency** | `FIXED & VERIFIED` | **Two bugs found & fixed in [returns.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/returns/returns.routes.ts):** (a) Same-`Idempotency-Key` check previously ran only outside `$transaction`, causing concurrent duplicate refund requests with an identical key to race past the guard, invoke `issueRefund` twice, and crash with Prisma `P2002`; added transactional `tx.refund.findUnique` after `payments FOR UPDATE` lock. (b) Partial refunds (`PARTIALLY_REFUNDED`) previously forced `order.status = REFUNDED`, locking delivered orders out of legitimate returns; partial goodwill refunds now preserve `order.status` while recording audit/history entries. Verified in `Audit Regression 2`. |
| **9** | **Seller data isolation** | `FIXED & VERIFIED` | **Two leaks fixed:** (a) `GET /api/v1/orders` in [orders.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/orders/orders.routes.ts) previously included unfiltered `shipments: true` & `payments` on multi-seller orders; scoped `shipments` to `caller.sellerId`, omitted `payments` for non-elevated sellers in `listOrders`, and masked cross-seller `payments` on multi-seller `getOrderDetail`. (b) `POST /api/v1/returns` in [returns.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/returns/returns.routes.ts) now rejects cross-seller item mixing (`400 CROSS_SELLER_RETURN_NOT_ALLOWED`). Verified in `Audit Regression 3`. |
| **10** | **Customer checkout and order tracking** | `VERIFIED` | Verified full cart -> coupon -> atomic stock reservation -> sandbox payment capture -> shipment creation -> carrier tracking webhooks (`IN_TRANSIT`, `DELIVERED`) -> `/orders/[orderId]` timeline rendering across API integration tests and live Chromium Playwright E2E (`1 passed`). |

---

## 2. Issues Found & Fixed During This Audit

1. **Duplicate-Line Inventory Reservation Bypass (`backend/src/modules/checkout/checkout.routes.ts`, `backend/src/modules/inventory/inventory.service.ts`):**
   - *Issue:* Submitting duplicate `{ skuId, warehouseId, quantity }` entries in `POST /checkout` bypassed second-line stock reservation because `reserveStockTx` keyed idempotency on `${idempotencyKey}:${skuId}:${warehouseId}` and skipped already-inserted keys inside the same loop.
   - *Fix:* Merged identical `(skuId, warehouseId)` quantities in both checkout normalization and `reserveStockTx` before stock locking (`FOR UPDATE`) and pricing calculation.
2. **Concurrent Same-Key Refund Race & Partial Refund State Lockout (`backend/src/modules/returns/returns.routes.ts`):**
   - *Issue:* Concurrent identical `POST /refunds` requests bypassed the pre-transaction idempotency read and failed with `P2002` `409`; partial refunds also forced `order.status` to `REFUNDED`, preventing post-credit returns on `DELIVERED` orders.
   - *Fix:* Re-checked `idempotencyKey` inside `prisma.$transaction` after `SELECT ... FROM payments FOR UPDATE` (returning HTTP `200` idempotently), and restricted `OrderStatus.REFUNDED` transitions to full or return-linked refunds.
3. **Multi-Seller List Shipment Leak & Cross-Seller Return Assignment (`backend/src/modules/orders/orders.routes.ts`, `backend/src/modules/returns/returns.routes.ts`):**
   - *Issue:* `GET /orders` exposed other sellers' shipments on shared orders, multi-seller `getOrderDetail` leaked order-wide payments, and `POST /returns` attached multi-seller items to the first item's seller.
   - *Fix:* Filtered `shipments` by `sellerId` in `listOrders`, suppressed cross-seller `payments` for non-elevated sellers on multi-seller views, and enforced single-seller items per `ReturnRequest`.
4. **Out-of-Order Shipping Webhook Order Regression (`backend/src/modules/shipping/shipping.routes.ts`):**
   - *Issue:* Late `IN_TRANSIT` carrier events overwrote `DELIVERED`/`CANCELLED`/`REFUNDED` orders backward to `SHIPPED`.
   - *Fix:* Added monotonic `canAdvanceOrderFromShipment` state check across both webhook and manual status endpoints.
5. **Local/Docker HTTP Refresh Cookie Rejection & Frontend Lint Warning (`backend/src/config/env.ts`, `backend/src/modules/auth/auth.controller.ts`, `frontend/src/lib/api-client.ts`):**
   - *Issue:* Hardcoded `secure: env.NODE_ENV === 'production'` broke browser cookie storage over plain HTTP local/Docker stacks (`http://localhost:3000`); `tokenStorage.setTokens` emitted an ESLint unused-var warning.
   - *Fix:* Added `COOKIE_SECURE` override + request HTTPS detection (`req.secure` / `X-Forwarded-Proto`), and cleaned `tokenStorage.setTokens`.

---

## 3. Regression & Live Stack Verification Results

Executed cleanly **after** all final code edits:

- **Python FastAPI (`python-services`):**
  - Global & `.venv` `ruff check app tests` -> **All checks passed!**
  - `.venv\Scripts\pytest.exe -v` -> **`11 passed` (`96.0%` trace coverage, 1 starlette deprecation warning)**
  - `.venv\Scripts\python.exe -m tests.benchmark` -> **`Feed(2000 rows): 55.56 ms (valid=2000) | Pricing(500x10): 108.88 ms | Recommendations(200x200): 263.50 ms`**
- **Express Backend (`backend`):**
  - `npm run typecheck`, `npm run lint`, `npm run build` -> **0 errors** (`found 0 vulnerabilities` in prod deps)
  - `npm test -- --coverage` -> **6/6 test files passed, 41/41 tests passed (`80.18%` stmts/lines coverage):**
    - `tests/auth_security.test.ts`: **9 passed**
    - `tests/integration_audit.test.ts`: **11 passed**
    - `tests/webhooks_refunds_workers.test.ts`: **5 passed**
    - `tests/commerce_concurrency.test.ts`: **3 passed**
    - `tests/incidents.test.ts`: **8 passed**
    - `tests/modules_coverage.test.ts`: **5 passed**
- **Next.js Frontend (`frontend`):**
  - `npm run typecheck`, `npm run lint`, `npm run build` -> **0 errors, 0 warnings**, Next.js `16.4.6` built **`14/14` pages + `/_not-found`** cleanly (`found 0 vulnerabilities` in prod deps)
  - `npm test` -> **2/2 files passed, 8/8 tests passed**
- **Live End-to-End & Dependency Probes:**
  - `http://127.0.0.1:4000/api/v1/health` & `http://127.0.0.1:3000/api/v1/health`: `postgres: "up"`, `redis: "up"`, `pythonService: "up"`
  - `http://127.0.0.1:8000/api/v1/health`: `{"status": "ok", "service": "marketsphere-python"}`
  - `http://127.0.0.1:4000/api/v1/health/metrics`: `marketsphere_dependency_up` = `1` for `postgres`, `redis`, and `python`; `marketsphere_outbox_events_pending` = `0`
  - Playwright E2E (`npx playwright test --reporter=list`): **`1 passed` (`18.4s`)**
- **Post-Test PostgreSQL Verification Snapshot:**
  - `orders: 212`, `inventory_reservations: 239`, `payments (CAPTURED): 100`, `payments (PARTIALLY_REFUNDED): 1`, `payments (REFUNDED): 42`, `refunds (SUCCEEDED): 43`, `webhook_events (PROCESSED): 199`, `background_job_records: 471` (`COMPLETED: 100`), `outbox_events (DISPATCHED): 397`, `audit_logs: 984`.
