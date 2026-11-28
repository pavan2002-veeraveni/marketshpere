# Assessment 02 — Commerce Backend APIs

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/src/app.ts`](../../backend/src/app.ts)
- [`backend/src/modules/`](../../backend/src/modules)
- [`backend/src/docs/openapi.ts`](../../backend/src/docs/openapi.ts)
- [`docs/postman/marketsphere.postman_collection.json`](../postman/marketsphere.postman_collection.json)

## Objective & Requirements
Implement modular `/api/v1/` commerce APIs covering seller onboarding, catalog/variants/SKUs, cart, checkout, explicit order state machine, promotions, returns/refunds, verified reviews, commissions, settlements, support, disputes, and admin endpoints with standardized envelopes and validation.

## Observed Execution Results
- `npm --prefix backend run typecheck`: **0 TypeScript errors**
- `npm --prefix backend run lint`: **0 ESLint errors**
- `npm --prefix backend test -- --coverage`: **6/6 test files passed, 41/41 integration tests passed** against PostgreSQL 18 + Memurai Redis + FastAPI (**v8 coverage: `80.18%` Stmts / `60.53%` Branch / `84.44%` Funcs / `80.18%` Lines**, enforced via `75/75/70/60` thresholds in `backend/vitest.config.ts`).
- Fixed `listPublicProducts` SQL `inStock` filtering (`on_hand_qty - reserved_qty > 0`), `price_asc` / `price_desc` `ORDER BY MIN(s.price)` before `LIMIT`/`OFFSET`, multi-warehouse checkout split allocation & positional pricing lookup, `5000ms` Python health timeout with `degraded` / `?strict=true` `503` semantics, and exact SQL `COUNT(*)`.
- OpenAPI 3.0.3 UI available at `/api/docs` and JSON schema at `/api/docs.json` (**100% parity: `106/106` Express routes, `0` missing**).
