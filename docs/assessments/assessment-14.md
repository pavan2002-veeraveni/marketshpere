# Assessment 14 — Marketplace Deployment

**Completion Status:** `IMPLEMENTED` *(Local Stack & Backup Verified; Public Cloud/Docker Live Host Pending)*  
**Primary Artifacts:**
- [`docker-compose.yml`](../../docker-compose.yml)
- [`infrastructure/nginx/nginx.conf`](../../infrastructure/nginx/nginx.conf) & [`infrastructure/nginx/nginx.tls.conf`](../../infrastructure/nginx/nginx.tls.conf)
- [`infrastructure/scripts/backup-restore-verify.ps1`](../../infrastructure/scripts/backup-restore-verify.ps1)
- [`infrastructure/scripts/generate-local-tls.ps1`](../../infrastructure/scripts/generate-local-tls.ps1) & [`infrastructure/scripts/generate-local-tls.sh`](../../infrastructure/scripts/generate-local-tls.sh)
- [`infrastructure/prometheus/prometheus.yml`](../../infrastructure/prometheus/prometheus.yml)
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md)

## Objective & Requirements
Prepare full deployment topology covering Customer Storefront, Seller/Warehouse/Support/Admin portals, Backend API, Python service, PostgreSQL, and Redis behind Nginx with HTTPS TLS configuration, static asset caching, private network database isolation, backup/restore verification, Prometheus metrics, and multi-environment promotion.

## Observed Execution Results
- **Local Production Runtime Verified:**
  - PostgreSQL 18 (`127.0.0.1:5435`) serving 51 tables + Memurai Redis (`127.0.0.1:6379`) + compiled BullMQ Worker (`node backend/dist/worker.js`).
  - Python FastAPI Uvicorn (`127.0.0.1:8000`) responding `200 OK` on `/api/v1/health`.
  - Compiled Express backend (`node backend/dist/server.js` on `:4000`) responding `200 OK` on `/api/v1/health` (`5000ms` Python timeout + `?strict=true` `503`) and Prometheus exposition `200 OK` on `/api/v1/health/metrics`.
  - Production Next.js 16 server (`next start -p 3000`) serving all routes with CSP headers.
- **Local TLS Setup Verified (`generate-local-tls.ps1`):**
  - Auto-discovered Git OpenSSL (`C:\Program Files\Git\usr\bin\openssl.exe`) and generated self-signed SAN bundle `server.crt` (`1330` bytes), PEM `server.key` (`1704` bytes), and PFX `server.pfx` (`2707` bytes) in `infrastructure/nginx/certs/` (gitignored).
- **Database Backup & Restore Verified (`backup-restore-verify.ps1`):**
  - `pg_dump -Fc` created logical dump `marketsphere_20261127_132652.dump`.
  - Fixed `infrastructure/scripts/backup-restore-verify.ps1` parameter block order & `.env` credential loading and re-verified cleanly against PostgreSQL 18 (`5435`): exit `0`, **`Verified restored table count: 51`** into `marketsphere_restore_verify`.

## Known Limitations
- Docker CLI is not installed on this Windows host, so multi-container `docker compose up` & Prometheus scraping remain verified at the config/CI level (`docker-build` builds images, runs `docker compose config --quiet`, and `nginx -t`). Cloud Vercel Serverless runtime (`marketsphere-kappa.vercel.app`) uses ephemeral `/tmp` upload storage and has no long-lived worker daemon compared to the full local/Compose deployment.
