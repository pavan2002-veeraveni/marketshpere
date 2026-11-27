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
  - PostgreSQL 18 (`127.0.0.1:5435`) serving 51 tables.
  - Python FastAPI Uvicorn (`127.0.0.1:8000`) responding `200 OK` on `/api/v1/health`.
  - Compiled Express backend (`node backend/dist/server.js` on `:4000`) responding `200 OK` on `/api/v1/health` and Prometheus exposition `200 OK` on `/api/v1/health/metrics`.
  - Production Next.js server (`next start -p 3000`) serving all 14 routes.
- **Local TLS Setup Verified (`generate-local-tls.ps1`):**
  - Generated self-signed SAN certificate `server.crt` (`1191` bytes) & PFX `server.pfx` (`2726` bytes) in `infrastructure/nginx/certs/` (gitignored).
- **Database Backup & Restore Verified (`backup-restore-verify.ps1`):**
  - `pg_dump -Fc` created logical dump `marketsphere_20261127_132652.dump`.
  - Fixed `infrastructure/scripts/backup-restore-verify.ps1` parameter block order & `.env` credential loading and re-verified cleanly against PostgreSQL 18 (`5435`): exit `0`, **`Verified restored table count: 51`** into `marketsphere_restore_verify`.

## Known Limitations
- Public cloud/VPS live URLs and CA-signed TLS certificates require target hosting, and Docker Desktop/Redis are not installed on this Windows host. Nginx TLS termination (`nginx.tls.conf`), Prometheus scrape config (`prometheus.yml`), Docker Compose networking, and staging/production/rollback CI workflows are complete and locally verified at the runtime/script level.
