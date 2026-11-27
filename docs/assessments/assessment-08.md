# Assessment 08 — Third-Party Integrations

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/src/integrations/payment-sandbox.ts`](../../backend/src/integrations/payment-sandbox.ts)
- [`backend/src/integrations/shipping-sandbox.ts`](../../backend/src/integrations/shipping-sandbox.ts)
- [`backend/src/integrations/email-sandbox.ts`](../../backend/src/integrations/email-sandbox.ts)
- [`backend/src/common/upload.ts`](../../backend/src/common/upload.ts)
- [`backend/src/integrations/python-client.ts`](../../backend/src/integrations/python-client.ts)

## Objective & Requirements
Integrate sandbox adapters for Payments, Shipping, Email, Object Storage, and Python FastAPI with timeouts, retries, HMAC-SHA256 webhook signature verification (`timingSafeEqual`), and event deduplication.

## Observed Execution Results (`webhooks_refunds_workers.test.ts` — 5/5 PASSED)
- Unsigned payment and shipping webhooks rejected with `401 INVALID_WEBHOOK_SIGNATURE`.
- Duplicate payment webhook (`provider + provider_event_id` unique claim) returned `200 { idempotent: true }` without double-deducting inventory or duplicating commission ledger entries.
- Duplicate and over-limit refunds blocked (`409` / idempotent key replay).
- Failed payment retry, partial multi-seller fulfillment, and signed shipping failure webhook callbacks verified end-to-end.
- Async shipping callback queueing (`POST /api/v1/webhooks/shipping?async=true` -> `202`) + admin tracked replay (`executeNow: true`) + async feed worker execution via Python FastAPI + failed `SANDBOX_SHIP` and `SANDBOX_PAY` webhook recovery (`5/5` in `webhooks_refunds_workers.test.ts`) verified against PostgreSQL.
- Fixed `shipping.routes.ts` & `payments.routes.ts` webhook claim handling so `WebhookEventStatus.FAILED`, `retryCount`, and `lastError` persist outside rolled-back downstream transactions (`6/6` in `incidents.test.ts`).
