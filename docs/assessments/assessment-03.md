# Assessment 03 — Commerce Database Model

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/prisma/schema.prisma`](../../backend/prisma/schema.prisma)
- [`backend/prisma/migrations/20261127071539_init/migration.sql`](../../backend/prisma/migrations/20261127071539_init/migration.sql)
- [`backend/prisma/seed.ts`](../../backend/prisma/seed.ts)
- [`DATABASE_DESIGN.md`](../../DATABASE_DESIGN.md)

## Objective & Requirements
Design and migrate a normalized PostgreSQL schema serving as the sole system of record across all 43+ required entities (products, SKUs, sellers, warehouses, stock ledger, reservations, carts, orders, line items, discounts, payments, returns, commissions, settlements, disputes, audit logs, idempotency keys, webhook events, background job records) with versioned migrations, constraints, and justified indexes.

## Implementation Details
- Implemented **50 relational tables** (51 including `_prisma_migrations`) mapped cleanly to snake_case PostgreSQL tables.
- Enforced monetary precision using `DECIMAL(14, 2)` for amounts and `DECIMAL(7, 4)` for percentage rates.
- Added explicit SQL `CHECK` constraints in the initial migration (`chk_inventory_reserved_lte_on_hand`, `chk_inventory_on_hand_non_negative`, `chk_skus_price_non_negative`, `chk_refunds_amount_positive`, `chk_reviews_rating_bounds`, etc.) plus `pg_trgm` GIN index `products_title_trgm_idx` on `products.title`.
- Implemented deterministic synthetic seed data in `backend/prisma/seed.ts` covering all 5 roles, 3 sellers, 2 warehouses, 4 categories, 6 products, 8 SKUs, discounts, commission rules, a sample delivered order, review, support case, and dispute.

## Verification & Execution Results
- `npx prisma migrate deploy` applied `20261127071539_init` cleanly against PostgreSQL 18 on `localhost:5435`.
- `npm --prefix backend run prisma:seed` completed with exit code `0`.
- `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'` returned **`51`**.

## Known Limitations
- Local verification executed against an isolated workspace PostgreSQL 18 cluster (`localhost:5435`) rather than the Docker container (`postgres:16-alpine`), because Docker Desktop is not installed on the current Windows host.
