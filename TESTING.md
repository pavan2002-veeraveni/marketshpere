# MarketSphere Testing Strategy & Verification (`TESTING.md`)

## 1. Test Pyramid & Suites

| Layer | Tooling | Scope | Location |
|---|---|---|---|
| **Backend API, Security & Concurrency** | Vitest + Supertest + PostgreSQL 18 + Memurai Redis | Auth/CSRF, RBAC, Seller Isolation, Customer Privacy, Magic-Byte Upload Validation, Concurrent & Multi-Warehouse Inventory Reservation, Expiry Sweep, Discount Limits, Order State Machine, Payment/Shipping Webhook Idempotency, Duplicate Refunds, Partial Fulfillment, Live BullMQ Worker & Dead-Letter Recovery, Full Module CRUD (`41` tests, `80.18%` cov, `75/75/70/60` thresholds), 8 Incident Simulations | `backend/tests/` |
| **Python Calculation & ML Services** | pytest + FastAPI TestClient + ruff | Pricing/Promotions Decimal Math, Commission Overrides, Streaming & Multipart CSV/JSON Normalization, Duplicate SKU Detection, Cold-Start & Jaccard Recommendations, Precision@K/NDCG Ranking Evaluation (`11` tests, `96.0%` trace cov), 2,000-row Feed Benchmark | `python-services/tests/` |
| **Frontend Component & Form Validation** | Vitest + React Testing Library | Design system primitives, status badges, pagination, login/forgot-password validation, memory-only auth, `ProtectedRoute` RBAC, Warehouse/Support/Seller/Admin portals & Recharts rendering (`8` tests across `2` files) | `frontend/src/test/` |
| **End-to-End Browser Flows** | Playwright (Chromium) | Storefront search -> Product detail -> Cart -> Checkout -> Sandbox Payment -> Order tracking -> Seller Portal -> Warehouse stock adjustment -> Support internal note -> Admin Console Recharts & job dispatch + silent cookie refresh + `390x844` / `768x1024` viewports | `frontend/e2e/` |

## 2. Running Test Suites Locally

```powershell
# 1. Python FastAPI lint, unit/integration tests & benchmark
Push-Location python-services
.venv\Scripts\ruff.exe check app tests
.venv\Scripts\pytest.exe -v
.venv\Scripts\python.exe -m tests.benchmark
Pop-Location

# 2. Backend TypeScript check, ESLint & Vitest PostgreSQL integration tests
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix backend test

# 3. Frontend TypeScript check, ESLint, Vitest & production build
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build

# 4. Playwright E2E (with backend:4000, python:8000, frontend:3000 running)
npm --prefix frontend run test:e2e
```
