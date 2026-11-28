# MarketSphere End-to-End Integration Audit Report

**Audit Scope:** Full-stack architectural, API, security, transactional concurrency, worker, and UI connectivity audit across Next.js (`frontend/`), Express + Prisma (`backend/`), FastAPI (`python-services/`), PostgreSQL 18.7, and Redis/BullMQ integrations.  
**Audit Date:** 2026-11-28

---

## 1. Executive Summary

| # | Integration / Security Area | Verification Status | Findings & Resolution Summary |
|---|---|---|---|
| **1** | **Frontend-to-backend connectivity** | `FIXED & VERIFIED` | Next.js App Router `/api/v1/*` proxy rewrites in [next.config.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/next.config.ts) & Axios token/refresh client ([api-client.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/lib/api-client.ts)) verified live (`GET http://127.0.0.1:3000/api/v1/health` -> `200 OK`, Playwright E2E `1 passed` in `21.6s`). **Fixed (2026-11-28):** Removed unused `_refreshToken` ESLint warning in [api-client.ts](file:///C:/Users/chinn/Downloads/Marketsphere/frontend/src/lib/api-client.ts) and updated [auth.controller.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/auth/auth.controller.ts) / [env.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/config/env.ts) (`COOKIE_SECURE` / `req.secure` / `X-Forwarded-Proto`) so HttpOnly refresh cookies function in local/Docker HTTP production builds as well as HTTPS proxies. |
| **2** | **Backend-to-PostgreSQL connectivity** | `VERIFIED` | `GET /api/v1/health` reports `dependencies.postgres: "up"`, `/api/v1/health/metrics` reports `marketsphere_dependency_up{service="postgres"} 1`, and Prisma verifies `51` schema tables (`50` domain models + `_prisma_migrations`) under concurrent read/write suites. |
| **3** | **Backend-to-Redis connectivity** | `VERIFIED` | Live Memurai Redis (`127.0.0.1:6379`) and BullMQ worker (`dist/worker.js`) verified end-to-end: `GET /api/v1/health` reports `dependencies.redis: "up"`, `/api/v1/health/metrics` reports `marketsphere_dependency_up{service="redis"} 1`, Redis cache read/write/prefix-delete checks succeed, and BullMQ processed live `outbox-dispatch` jobs (`ORDER_CREATED`, `ORDER_PAYMENT_CONFIRMED`) leaving `marketsphere_outbox_events_pending 0`. Graceful fallback paths also remain intact when Redis is offline. |
| **4** | **Express-to-FastAPI communication** | `VERIFIED` | `GET /api/v1/health` reports `dependencies.pythonService: "up"`. Verified live Express -> FastAPI calls for cart pricing/coupon calculation (`pricing.source === "python-fastapi"`), product recommendations (`GET /api/v1/products/recommendations`), and CSV catalog feed normalization + DB persistence (`POST /api/v1/seller/products/feed-import`). |
| **5** | **Authentication and authorization** | `FIXED & VERIFIED` | Enforced JWT access verification (`401`), suspended-account mid-session blocking (`403 ACCOUNT_INACTIVE`), refresh token rotation & family revocation (`401 REFRESH_TOKEN_REUSED`), RBAC guards across customer/seller/warehouse/support/admin (`403`), customer order privacy (`ORDER_PRIVACY_VIOLATION`), and HTTP/HTTPS `ms_refresh_token` cookie flags ([auth_security.test.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/auth_security.test.ts)). |
| **6** | **Inventory reservation transactions** | `FIXED & VERIFIED` | `FOR UPDATE` row locking prevents last-unit overselling (`201` vs `409 INSUFFICIENT_STOCK`). Paid cancellations atomically restock `COMMITTED` inventory and reverse commissions. **Additional fix (2026-11-28):** Consolidated duplicate `(skuId, warehouseId)` lines in [checkout.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/checkout/checkout.routes.ts) and `reserveStockTx` ([inventory.service.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/inventory/inventory.service.ts)) to prevent second-line reservation bypasses when a SKU appears twice in one checkout payload. |
| **7** | **Payment webhook idempotency** | `FIXED & VERIFIED` | Invalid HMAC-SHA256 signatures return `401 INVALID_WEBHOOK_SIGNATURE`. Duplicate `provider + provider_event_id` payment webhooks return `200 { idempotent: true, processed: false }`. **Additional fix (2026-11-28):** Added monotonic `canAdvanceOrderFromShipment` state progression guard in [shipping.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/shipping/shipping.routes.ts) so out-of-order `IN_TRANSIT` callbacks cannot regress a `DELIVERED`, `CANCELLED`, or `REFUNDED` order backward. |
| **8** | **Refund idempotency** | `FIXED & VERIFIED` | **Fixes (2026-11-28) in [returns.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/returns/returns.routes.ts):** Added transactional `tx.refund.findUnique` verification after `payments FOR UPDATE` lock so simultaneous same-`Idempotency-Key` refund calls return HTTP `200` idempotently instead of colliding with `P2002`; preserved existing `order.status` (e.g. `DELIVERED`) on partial goodwill refunds (`PARTIALLY_REFUNDED`) while reversing commissions cleanly on full refunds (`REFUNDED`). |
| **9** | **Seller data isolation** | `FIXED & VERIFIED` | Scoped commission rules ([commissions.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/commissions/commissions.routes.ts)) and multi-seller `getOrderDetail` (`items`, `shipments`, `returns`, `reservations`). **Additional fixes (2026-11-28):** Scoped `shipments` and omitted multi-seller `payments` in `GET /orders` & `getOrderDetail` ([orders.routes.ts](file:///C:/Users/chinn/Downloads/Marketsphere/backend/src/modules/orders/orders.routes.ts)), and rejected mixed-seller `POST /returns` payloads (`400 CROSS_SELLER_RETURN_NOT_ALLOWED`). |
| **10** | **Customer checkout and order tracking** | `VERIFIED` | Full customer discovery -> cart -> coupon -> atomic checkout -> sandbox payment -> warehouse shipment -> HMAC shipping carrier scans (`IN_TRANSIT`, `DELIVERED`) -> `/orders/[orderId]` tracking milestones verified in both API suites (`integration_audit.test.ts`) and live Playwright E2E (`1 passed`, `21.6s`). |

---

## 2. Issues Identified & Fixed During Audit (Including 2026-11-28 Hardening)

1. **Duplicate-Line Checkout Reservation Bypass:** Merged duplicate `(skuId, warehouseId)` quantities before checkout stock validation and inside `reserveStockTx` so duplicate lines cannot self-collide on reservation `idempotencyKey`.
2. **Concurrent Same-Key Refund Race & Partial Refund State Lockout:** Added in-transaction `idempotencyKey` lookup under `payments FOR UPDATE` lock to handle simultaneous replays gracefully (`200`), and kept `DELIVERED` order status intact on partial goodwill refunds (`PARTIALLY_REFUNDED`).
3. **Multi-Seller List Shipments/Payments Leak & Mixed-Seller Returns:** Filtered `shipments` by caller `sellerId` in `GET /api/v1/orders`, omitted cross-seller `payments` on multi-seller seller responses, and disallowed combining items from multiple sellers into a single `ReturnRequest`.
4. **Out-of-Order Shipping Webhook Order Regression:** Guarded shipping webhook & manual shipment updates with monotonic `canAdvanceOrderFromShipment` rules so terminal/delivered orders never regress backward.
5. **Local/Docker HTTP Refresh Cookie Compatibility & Frontend Lint:** Replaced `secure: env.NODE_ENV === 'production'` with `COOKIE_SECURE` / `req.secure` / `X-Forwarded-Proto` detection in `auth.controller.ts`, and eliminated the unused parameter lint warning in `frontend/src/lib/api-client.ts`.

---

## 3. Regression Test Results (Executed After Final Code Edits)

- **Python FastAPI Suite (`ruff check app tests`, `pytest.exe -v`, `python.exe -m tests.benchmark`):**
  - Global & `.venv` `ruff check`: **All checks passed** (`0` warnings/errors)
  - `pytest -v`: **11/11 passed, 0 failed** (`96.0%` thread-aware trace coverage, `1` `DeprecationWarning` from `starlette.testclient`)
  - `tests.benchmark`: **`Feed(2000 rows): 55.56 ms (valid=2000) | Pricing(500x10): 108.88 ms | Recommendations(200x200): 263.50 ms`**
- **Backend Typecheck, Lint, Build & Vitest Integration Suite (`npm --prefix backend test -- --coverage`):**
  - `tsc --noEmit -p tsconfig.json`, `eslint src tests`, `tsc -p tsconfig.json`: **0 errors** (`found 0 vulnerabilities` in prod deps)
  - **6/6 test files passed, 41/41 tests passed (`80.18%` stmts/lines coverage, `60.53%` branch, `84.44%` funcs):**
    - [`tests/integration_audit.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/integration_audit.test.ts): **11/11 passed**
    - [`tests/auth_security.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/auth_security.test.ts): **9/9 passed** (incl. double-submit CSRF verification)
    - [`tests/webhooks_refunds_workers.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/webhooks_refunds_workers.test.ts): **5/5 passed**
    - [`tests/commerce_concurrency.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/commerce_concurrency.test.ts): **3/3 passed**
    - [`tests/incidents.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/incidents.test.ts): **8/8 passed** (incl. GIN `EXPLAIN` & `DEAD_LETTER`/FastAPI fallback drills)
    - [`tests/modules_coverage.test.ts`](file:///C:/Users/chinn/Downloads/Marketsphere/backend/tests/modules_coverage.test.ts): **5/5 passed** (full module CRUD, 100% OpenAPI parity, live Redis Worker)
- **Frontend Checks & Build (`npm --prefix frontend`):**
  - `typecheck` & `lint`: **0 errors, 0 warnings** (`found 0 vulnerabilities` in prod deps)
  - `vitest run`: **2 files, 8/8 tests passed** (`ui.test.tsx` `5/5`, `portals.test.tsx` `3/3`)
  - `next build`: **Next.js `16.4.6` Turbopack built cleanly (`14/14` pages + `/_not-found`)**
- **End-to-End Playwright Browser Test (`npx playwright test --reporter=list`):**
  - Live stack (`Next.js 16 :3000` -> `Express :4000` -> `FastAPI :8000` -> `PostgreSQL :5435` + `Redis :6379` + `BullMQ Worker`): **1/1 passed** (`18.4s` total / `15.1s` test)
- **PostgreSQL Persistence Snapshot (post-regression):**
  - `orders: 212`, `inventory_reservations: 239`, `payments (CAPTURED): 100`, `payments (PARTIALLY_REFUNDED): 1`, `payments (REFUNDED): 42`, `refunds (SUCCEEDED): 43`, `webhook_events (PROCESSED): 199`, `background_job_records: 471` (`COMPLETED: 100`), `outbox_events (DISPATCHED): 397`, `audit_logs: 984`.
