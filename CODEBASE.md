# MarketSphere — Initial Codebase Assessment (`CODEBASE.md`)

**Assessment Date:** 2026-11-27  
**Workspace Root:** `c:\Users\chinn\Downloads\Marketsphere`  
**Repository State:** Greenfield / Empty Workspace Scaffold (Section 2 fallback applied)

---

## 1. Existing Repository Structure

Inspection of `c:\Users\chinn\Downloads\Marketsphere` confirms the repository is currently empty except for editor configuration:

```text
Marketsphere/
└── .vscode/
    └── settings.json    # Standard VS Code file exclusion patterns
```

Important filesystem & Git findings:
- There is **no** `.git` directory inside `Marketsphere/`. Running `git rev-parse --show-toplevel` resolves to the parent user directory (`C:/Users/chinn`), which holds an unrelated repository. Therefore, `Marketsphere/` must be initialized with its own isolated Git repository (`git init -b main`) before creating feature branches, hooks, or commits.
- There are **no** existing `frontend/`, `backend/`, `python-services/`, `infrastructure/`, `docs/`, `.github/`, `docker-compose.yml`, `package.json`, `prisma/`, or `.env*` files.

---

## 2. Current Technology Stack & Host Environment Inventory

Because no application code exists yet, the installed runtime environment on the host machine was audited:

| Component | Observed Host Status | Target Requirement | Gap |
|---|---|---|---|
| Node.js | `v24.13.0` installed | Node.js LTS/20+ + Express + Next.js | Ready for scaffolding |
| npm | `v11.6.2` installed | Package management | Ready |
| Python | `Python 3.13.15` (`pip 26.3`) installed | Python 3 + FastAPI + Pydantic + Uvicorn + pytest | Virtualenv & dependencies needed |
| PostgreSQL | PostgreSQL 18 (`127.0.0.1:5432`) & 19 (`0.0.0.0:5433`) running (`scram-sha-256`) | PostgreSQL primary system of record + Prisma ORM | Database `marketsphere` & credentials/connection URL needed |
| Redis | Not installed locally (`redis-server`/`memurai` absent) | Redis for caching, BullMQ queues, reservation expiry | Missing local Redis runtime (Docker/Memurai/WSL needed for live BullMQ execution) |
| Docker / Compose | `docker` CLI not on PATH; `C:\Program Files\Docker` empty; no WSL distro | Containerized 6-service Docker Compose stack | Dockerfiles & `docker-compose.yml` can be authored; live container build/up requires Docker Desktop/Engine |
| Browser / E2E | Playwright Chromium (`chromium-1255`), Chrome, and Edge present | Playwright E2E testing + Assessment 01 screenshots | Ready once frontend/backend are built |

---

## 3. Existing Frontend Status

- **Status:** `NOT_PRESENT` (0% implemented).
- No React, Next.js App Router, Tailwind CSS, TanStack Query, Redux Toolkit, React Hook Form, Zod, or API client code exists.
- All five role-based portals (Customer Storefront, Seller Portal, Warehouse Portal, Support Portal, Admin Dashboard) must be designed and built from scratch.

---

## 4. Existing Backend Status

- **Status:** `NOT_PRESENT` (0% implemented).
- No Express.js application, Prisma schema, REST routes (`/api/v1/*`), middleware, RBAC guards, integration adapters, BullMQ workers, or OpenAPI specification exist.

---

## 5. Existing Database Status

- **Status:** `NOT_PRESENT` in repository (0 tables, 0 migrations, 0 seeds).
- Host machine has PostgreSQL 18 and 19 services running with `scram-sha-256` authentication. No MarketSphere database, schema, or migrations exist yet.

---

## 6. Existing Python Service Status

- **Status:** `NOT_PRESENT` (0% implemented).
- No FastAPI app, Pydantic schemas, pricing/promotion engine, commission engine, CSV/JSON catalog feed normalizer, or recommendation service exists.

---

## 7. Identified Missing Requirements

Every functional, security, operational, and assessment requirement from the Master Specification is currently unimplemented:
1. **43+ relational entities** across auth/RBAC, seller onboarding, catalog/variants/SKUs, multi-warehouse inventory + ledger + concurrency-safe reservations, carts, orders (state machine), discounts, payments + webhook events, shipments, returns/refunds, reviews, commissions/settlements, disputes, support cases, notifications, audit logs, idempotency keys, and outbox/job records.
2. **Modular Express.js backend** (`/api/v1/*`) with strict route/controller/service/repository/validator separation, Pino logging, correlation IDs, OpenAPI/Swagger, and Postman collection.
3. **Python FastAPI service** for deterministic pricing/promotions, commission computation, streaming CSV/JSON catalog feed ingestion & normalization, and explainable recommendations with deterministic empty-history fallback.
4. **Next.js App Router frontend** covering Customer, Seller, Warehouse, Support, and Admin workflows with real API integration and full loading/error/empty/success states.
5. **Redis + BullMQ background processing** with retry/backoff, deduplication, DLQ/failed-job tracking, replay, and outbox coordination.
6. **Sandbox integration adapters** for Payments, Shipping, Email, and Object Storage with HMAC signature verification, timeouts, retries, and event deduplication.
7. **Complete testing matrix** (Backend unit/integration/PostgreSQL concurrency/security tests, Python pytest + benchmarks, Frontend Vitest/RTL + Playwright E2E) and all **15 Assessment Reports** including incident simulations.

