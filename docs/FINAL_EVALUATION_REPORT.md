# MarketSphere — Strict Independent Technical Evaluation Report (Post-Fix Re-Assessment)

**Evaluator Role:** Strict Technical Evaluator (Zero-Tolerance Policy on Stubs, Mocks & Unverified Claims)  
**Evaluation Date:** 2026-11-27  
**Repository Root:** `c:\Users\chinn\Downloads\Marketsphere`  
**Post-Fix Overall Weighted Score:** **`1,279 / 1,500` (`85.27 / 100` average; up from `1,154 / 1,500` / `76.93` — Pass on Core Commerce, Security, Python, APIs, Docs & Incident RCA; Container/Redis/Cloud Execution Environment-Limited)**

---

## Executive Summary & Scorecard

Points were awarded strictly for verified implementation backed by freshly executed tests, inspected code paths, and directly observed tool outputs after final edits. All runtime claims below reflect verified post-fix runs; unexecuted container, Redis daemon, and remote CI environments retain full honest deductions.

| # | Mandatory Assessment | Score | Verdict | Verified Fixes & Remaining Limiting Factor(s) |
|---|---|---|---|---|
| **01** | Marketplace Storefront & Seller UI | **91 / 100** | Pass | Added `/forgot-password`, `390x844` mobile & Seller feed E2E, `5/5` RTL tests; remaining: shallow portal unit tests & untested E2E mutations for warehouse/support |
| **02** | Commerce Backend APIs | **96 / 100** | Pass | Fixed SQL `inStock`/`ORDER BY MIN(s.price)` sorting before `LIMIT`/`OFFSET`, expanded `openapi.ts` (`74` paths), `29/29` tests (`60.85%` coverage); remaining: paid cancel requires separate `/refunds` step |
| **03** | Commerce Database Model | **93 / 100** | Pass | Verified `50` tables + `_prisma_migrations` (`51`), `CHECK` constraints, idempotent stock/cart `seed.ts`, and `products_title_trgm_idx` index assertion; remaining: host PG 18 vs Docker PG 16, no `EXPLAIN ANALYZE` |
| **04** | Marketplace Security | **93 / 100** | Pass | Added `HybridRedisRateLimitStore`, eliminated `sandboxResetToken` HTTP leak (`7/7` security tests), removed `localStorage` refresh tokens (`HttpOnly` cookie + `sessionStorage` access token); remaining: `npm audit` reports unresolved high CVEs (`zod <4.6.6`, `prisma`, `next`/`postcss`), live Redis rate limiter unexecuted |
| **05** | Python Pricing & Feed Engine | **97 / 100** | Pass | Added `POST /api/v1/feeds/upload` multipart CSV pytest (`11/11` passed in `1.14s`, `ruff` clean, `48.20 ms` / `62.72 ms` benchmark); remaining: Express computes checkout commissions locally instead of calling FastAPI |
| **06** | FastAPI Recommendation Service | **85 / 100** | Pass | Verified `POST` & `GET` endpoints and `200x200` `118.82 ms` benchmark; remaining: static heuristic weights, zero Precision@K/NDCG eval, standalone `GET` uses `SYNTHETIC_CATALOG` |
| **07** | Inventory Reservation Engine | **94 / 100** | Pass | Verified `FOR UPDATE`, SQL `CHECK` `23514`, parallel sweep `3/3` concurrency tests; remaining: live Redis BullMQ repeatable sweep unexecuted on host, single-warehouse line allocation |
| **08** | Third-Party Integrations | **87 / 100** | Pass | Fixed `shipping.routes.ts` & `payments.routes.ts` `FAILED` webhook DB persistence outside rolled-back transactions + added `SANDBOX_SHIP` recovery test (`5/5`); remaining: in-process sandbox stubs, live Redis worker retry unverified |
| **09** | Docker Marketplace Environment | **60 / 100** | Conditional | Created `frontend/public/.gitkeep` resolving `frontend/Dockerfile:20` missing directory; remaining: zero live Docker builds, `docker compose up`, or `nginx -t` execution on Windows host lacking Docker CLI/WSL |
| **10** | Git Collaboration & Reviews | **65 / 100** | Conditional | Clean local Git commit history initialized on `main` (`.gitignore` excludes `.env`, `.local/`, certs/keys); remaining: single-developer local repo with no feature branches, PRs, reviews, or remote origin |
| **11** | Marketplace CI/CD | **63 / 100** | Conditional | Added `e2e-ci` Playwright job (`8` validated jobs), removed `\|\| true` audit mask, added gated live `/health` & `/health/metrics` smoke probes; remaining: zero remote Actions runs, deploy stubs without `*_BASE_URL`, `npm audit` currently fails red until CVEs remediated |
| **12** | Commerce Test Suite | **92 / 100** | Pass | Executed fresh `--coverage` (`29/29` backend `60.85%` Stmts/Lines), `11/11` Python, `5/5` RTL, `1/1` Playwright (`9.2s`); remaining: no Redis broker worker run, no Vitest coverage threshold gate, light portal RTL coverage |
| **13** | Marketplace API Documentation | **96 / 100** | Pass | Expanded `openapi.ts` to **`74` paths** with schemas/parameters, Postman to **`32` requests / `6` folders**, and `API_DOCUMENTATION.md` with FastAPI contracts; remaining: no automated `newman` collection execution |
| **14** | Marketplace Deployment | **70 / 100** | Conditional | Fixed & re-verified `backup-restore-verify.ps1` cleanly against PG 18 (`51` restored tables, exit `0`), compiled full stack; remaining: no container/Nginx proxy run, no `server.key` without `openssl`, no staging URL or live Prometheus scrape |
| **15** | Incident Simulation & RCA | **97 / 100** | Pass | Tightened Incident 4 to `< 200ms` (`73ms` measured) + `products_title_trgm_idx` DB index check, tightened Incident 5 to assert `webhook_events.status === 'FAILED'` (`6/6` passed); remaining: manual SQL check in Incident 1, no `EXPLAIN ANALYZE` plan output |

