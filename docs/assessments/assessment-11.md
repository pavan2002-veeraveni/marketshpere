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
- `.github/workflows/ci-cd.yml` defines `8` validated jobs (`backend-ci`, `python-ci`, `frontend-ci`, `e2e-ci` full-stack Playwright, `docker-build`, `deploy-staging`, `deploy-production`, `rollback-production`), enforces strict `npm --prefix backend audit --omit=dev --audit-level=high` (currently reports actionable `zod` / `prisma` CVEs until upgraded), and includes curl `/api/v1/health` + Prometheus `/api/v1/health/metrics` smoke gates when `*_BASE_URL` vars are set.
- Live GitHub Actions runner execution requires pushing to a configured GitHub repository.
