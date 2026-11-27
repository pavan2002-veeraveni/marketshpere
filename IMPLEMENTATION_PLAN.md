# MarketSphere — Implementation Plan (`IMPLEMENTATION_PLAN.md`)

This plan sequences MarketSphere from an empty repository to a tested, documented, containerized multi-vendor marketplace satisfying all 15 mandatory assessments.

---

## Phase 1: Repository Analysis & Architecture (Milestone 1)
- Initialize isolated Git repository inside `Marketsphere/` (`git init -b main`) so parent directory git state is never affected.
- Author foundational architecture and specification documents:
  - [`CODEBASE.md`](./CODEBASE.md)
  - [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)
  - [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md)
  - [`DATABASE_DESIGN.md`](./DATABASE_DESIGN.md)
  - [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md)
  - [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)

## Phase 2: Infrastructure, Monorepo & Database Foundation (Milestone 2)
- Create monorepo root layout (`frontend/`, `backend/`, `python-services/`, `infrastructure/`, `docs/`, `.github/`).
- Create `.gitignore`, `.env.example`, root `README.md`, and `docker-compose.yml` defining `frontend`, `backend`, `python-service`, `postgres`, `redis`, `background-worker`, and `nginx`.
- Author normalized Prisma schema (`backend/prisma/schema.prisma`) implementing all 43+ required entities with explicit foreign keys, check constraints, unique constraints, and performance indexes.
- Create initial SQL migration and deterministic synthetic seed script (`backend/prisma/seed.ts`) covering all 5 user roles, warehouses, categories, multi-seller products, variants/SKUs, inventory & ledger records, discounts, sample orders, reviews, and commission rules.

## Phase 3: Express Backend Foundation & Security Core (Milestone 3)
- Initialize `backend/` TypeScript + Express project (`tsconfig.json`, ESLint, Vitest/Supertest, Prisma client).
- Build core cross-cutting layers:
  - Zod-validated environment configuration (`src/config/env.ts`)
  - Structured Pino logger with PII/secret redaction (`src/common/logger.ts`)
  - `X-Request-ID` / correlation middleware (`src/common/middleware/request-id.ts`)
  - Standard `{ success, message, data, meta, requestId }` and error response builders
  - Centralized safe error handler (Prisma, Zod, JWT, AppError mapping)
  - Security middleware: Helmet, CORS, rate limiters, RBAC + resource ownership guards
  - OpenAPI 3.1 spec + Swagger UI (`/api/docs`)
- Implement **Auth Module** (`auth/`): registration, login, logout, Argon2/bcrypt hashing, JWT access tokens, rotating/revoked refresh tokens, password reset tokens, session revocation, audit trail.

## Phase 4: Core Commerce & Inventory Concurrency Engine (Milestone 4)
Implement modular backend services (`routes / controller / service / repository / schema / types / test`):
- **Users & Addresses (`users/`)**: profile management, shipping addresses, customer notifications.
- **Sellers & Onboarding (`sellers/`)**: registration, business profile, onboarding workflow, safe document upload metadata validation, admin approval/rejection/resubmission/suspension.
- **Catalog (`catalog/`)**: category hierarchy, products, images, attributes, variants, SKUs, status lifecycle, seller isolation, admin moderation, full-text/filtered search + pagination/sorting.
- **Warehouses & Inventory (`inventory/`)**: warehouse management, stock adjustments, stock ledger, **concurrency-safe PostgreSQL row-locked (`SELECT ... FOR UPDATE`) reservations**, expiry & controlled single-release semantics, low-stock alerts.
- **Cart (`cart/`)**: server-side price recalculation, item add/update/remove, availability check, expiry handling.
- **Promotions (`promotions/`)**: coupon creation, percentage/fixed discounts, date bounds, min cart value, max discount cap, global & per-customer usage limits, seller eligibility, stacking rules.
- **Checkout & Orders (`checkout/`, `orders/`)**: transactional orchestration (cart validation -> promotion validation -> Python pricing verification -> shipping calc -> inventory reservation -> order + line items + order status history -> payment intent initiation), explicit **Order State Machine** preventing invalid transitions.

## Phase 5: Financial, Fulfillment & Sandbox Integrations (Milestone 5)
- **Integration Adapters (`src/integrations/`)**:
  - Payment sandbox adapter (HMAC-signed webhooks, simulated confirm/fail/refund)
  - Shipping sandbox adapter (label/tracking generation, tracking updates, signed callbacks)
  - Email sandbox adapter (transactional outbox & preview capture)
  - Object storage sandbox adapter (strict MIME/size/path traversal validation)
  - Python FastAPI HTTP client (service auth header, correlation ID propagation, timeout & retry)
- **Payments & Webhooks (`payments/`, `webhooks/`)**: idempotency keys, signature verification, `webhook_events` deduplication, retry-safe recovery, reconciliation.
- **Shipping (`shipping/`)**: shipment creation, tracking lifecycle, failed shipment handling, partial fulfillment support.
- **Returns & Refunds (`returns/`)**: eligibility rules, customer request + evidence metadata, seller review, admin/support escalation, duplicate-refund prevention, refund reconciliation.
- **Reviews (`reviews/`)**: verified-purchase enforcement, rating aggregation, moderation & visibility toggles.
- **Commissions & Settlements (`commissions/`, `settlements/`)**: `Decimal` arithmetic (`decimal.js`), seller/category commission rules, commission ledger, settlement batch generation, approval, and statements.
- **Support, Disputes & Admin (`support/`, `disputes/`, `admin/`, `audit/`)**: customer/order lookup, support cases & internal notes, dispute lifecycle, audit log query, system settings, marketplace analytics.

