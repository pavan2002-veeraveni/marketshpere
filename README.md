# MarketSphere — Enterprise Multi-Vendor Commerce, Inventory & Order Management Platform

MarketSphere is an enterprise-grade modular monorepo marketplace featuring a **Next.js App Router** frontend across 5 role portals, an **Express.js + Prisma + PostgreSQL** core commerce engine with concurrency-safe inventory locking and idempotent webhooks, a **Python FastAPI** service for deterministic pricing, commission math, bulk catalog feeds, and explainable recommendations, and **Redis + BullMQ** background workers.

---

## Architecture Overview

```text
marketsphere/
├── frontend/                  # Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, RTK, TanStack Query, Recharts
├── backend/                   # Express.js, TypeScript, Prisma ORM, PostgreSQL, Redis/BullMQ, Pino, Swagger
│   ├── prisma/                # 50-table normalized schema, SQL migrations + CHECK constraints, seed
│   └── tests/                 # Auth/CSRF/RBAC, concurrency, webhooks, refunds, workers, full modules & 8 incidents
├── python-services/           # FastAPI, Pydantic v2, Decimal arithmetic, Uvicorn, pytest, ruff
├── infrastructure/            # Nginx reverse proxy & TLS config, Postgres init SQL, backup scripts
├── docs/
│   ├── assessments/           # Mandatory Assessment 01–15 reports & genuine Playwright screenshots
│   └── postman/               # Complete Postman v2.1 API collection
├── .github/                   # GitHub Actions CI/CD pipeline, PR template, CODEOWNERS
└── docker-compose.yml         # Full 7-container topology (postgres, redis, python, backend, worker, frontend, nginx)
```

---

## Quick Start (Local Development)

### 1. Prerequisites
- Node.js 22+ / npm
- Python 3.13+
- PostgreSQL 16/18+
- Redis 7+ (required for live BullMQ worker execution; API degrades safely when Redis is offline)

### 2. Environment Setup
```bash
cp .env.example .env
cp .env backend/.env
```

### 3. Database Migration & Seed
```bash
npm --prefix backend install
npx --prefix backend prisma migrate deploy --schema=backend/prisma/schema.prisma
npx --prefix backend prisma generate --schema=backend/prisma/schema.prisma
npm --prefix backend run prisma:seed
```

### 4. Start Services
- **Python FastAPI (`:8000`)**: `python-services\.venv\Scripts\uvicorn.exe app.main:app --app-dir python-services --port 8000`
- **Express Core API (`:4000`)**: `npm --prefix backend run dev`
- **BullMQ Worker**: `npm --prefix backend run dev:worker`
- **Next.js Frontend (`:3000`)**: `npm --prefix frontend run dev`
- **Swagger / OpenAPI**: `http://localhost:4000/api/docs`

### 5. Docker Compose Startup
```bash
docker compose up --build
```

---

## Synthetic Demo Accounts (Password: `MarketSphere#2026`)
| Role | Email | Portal Route |
|---|---|---|
| Customer | `customer@marketsphere.test` | `/` (`/orders`, `/cart`, `/account`) |
| Seller (Approved) | `seller1@marketsphere.test` | `/seller` |
| Warehouse Operator | `warehouse@marketsphere.test` | `/warehouse` |
| Support Agent | `support@marketsphere.test` | `/support` |
| Marketplace Admin | `admin@marketsphere.test` | `/admin` |

---

## Documentation Index
- [`CODEBASE.md`](./CODEBASE.md) — Initial codebase & host environment assessment
- [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md) — Architecture, sequence, state machine & deployment Mermaid diagrams
- [`DATABASE_DESIGN.md`](./DATABASE_DESIGN.md) — ER diagram, 50-table catalog, constraints & index strategy
- [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) — REST & FastAPI endpoint contracts + [Postman Collection](./docs/postman/marketsphere.postman_collection.json)
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) & [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) — Milestone plan & live status tracker
- [`SECURITY.md`](./SECURITY.md), [`TESTING.md`](./TESTING.md), [`DEPLOYMENT.md`](./DEPLOYMENT.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`docs/assessments/`](./docs/assessments) — Evidence & completion reports for Assessments 01–15