---

## Detailed Post-Fix Assessment Findings & Verified Evidence

### Assessment 01 — Marketplace Storefront and Seller UI (**91 / 100**)
- **Verified Evidence:**
  - `npm --prefix frontend run build` (`next build`) cleanly built **`15/15` App Router pages** (`/`, `/_not-found`, `/login`, `/register`, `/forgot-password`, `/products/[slug]`, `/cart`, `/checkout`, `/orders`, `/orders/[orderId]`, `/account`, `/seller`, `/warehouse`, `/support`, `/admin`).
  - `npm --prefix frontend run typecheck` (`0` errors), `lint` (`0` errors, `1` benign unused-parameter warning in `src/lib/api-client.ts:22`), and `npm --prefix frontend test` (**`5/5` RTL tests** passed in `193ms` / `4.50s` run, including forgot-password flow).
  - `npm --prefix frontend run test:e2e` (**`1/1` Playwright Chromium test passed in `7.5s` / `9.2s` suite**) across compiled backend (`:4000`), Next.js (`:3000`), FastAPI (`:8000`), and PostgreSQL 18 (`:5435`), verifying storefront discovery, search (`Apex Studio`), customer purchase flow, order lifecycle timeline, Seller `Products & Feed Import` (`Bulk CSV Feed Import`), Warehouse, Support, Admin Console (`Run Outbox Dispatch`), `/forgot-password`, and `390x844` mobile responsive viewport (zero horizontal overflow).
- **Remaining Deductions:**
  - `-4`: E2E verifies portal views and Seller/Admin tabs cleanly, without executing browser mutations for Warehouse shipping/adjustments, Support dispute resolution, or Customer return/review forms.
  - `-4`: RTL suite (`5` tests) does not directly unit-test `checkout`, `seller`, `warehouse`, `support`, or `admin` component trees.
  - `-1`: No tablet viewport sweep or `axe-core` automated accessibility scan executed.

---

### Assessment 02 — Commerce Backend APIs (**96 / 100**)
- **Verified Evidence:**
  - `npm --prefix backend run typecheck`, `lint`, `build` all exited `0`.
  - `npm --prefix backend test -- --coverage` passed **`5/5` files, `29/29` integration tests in `20.69s`** (`incidents.test.ts` `6/6`, `auth_security.test.ts` `7/7`, `integration_audit.test.ts` `8/8`, `webhooks_refunds_workers.test.ts` `5/5`, `commerce_concurrency.test.ts` `3/3`), v8 coverage **`60.85%` Stmts / `62.08%` Branch / `57.6%` Funcs / `60.85%` Lines**.
  - `backend/src/modules/catalog/catalog.service.ts` (`listPublicProducts`) now executes SQL `WHERE` `inStock` (`on_hand_qty - reserved_qty > 0`), `GROUP BY` + SQL `ORDER BY MIN(s.price) ASC|DESC` before `LIMIT`/`OFFSET`, and exact SQL `COUNT(*)`.
  - `backend/src/docs/openapi.ts` documents **`74` OpenAPI 3.0.3 paths**.