## Phase 6: Python FastAPI Microservices (Milestone 6)
- Initialize `python-services/` with FastAPI, Pydantic v2, Uvicorn, `Decimal` math, HTTPX, Ruff/Flake8, and `pytest`.
- Implement bounded services:
  1. **Pricing & Promotion Engine** (`POST /api/v1/pricing/calculate`): deterministic base, promotion stacking/caps, tax, final totals, currency rounding rules.
  2. **Commission Engine** (`POST /api/v1/commissions/calculate`): percentage + fixed commission, seller/category overrides, discount allocation, net seller payout.
  3. **Catalog & Feed Engine** (`POST /api/v1/feeds/normalize`, `POST /api/v1/feeds/process`): streaming CSV/JSON ingestion, field mapping, normalization, SKU validation, duplicate detection, invalid-row error reports.
  4. **Recommendation Engine** (`POST /api/v1/recommendations`, `GET /api/v1/recommendations/{customer_id}`): popular, category-affinity, item-similarity, purchase-history signals, deterministic cold-start fallback, recommendation explanations.
- Author comprehensive `pytest` suite + benchmark script (`python-services/tests/benchmark.py`).

## Phase 7: Next.js App Router Frontend Portals (Milestone 7)
- Initialize `frontend/` (Next.js App Router, TypeScript strict, Tailwind CSS, TanStack Query, Redux Toolkit, React Hook Form + Zod, Axios typed client, Lucide icons).
- Build shared UI design system (`Button`, `Card`, `DataTable`, `Modal`, `ConfirmDialog`, `Toast`, `Badge`, `Skeleton`, `EmptyState`, `Pagination`, `Breadcrumbs`, `AppShell` with responsive Sidebar/TopNav, Error Boundaries).
- Build all 5 authenticated + public portal experiences backed 100% by real API calls:
  1. **Customer Storefront & Account**: home + FastAPI recommendations, search/filter/sort catalog, product detail + variant/SKU selector, cart, checkout + address + coupon + sandbox payment UI, order tracking/history/cancel/returns/reviews, profile.
  2. **Seller Portal**: KPI dashboard, onboarding & verification submission, product/image/variant/SKU CRUD, inventory & stock ledger, CSV/JSON feed upload via backend->Python, order & shipment handoff, returns, commissions, settlements, analytics.
  3. **Warehouse Portal**: fulfillment queue, inventory overview, stock adjustments, damaged/missing recording, reservation monitor, pick/pack/ship handoff, movement ledger.
  4. **Support Portal**: customer & order lookup, support cases, return/refund review, dispute resolution, internal notes, escalation.
  5. **Admin Dashboard**: marketplace overview & charts, revenue/commission analytics, user/seller approval & suspension, category/product moderation, payment/return/dispute oversight, discount & commission rules, settlement approval, audit logs, system config.

## Phase 8: Redis & BullMQ Background Workers (Milestone 8)
- Implement `backend/src/workers/` connected to Redis + BullMQ with exponential backoff, job deduplication (`jobId`), dead-letter tracking (`background_job_records`), graceful shutdown (`SIGTERM`/`SIGINT`), and admin replay endpoints:
  - Reservation expiration sweeper
  - Outbox processor & order/email notifications
  - Low-stock alert scanner
  - Payment reconciliation job
  - Shipping status callback processor
  - Bulk product feed processor
  - Seller settlement batch generator
  - Failed webhook recovery job

## Phase 9: Comprehensive Testing & Incident Simulation Verification (Milestone 9)
- Execute backend unit, API integration, security/IDOR, **PostgreSQL concurrent last-unit checkout test**, **duplicate payment webhook test**, **duplicate refund test**, **reservation expiry test**, and **6 incident simulations** (Assessment 15).
- Execute Python `pytest` suite and performance benchmarks.
- Execute Frontend Vitest + React Testing Library tests and Playwright E2E flows across all roles.
- Fix any defects and record real, unedited command output and coverage reports.

## Phase 10: DevOps, CI/CD & Operational Documentation (Milestone 10)
- Create `.github/workflows/ci-cd.yml` (lint, typecheck, unit/integration tests, Python tests, migration check, dependency/security scan, Docker build/push, staging deploy, manual production approval gate, rollback job).
- Create `.github/PULL_REQUEST_TEMPLATE.md` and `.github/CODEOWNERS`.
- Create `infrastructure/nginx/nginx.conf`, TLS/HTTPS local setup scripts, Postgres backup/restore scripts, Prometheus/health metrics documentation.
- Create `SECURITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `TROUBLESHOOTING.md`, and complete root `README.md`.

## Phase 11: Assessment Evidence & Final Audit (Milestone 11)
- Export OpenAPI JSON/YAML and Postman collection (`docs/postman/marketsphere.postman_collection.json`).
- Capture genuine Playwright UI screenshots and verified test logs.
- Author all 15 assessment evidence files (`docs/assessments/assessment-01.md` through `assessment-15.md`) using strictly observed results and clearly documented host limitations (e.g., if Docker/Redis are unavailable locally).
- Finalize `IMPLEMENTATION_STATUS.md` and verify zero uncommitted secrets, zero placeholders, and clean repository status.
