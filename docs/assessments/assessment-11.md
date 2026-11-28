# Assessment 11 — Marketplace CI/CD

**Completion Status:** `IMPLEMENTED`  
**Primary Artifacts:**
- [`.github/workflows/ci-cd.yml`](../../.github/workflows/ci-cd.yml)
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md)

## Objective & Requirements
Provide an automated GitHub Actions pipeline running lint, typechecking, unit/integration tests across backend/frontend/Python, Prisma migration validation against Postgres/Redis services, security auditing, multi-stage Docker builds, registry publishing, staging deployment, manual production approval gate, and rollback documentation.

## Implementation Details
- `backend-ci`: Spins up `postgres:16-alpine` and `redis:7-alpine` service containers, applies `prisma migrate deploy`, seeds DB, runs `typecheck`, `lint`, `vitest run`, and `npm audit`.
- `python-ci`: Runs `ruff check`, `pytest -v`, and `tests.benchmark` on Python 3.13.
- `frontend-ci`: Runs `tsc --noEmit`, `eslint src`, `vitest run`, and `next build`.
- `docker-build`, `deploy-staging`, `deploy-production`, `rollback-production`: Builds backend/python/frontend images, authenticates registry push via job-level `env.REGISTRY_TOKEN`, deploys staging automatically on `main`, enforces GitHub `production` environment manual approval before promotion, and supports `workflow_dispatch` rollback (`rollback_sha`, `target_environment`).

## Verification & Known Limitations
- Validated YAML syntax cleanly via `yaml.safe_load` (`7` jobs) and ensured full schema compatibility with the VS Code GitHub Actions workflow validator (`secrets` confined to `env`, dynamic `${{ vars.* || '...' }}` environment expressions).
- `.github/workflows/ci-cd.yml` defines `8` validated jobs (`backend-ci`, `python-ci`, `frontend-ci`, `e2e-ci` full-stack Playwright, `docker-build`, `deploy-staging`, `deploy-production`, `rollback-production`), enforces `npm audit --omit=dev --audit-level=moderate` on both `backend` and `frontend`, enforces `75/75/70/60` backend test coverage gates, validates `docker compose config --quiet` and `nginx -t` (HTTP & TLS) inside `docker-build`, and **passed cleanly in remote GitHub Actions Run `46146095235` (`conclusion: success`)** (`deploy-staging`/`deploy-production` cloud push steps remain conditional on configured external registry/URL secrets).