- **Remaining Deductions:**
  - `-2`: Cancelling a `PAYMENT_CONFIRMED` order restocks inventory and reverses commissions, while refund initiation remains an explicit support `POST /refunds` call.
  - `-2`: Backend coverage is `60.85%` lines/statements without an enforced threshold gate (non-HTTP entrypoints `server.ts`/`worker.ts` & unexercised settlement/support controller branches pull down overall %).

---

### Assessment 03 — Commerce Database Model (**93 / 100**)
- **Verified Evidence:**
  - `50` domain tables (`51` with `_prisma_migrations`), SQL `CHECK` constraints (`23514` verified live), `pg_trgm` `products_title_trgm_idx` verified in `pg_indexes`, and idempotent `backend/prisma/seed.ts` stock replenishment + demo cart reset verified (`npm --prefix backend run prisma:seed`).
- **Remaining Deductions:**
  - `-3`: Verified on local Windows PostgreSQL 18 (`127.0.0.1:5435`), not Docker `postgres:16-alpine`.
  - `-2`: No `EXPLAIN ANALYZE` query plan proof recorded.
  - `-2`: Single baseline migration with no down-migration test.

---

### Assessment 04 — Marketplace Security (**93 / 100**)
- **Verified Evidence:**
  - `HybridRedisRateLimitStore` in `backend/src/common/middleware/rate-limit.ts` uses atomic Redis `INCR` + `PEXPIRE` when connected and a clean `Map` fallback offline.
  - `backend/src/modules/auth/auth.service.ts` (`requestPasswordReset`) no longer exposes `sandboxResetToken` in HTTP responses, verified in `auth_security.test.ts` (`7/7`).
  - Frontend auth (`frontend/src/lib/api-client.ts`, `AppShell.tsx`, `login/page.tsx`) dropped `localStorage` token storage; `/auth/refresh` and `/auth/logout` rely on `HttpOnly` `ms_refresh_token` cookies while short-lived `accessToken` is kept in `sessionStorage` + memory.
- **Remaining Deductions:**
  - `-3`: **Local Dependency Vulnerabilities Found:** `npm --prefix backend audit --omit=dev --audit-level=high` exited `1` with **5 high-severity advisories** (`zod <4.6.6` GHSA-mrhx-c7xc-m3w5, `deepmerge-ts` & `effect` via `prisma`/`@prisma/config`), and `npm --prefix frontend audit --omit=dev --audit-level=high` exited `1` with **3 advisories (1 moderate, 2 high)** (`zod <4.6.6`, `postcss <=8.5.22` via `next`), requiring breaking major-version upgrades (`zod@4.6.7`, `next@16.4.6`).
  - `-2`: `HttpOnly` refresh/logout cookie routes rely on `SameSite=Lax` + CORS origin controls rather than an explicit CSRF double-submit token.
  - `-1`: Short-lived `accessToken` still persists across page reloads via `sessionStorage` rather than memory + silent `/auth/refresh` bootstrap alone.
  - `-1`: Redis branch of `HybridRedisRateLimitStore` could not execute against a live Redis broker on this Windows host.

---

### Assessment 05 — Python Pricing and Feed Engine (**97 / 100**)
- **Verified Evidence:**
  - `ruff check` (`All checks passed!`), `pytest -v` (**`11/11` passed in `1.14s`**, including `test_feed_upload_multipart_csv` testing `POST /api/v1/feeds/upload`), and live benchmark (**Feed `2,000` rows: `48.20 ms` | Pricing `500x10`: `62.72 ms`**).
- **Remaining Deductions:**
  - `-3`: Express still computes checkout commissions locally in `commissions.routes.ts` instead of delegating to FastAPI `POST /api/v1/commissions/calculate`.

---

### Assessment 06 — FastAPI Recommendation Service (**85 / 100**)
- **Verified Evidence:**
  - Cold-start fallback, hybrid similarity scoring, and explanations tested via `pytest` (`11/11` suite), live Express -> FastAPI test (`integration_audit.test.ts`), and `200x200` benchmark (`118.82 ms`).