---

## 8. Architecture Gaps

- **No monorepo boundary or shared contracts:** Must establish clean separation across `frontend/`, `backend/`, `python-services/`, `infrastructure/`, and `docs/`.
- **No authoritative data ownership boundary yet:** Must enforce PostgreSQL (via Express/Prisma) as sole authoritative store while keeping FastAPI stateless/non-authoritative.
- **No transactional concurrency boundary:** Must implement `SELECT ... FOR UPDATE` + atomic constraint-protected reservations so two buyers can never reserve the last unit.
- **No outbox / async durability boundary:** Must ensure background jobs never serve as the sole state transition mechanism for financial or stock movements.
- **No isolated Git repository:** Must initialize Git in `Marketsphere/` so `C:\Users\chinn`'s parent `.git` does not pollute version control.

---

## 9. Security Gaps

Because no codebase exists yet, every security control must be built in from day one:
- Argon2id / bcrypt password hashing, JWT access tokens + rotating/revocable refresh tokens, login rate limiting.
- Server-side RBAC + resource-level ownership enforcement (preventing IDOR, cross-seller data exposure, and cross-customer order leakage).
- Server-authoritative cart pricing, discount validation, and checkout calculations (never trusting client totals).
- Decimal-exact monetary arithmetic (`Decimal(14, 2)` + `decimal.js` / Python `Decimal`) to eliminate floating-point drift.
- HMAC-SHA256 webhook signature verification (`timingSafeEqual`) + replay/deduplication checks.
- Strict upload validation (extension, MIME sniffing/verification, byte limits, sanitized filenames, non-public storage keys).
- Helmet, strict CORS, Zod validation, safe centralized error serialization (no stack traces or SQL leaks), and audit logging.

---

## 10. Proposed Implementation Plan

Execution proceeds incrementally in 11 dependency-ordered phases (detailed in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)):
- **Phase 1:** Repository isolation (`git init`), monorepo structure, architecture/DB/API/plan documentation.
- **Phase 2:** Infrastructure config, Dockerfiles, `docker-compose.yml`, Nginx config, Prisma schema (43+ models), migrations, synthetic seed data.
- **Phase 3:** Express core foundation, config validation, Pino logger, request correlation IDs, centralized error handler, auth + RBAC + Swagger.
- **Phase 4:** Core commerce APIs (seller onboarding, catalog/SKUs, warehouses, concurrency-safe inventory reservations & ledger, carts, transactional checkout, order state machine, promotions).
- **Phase 5:** Financial & fulfillment modules (sandbox payment/shipping/email/storage adapters, idempotent webhooks, returns, refunds, reviews, Decimal-safe commissions & settlements).
- **Phase 6:** Python FastAPI bounded services (pricing, commissions, streaming CSV/JSON feed processor, explainable recommendations) + pytest + benchmarks.
- **Phase 7:** Next.js App Router frontend with unified design system and all 5 role portals.
- **Phase 8:** Redis + BullMQ workers, outbox publisher, reservation expiry sweep, failed-job replay endpoints.
- **Phase 9:** Full automated test suite (PostgreSQL concurrency test, webhook/refund idempotency tests, security/IDOR tests, frontend RTL + Playwright E2E).
- **Phase 10:** CI/CD GitHub Actions workflows, PR template, `CODEOWNERS`, Nginx/HTTPS/backup/monitoring configs, `SECURITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `TROUBLESHOOTING.md`.
- **Phase 11:** Execute and document all 15 Assessments (`docs/assessments/assessment-01.md` – `assessment-15.md`), incident simulations, Postman collection, and final verification audit.

---

## 11. Important Risks and Dependencies

| Risk / Dependency | Impact | Mitigation |
|---|---|---|
| **Local PostgreSQL Credentials** | Host PostgreSQL 18/19 requires `scram-sha-256` password not yet configured for this workspace. | Support standard `.env` `DATABASE_URL` + Docker Compose PostgreSQL; for local testing without altering host Postgres, verify connectivity or allow user-configured `.env` / isolated local dev DB cluster if authorized. |
| **Redis Unavailable Locally** | BullMQ queues and Redis caching require a real Redis instance (`redis-server` is not installed on Windows host). | Author complete `docker-compose.yml` Redis service; document local Redis / Memurai / Docker requirement transparently; never fake Redis/BullMQ verification if daemon cannot run locally. |
| **Docker CLI Unavailable Locally** | `docker` binary is absent on host PATH, preventing live `docker compose up --build` execution on this machine unless Docker Desktop is installed/started. | Produce validated multi-stage Dockerfiles, healthchecks, and `docker-compose.yml` configs, verify syntax/configs, and explicitly report Docker execution status without fabricating startup logs. |
| **Unrelated Parent `.git` Repo** | Running git commands inside `Marketsphere/` currently traverses to `C:\Users\chinn\.git`. | Run `git init -b main` inside `Marketsphere/` as the very first repository hygiene step. |
| **Scope & Integration Complexity** | 5 portals, 13+ backend modules, 4 Python services, 43+ tables, and 15 assessments risk schema or contract drift. | Lock canonical Prisma schema, shared OpenAPI contracts, and `IMPLEMENTATION_STATUS.md` tracker before writing feature code; test each milestone immediately. |
