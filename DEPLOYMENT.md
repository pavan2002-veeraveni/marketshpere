# MarketSphere Deployment & Operations Guide (`DEPLOYMENT.md`)

## 1. Architecture Topology
MarketSphere runs as a multi-service stack behind Nginx:
- **Nginx (`infrastructure/nginx/nginx.conf` & `nginx.tls.conf`)**: Reverse proxy (`/api/*` and `/uploads/*` -> `backend:4000`, `/*` -> `frontend:3000`), TLS termination (`listen 443 ssl; http2 on;`), security headers, gzip compression, and immutable caching for `/_next/static/*`.
- **Frontend (`frontend:3000`)**: Multi-stage production Next.js 16 container running as non-root `appuser` with `INTERNAL_BACKEND_URL=http://backend:4000`.
- **Backend (`backend:4000`)**: Multi-stage Express + Prisma container running as non-root `appuser`.
- **Background Worker (`background-worker`)**: Same backend image executing `node dist/worker.js` for BullMQ queues & repeatable sweeps.
- **Python Service (`python-service:8000`)**: Slim Python 3.13 Uvicorn FastAPI service running as non-root `appuser`.
- **PostgreSQL 16 & Redis 7**: Private bridge network (`marketsphere-net`) with persistent named volumes (`postgres_data`, `redis_data`, `backend_uploads`).

## 2. Container Startup (Docker Compose)
```bash
cp .env.example .env
# Populate secure secrets in .env (never commit .env)
docker compose up --build -d
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run prisma:seed
```

## 3. Environment Isolation
- **Development:** `.env` local credentials, sandbox adapters (`PAYMENT_SANDBOX_MODE=sandbox`), hot reload.
- **Staging:** Triggered via `.github/workflows/ci-cd.yml` (`environment: staging`), isolated database/Redis, automated `/api/v1/health` smoke check.
- **Production:** Gated by manual GitHub Environment approval (`environment: production`), TLS certificates mounted at `infrastructure/nginx/certs/`, private DB/Redis network access (ports not exposed publicly).

## 4. Database Backup & Restore Verification
```bash
# Logical backup
pg_dump -h localhost -p 5435 -U marketsphere -Fc marketsphere > backup_$(date +%Y%m%d).dump

# Restore to verification database
createdb -h localhost -p 5435 -U marketsphere marketsphere_restore_check
pg_restore -h localhost -p 5435 -U marketsphere -d marketsphere_restore_check backup_*.dump
```

## 5. Rollback Procedure
1. Tag previous known-good container digest (`marketsphere/backend:<prev-sha>`).
2. If database migration is backward-compatible, redeploy previous container images via `docker compose up -d`.
3. If migration requires rollback, restore latest pre-deployment `pg_dump` snapshot and redeploy prior image tags.
4. For CI/CD dispatch rollbacks, trigger `.github/workflows/ci-cd.yml` via `workflow_dispatch` with `rollback_sha` and `target_environment`.

## 6. Local TLS / HTTPS Setup
- **Linux / macOS / Containers:** Run `bash infrastructure/scripts/generate-local-tls.sh` to create `server.crt` and `server.key` in `infrastructure/nginx/certs/`.
- **Windows:** Run `powershell -ExecutionPolicy Bypass -File infrastructure\scripts\generate-local-tls.ps1` (auto-discovers OpenSSL from PATH or Git for Windows) to generate `server.crt`, PEM `server.key`, and `server.pfx` in `infrastructure\nginx\certs\` (`*.crt`, `*.key`, `*.pfx` are gitignored).
- Enable HTTPS reverse proxying in Nginx using `infrastructure/nginx/nginx.tls.conf` mounted with `./infrastructure/nginx/certs:/etc/nginx/certs:ro`.

## 7. Prometheus & Health Metrics Observability
- **JSON Dependency Health:** `GET /api/v1/health` reports live PostgreSQL, Redis, and Python FastAPI status (`ok` vs `degraded` when a dependency is unreachable, with `?strict=true` returning HTTP `503` if degraded) plus uptime.
- **Prometheus Metrics Scrape:** `GET /api/v1/health/metrics` exposes Prometheus text (`0.0.4`) gauges and counters:
  - `marketsphere_dependency_up{service="postgres|redis|python"}`
  - `marketsphere_outbox_events_pending`
  - `marketsphere_background_jobs_total{status="QUEUED|ACTIVE|COMPLETED|FAILED|DEAD_LETTER"}`
  - `marketsphere_http_requests_total{method,route,status}` & `marketsphere_http_request_duration_ms_sum` / `_count`
- A ready-to-use Prometheus scrape configuration is provided in `infrastructure/prometheus/prometheus.yml`.