- **Remaining Deductions:**
  - `-7`: Static heuristic linear formula rather than trained CF/embedding model.
  - `-5`: No offline ranking quality metrics (Precision@K / Recall@K / NDCG).
  - `-3`: Standalone `GET /api/v1/recommendations/{customer_id}` reads `SYNTHETIC_CATALOG`.

---

### Assessment 07 — Inventory Reservation Engine (**94 / 100**)
- **Verified Evidence:**
  - Deterministic lock ordering, `SELECT ... FOR UPDATE`, atomic `WHERE (on_hand_qty - reserved_qty) >= qty`, SQL `CHECK` `23514`, parallel expiry sweep (`releasedCount === 1`), and paid cancellation restock verified (`3/3` concurrency, `8/8` integration audit).
- **Remaining Deductions:**
  - `-4`: Live Redis BullMQ repeatable expiry sweep execution unverified on host.
  - `-2`: Single-warehouse allocation per order line item.

---

### Assessment 08 — Third-Party Integrations (**87 / 100**)
- **Verified Evidence:**
  - HMAC-SHA256 `timingSafeEqual`, atomic `webhook_events` deduplication, idempotent `FOR UPDATE` refunds (`409 REFUND_EXCEEDS_PAYMENT`), partial fulfillment, async shipping callback queueing (`?async=true` -> `202`), admin replay (`executeNow: true`), and both `SANDBOX_PAY` & `SANDBOX_SHIP` failed webhook recovery verified (`5/5` in `webhooks_refunds_workers.test.ts`).
  - Fixed `payments.routes.ts` and `shipping.routes.ts` so `webhook_events` claims persist `FAILED`, `retryCount`, and `lastError` outside rolled-back downstream transactions (`6/6` in `incidents.test.ts`).
- **Remaining Deductions:**
  - `-10`: In-process sandbox stubs (`emailSandboxAdapter` volatile 100-entry buffer; no external Stripe/Shippo/Mailpit calls).
  - `-3`: Live BullMQ Redis retry/backoff/DLQ worker transitions unverified against a Redis daemon.

---

### Assessment 09 — Docker Marketplace Environment (**60 / 100**)
- **Verified Evidence:**
  - Authored 7-service `docker-compose.yml`, non-root multi-stage Dockerfiles (`backend/`, `python-services/`, `frontend/`), `init.sql`, and Nginx configs; created `frontend/public/.gitkeep` so `frontend/Dockerfile:20` (`COPY --from=builder /app/public ./public`) targets a valid folder.
- **Remaining Deductions:**
  - `-30`: Neither `docker` CLI nor WSL is available on this Windows host; no container image was built and `docker compose up --build` never ran.
  - `-5`: `frontend/Dockerfile` multi-stage build fix has not yet been compiled via `docker build`.
  - `-5`: Nginx configs (`nginx.conf` / `nginx.tls.conf`) were never validated with `nginx -t` in a container.

---

