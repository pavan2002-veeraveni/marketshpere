# Assessment 15 — Marketplace Incident Simulation & Root Cause Analysis

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/tests/incidents.test.ts`](../../backend/tests/incidents.test.ts)
- [`backend/src/modules/inventory/inventory.service.ts`](../../backend/src/modules/inventory/inventory.service.ts)
- [`backend/src/modules/returns/returns.routes.ts`](../../backend/src/modules/returns/returns.routes.ts)
- [`backend/src/workers/processors.ts`](../../backend/src/workers/processors.ts)

## Observed Execution Results
All 6 incident simulations executed and passed in `backend/tests/incidents.test.ts` (**6/6 passed**):

---

### Incident 1 — Overselling Under Concurrent Checkout
- **Reproduction:** Two buyers attempt to purchase the last available unit simultaneously, or a buyer attempts to exceed available stock (`APX-HP-SLV` available=4, requested=5); plus direct SQL attempt to set `reserved_qty > on_hand_qty`.
- **Root Cause:** Without pessimistic row locks and DB check constraints, read-then-write checkouts suffer TOCTOU race conditions.
- **Fix & Regression Test:** `reserveStockTx` uses deterministic `SELECT ... FOR UPDATE` + atomic conditional update; PostgreSQL enforces `chk_inventory_reserved_lte_on_hand`. Verified in `commerce_concurrency.test.ts` and `incidents.test.ts` (`409 INSUFFICIENT_STOCK` and SQL `23514` constraint error observed).

### Incident 2 — Stale Stock from Unpaid / Abandoned Reservations
- **Reproduction:** Order created in `PENDING_PAYMENT`, reservation TTL backdated (`expiresAt < now()`), leaving `reserved_qty` blocked.
- **Root Cause:** Unpaid orders hold stock indefinitely if no idempotent expiry sweep runs.
- **Fix & Regression Test:** `inventoryService.releaseExpiredReservations()` atomically claims `WHERE status = 'ACTIVE'` -> `EXPIRED`, decrements `reserved_qty`, writes `RELEASE_EXPIRED` ledger entry, and cancels unpaid orders. Verified via parallel sweep tests (`incidents.test.ts`).

### Incident 3 — Payment / Order State & Commission Mismatch
- **Reproduction:** Order row transitioned to `PAYMENT_CONFIRMED` with `CAPTURED` payment while missing `CommissionLedger` entries.
- **Root Cause:** Crash or partial failure between payment capture and post-payment commission ledger creation.
- **Fix & Regression Test:** `workerProcessors.processPaymentReconciliation()` detects confirmed orders with `commissionLedgers: { none: {} }` and backfills idempotently (`UNIQUE(order_item_id)`). Verified in `incidents.test.ts`.

### Incident 4 — Slow Catalog Search
- **Reproduction:** Substring search across product titles (`?search=Apex&page=1&limit=10`).
- **Root Cause:** Unbounded unindexed scans and unpaginated payloads degrade catalog latency.
- **Fix & Regression Test:** Added `pg_trgm` GIN index `products_title_trgm_idx` in migration `20261127071539_init` + mandatory pagination (`limit <= 100`). Verified search latency `< 200ms` (`190ms` in test).

### Incident 5 — Failed Shipping Callback & Signature Tampering
- **Reproduction:** Unsigned/tampered shipping webhook and unknown tracking number callback sent to `/api/v1/webhooks/shipping`.
- **Root Cause:** Unverified webhooks allow forged delivery status updates; missing tracking numbers must fail safely without corrupting state.
- **Fix & Regression Test:** HMAC-SHA256 `timingSafeEqual` verification rejects tampered payloads (`401`) and unknown tracking updates log `FAILED` in `webhook_events` and return `404`. Verified in `incidents.test.ts` & `webhooks_refunds_workers.test.ts`.

### Incident 6 — Duplicate / Concurrent Refund Over-Payout
- **Reproduction:** Two concurrent `POST /api/v1/refunds` calls with distinct `Idempotency-Key`s each requesting the full order amount simultaneously.
- **Root Cause:** Unsynchronized refund creation checks balance outside a row lock, allowing double payouts.
- **Fix & Regression Test:** `POST /refunds` locks `payments` `FOR UPDATE`, sums existing `PENDING|SUCCEEDED` refunds via `Decimal` math, and rejects excess requests (`409 REFUND_EXCEEDS_PAYMENT`). Verified via `Promise.all` (`[201, 409]`, `refundCount === 1`).
- **Post-Fix Regression Tightening (`6/6` passed in `incidents.test.ts`):** Incident 4 now enforces `expect(elapsedMs).toBeLessThan(200)` (`73ms` measured) and verifies `pg_indexes` contains `products_title_trgm_idx`; Incident 5 asserts `webhook_events.status === 'FAILED'` and `lastError` after moving webhook audit claims outside rolled-back downstream transactions.
