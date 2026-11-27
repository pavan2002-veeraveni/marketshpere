# MarketSphere Testing Strategy & Verification (`TESTING.md`)

## 1. Test Pyramid & Suites

| Layer | Tooling | Scope | Location |
|---|---|---|---|
| **Backend API, Security & Concurrency** | Vitest + Supertest + PostgreSQL 18 | Auth, RBAC, Seller Isolation, Customer Privacy, Magic-Byte Upload Validation, Concurrent Last-Unit Reservation, Reservation Expiry, Discount Limits, Order State Machine, Payment/Shipping Webhook Idempotency, Duplicate Refunds, Partial Fulfillment, Dead-Letter Workers, 6 Incident Simulations | `backend/tests/` |
| **Python Calculation & ML Services** | pytest + FastAPI TestClient | Pricing/Promotions Decimal Math, Commission Overrides, Streaming CSV/JSON Normalization, Duplicate SKU Detection, Cold-Start Fallback & Personalized Recommendations, 2,000-row Feed Benchmark | `python-services/tests/` |
| **Frontend Component & Form Validation** | Vitest + React Testing Library | Design system primitives, status badges, pagination, login validation & demo quick-fill | `frontend/src/test/` |
| **End-to-End Browser Flows** | Playwright (Chromium) | Storefront search -> Product detail -> Add to cart -> Checkout -> Sandbox Payment -> Seller Portal -> Admin Console + screenshots | `frontend/e2e/` |

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