### Assessment 10 — Git Collaboration and Reviews (**65 / 100**)
- **Verified Evidence:**
  - Clean local Git commit history initialized on `main`, with `.gitignore` cleanly excluding `.env`, `.local/`, `node_modules/`, `.venv/`, `dist/`, `.next/`, `coverage/`, `playwright-report/`, `test-results/`, and private TLS keys/certs, alongside [CODEOWNERS](file:///C:/Users/chinn/Downloads/Marketsphere/.github/CODEOWNERS) and [PULL_REQUEST_TEMPLATE.md](file:///C:/Users/chinn/Downloads/Marketsphere/.github/PULL_REQUEST_TEMPLATE.md).
- **Remaining Deductions:**
  - `-20`: Single-developer direct commits on `main` with no feature-branch / pull-request review history.
  - `-15`: No remote GitHub repository or branch protection rules configured locally (no push performed).

---

### Assessment 11 — Marketplace CI/CD (**63 / 100**)
- **Verified Evidence:**
  - `.github/workflows/ci-cd.yml` passes `yaml.safe_load` cleanly with **`8` jobs** (`backend-ci`, `python-ci`, `frontend-ci`, `e2e-ci`, `docker-build`, `deploy-staging`, `deploy-production`, `rollback-production`), strict `npm --prefix backend audit --omit=dev --audit-level=high` (no `|| true`), and HTTP `/api/v1/health` + `/api/v1/health/metrics` smoke checks gated cleanly on `vars.*_BASE_URL`.
- **Remaining Deductions:**
  - `-20`: Zero remote GitHub Actions workflow runs executed.
  - `-15`: Deployment/rollback jobs rely on live environment smoke gates and skip remote rollout when `REGISTRY_TOKEN` / `*_BASE_URL` are unset (no cloud provider provisioning scripts included).
  - `-2`: Strict `npm audit` gate in `backend-ci` will fail red until `zod`/transitive advisories are resolved.

---

### Assessment 12 — Commerce Test Suite (**92 / 100**)
- **Verified Evidence:**
  - Executed cleanly after final fixes:
    - Backend (`npm --prefix backend test -- --coverage`): **`5/5` files, `29/29` passed in `20.69s`**; v8 coverage **`60.85%` Stmts / `62.08%` Branch / `57.6%` Funcs / `60.85%` Lines**.
    - Python (`pytest -v` & `ruff`): **`11/11` passed (`1.14s`)**, `ruff` clean, benchmark verified (`48.20ms` / `62.72ms` / `118.82ms`).
    - Frontend (`vitest` & `playwright`): **`5/5` RTL tests passed (`193ms` / `4.50s` run)**, **`1/1` Playwright E2E full-stack + mobile viewport walkthrough passed (`7.5s` / `9.2s`)**.
- **Remaining Deductions:**
  - `-4`: Live Redis BullMQ worker execution (`backend/src/worker.ts`) remains untested due to host Redis absence.
  - `-3`: Frontend Vitest suite (`5` tests) does not unit-test full portal pages.
  - `-1`: No enforced `--coverage.thresholds` fail-gate in Vitest config.

---

### Assessment 13 — Marketplace API Documentation (**96 / 100**)
- **Verified Evidence:**
  - Expanded `backend/src/docs/openapi.ts` (`OpenAPI 3.0.3`, `/api/docs` & `/api/docs.json`) to **`74` documented paths** with request/response/parameter schemas; expanded Postman collection (`docs/postman/marketsphere.postman_collection.json`) to **`32` requests across `6` folders**; updated `API_DOCUMENTATION.md` with FastAPI contracts.
- **Remaining Deductions:**
  - `-2`: Some endpoint schemas rely on shared generic envelopes rather than field-by-field custom response components for every endpoint.
  - `-2`: No automated `newman` CLI execution log against the Postman collection.

---

### Assessment 14 — Marketplace Deployment (**70 / 100**)
- **Verified Evidence:**
  - Compiled full-stack runtime verified (`PostgreSQL 18 :5435`, `uvicorn :8000`, `node backend/dist/server.js :4000`, `next start :3000`), `GET /api/v1/health/metrics` Prometheus endpoint returning `200 OK`, local TLS script `generate-local-tls.ps1` verified, and fixed `infrastructure/scripts/backup-restore-verify.ps1` verified live against PostgreSQL 18 (exit `0`, **`Verified restored table count: 51`** into `marketsphere_restore_verify`).
- **Remaining Deductions:**
  - `-15`: Multi-container Docker Compose + Nginx reverse proxy routing (`:80` / `:443`) unexecuted.
  - `-10`: No staging/production hosting URL or CA-trusted TLS termination tested (`server.pfx` created without `server.key` on Windows lacking `openssl.exe`).
  - `-5`: `generate-local-tls.sh` and live Prometheus server scrape (`prometheus.yml`) unexecuted.

---

### Assessment 15 — Marketplace Incident Simulation & Root Cause Analysis (**97 / 100**)
- **Verified Evidence:**
  - `backend/tests/incidents.test.ts` passes **`6/6`** scenarios: Incident 1 overselling concurrency + SQL `23514`, Incident 2 stale reservation expiry, Incident 3 commission backfill, Incident 4 search latency (`expect(elapsedMs).toBeLessThan(200)` — **`73ms` measured** + `pg_indexes` `products_title_trgm_idx` verified), Incident 5 tampered carrier HMAC `401` + unknown tracking `404` **plus `webhook_events.status === 'FAILED'` DB verification**, and Incident 6 concurrent refund guard (`[201, 409]`).
- **Remaining Deductions:**
  - `-2`: Incident 1 triggers SQL `23514` via direct SQL update alongside `Promise.all` checkout contention.
  - `-1`: Incident 4 verifies `pg_trgm` index existence rather than `EXPLAIN ANALYZE` across a high-volume synthetic catalog.
