# Assessment 07 — Inventory Reservation Engine

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/src/modules/inventory/inventory.service.ts`](../../backend/src/modules/inventory/inventory.service.ts)
- [`backend/tests/commerce_concurrency.test.ts`](../../backend/tests/commerce_concurrency.test.ts)

## Objective & Requirements
Ensure two concurrent customers can never reserve the same last unit of inventory, reservations expire cleanly and release exactly once, cancelled orders release reserved stock, confirmed payments commit stock, and all movements write immutable `inventory_ledger` records.

## Implementation Details
- `reserveStockTx` sorts line items deterministically by `(skuId, warehouseId)` and locks rows via PostgreSQL `SELECT ... FROM inventory ... FOR UPDATE`, followed by conditional atomic `UPDATE ... WHERE (on_hand_qty - reserved_qty) >= qty`.
- PostgreSQL `CHECK (reserved_qty <= on_hand_qty)` enforces stock integrity at the engine level.
- `releaseExpiredReservations` uses atomic `UPDATE inventory_reservations SET status = 'EXPIRED', released_at = NOW() WHERE id = $1::uuid AND status = 'ACTIVE' RETURNING ...` so parallel sweeps cannot double-release stock.

## Observed Execution Results (`commerce_concurrency.test.ts` — 3/3 PASSED)
- **Simultaneous last-unit checkout (`Promise.all`)**: `statuses = [201, 409]`, loser received `INSUFFICIENT_STOCK`, `onHandQty=1`, `reservedQty=1`; cancellation returned `reservedQty=0`.
- **Parallel expired reservation sweeps**: `sweep1.releasedCount + sweep2.releasedCount === 1`, `reservedQty=0`, order cancelled.
- **Discount usage limit & order state machine**: Passed.
