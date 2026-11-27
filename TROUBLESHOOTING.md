# MarketSphere Troubleshooting Guide (`TROUBLESHOOTING.md`)

## 1. Database Connection / Migration Issues
- **Symptom:** `P1001: Can't reach database server` or `Connection refused`.
  - Verify PostgreSQL is running (`pg_isready -h localhost -p 5435` for local dev cluster, or `docker compose ps postgres`).
  - Confirm `DATABASE_URL` in `.env` and `backend/.env` match the active port and credentials.

## 2. Redis / BullMQ Offline Mode
- **Symptom:** `/api/v1/health` shows `dependencies.redis: "down"`.
  - Start Redis (`docker compose up -d redis` or Memurai/Redis on port `6379`).
  - Note: Express core API gracefully degrades and records queued jobs in PostgreSQL `background_job_records` / `outbox_events` rather than dropping transactional work.

## 3. Python FastAPI Unavailable or 401
- **Symptom:** Backend logs `Python pricing service unavailable; using deterministic Decimal fallback`.
  - Ensure `uvicorn app.main:app --port 8000` is running.
  - Ensure `INTERNAL_SERVICE_TOKEN` matches between `backend/.env` and `python-services`.

## 4. Stuck / Expired Stock Reservations
- **Symptom:** `reserved_qty > 0` for expired unpaid orders.
  - Trigger manual sweep via Admin/Warehouse endpoint `POST /api/v1/inventory/reservations/release-expired` or verify `background-worker` is running `reservation-expiry-sweep`.

## 5. Webhook Signature Failures (`401 INVALID_WEBHOOK_SIGNATURE`)
- Verify the caller signed the exact raw JSON body bytes (`HMAC-SHA256`) using `PAYMENT_WEBHOOK_SECRET` or `SHIPPING_WEBHOOK_SECRET` in `X-Marketplace-Signature`.
