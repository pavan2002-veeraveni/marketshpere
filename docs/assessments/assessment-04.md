# Assessment 04 — Marketplace Security

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/src/common/middleware/auth.ts`](../../backend/src/common/middleware/auth.ts)
- [`backend/src/common/upload.ts`](../../backend/src/common/upload.ts)
- [`backend/tests/auth_security.test.ts`](../../backend/tests/auth_security.test.ts)
- [`SECURITY.md`](../../SECURITY.md)

## Objective & Requirements
Enforce RBAC, seller data isolation, customer order privacy, refresh token rotation/reuse revocation, server-authoritative checkout pricing, magic-byte file upload validation, rate limiting, and audit logging.

## Observed Execution Results (`auth_security.test.ts` — 6/6 PASSED)
1. **Refresh token rotation & reuse attack detection (`401 REFRESH_TOKEN_REUSED`)**: Passed.
2. **Seller isolation (`403 SELLER_ISOLATION_VIOLATION` on cross-seller GET/PATCH)**: Passed.
3. **Customer order privacy (`403 ORDER_PRIVACY_VIOLATION` on cross-customer GET)**: Passed.
4. **Admin RBAC enforcement (`403` for non-admin, `200` for admin)**: Passed.
5. **Upload magic-byte & extension validation (`400 INVALID_FILE_SIGNATURE` on spoofed `.pdf`)**: Passed.
6. **Verified-purchase review enforcement (`403` when non-buyer attempts review)**: Passed.
7. **Password reset token non-disclosure (`POST /auth/password-reset/request` & `/confirm`)**: Passed (`7/7` in `auth_security.test.ts`, zero `sandboxResetToken` leak in HTTP response).

## Post-Fix Security Hardening & Dependency Audit
- Replaced `MemoryStore` in `backend/src/common/middleware/rate-limit.ts` with `HybridRedisRateLimitStore` (`INCR` + `PEXPIRE` on Redis when ready, `Map` fallback offline).
- Removed `refreshToken` from browser `localStorage`/`sessionStorage`; `/auth/refresh` and `/auth/logout` rely on `HttpOnly` `ms_refresh_token` cookies while short-lived `accessToken` is kept in `sessionStorage` + memory.
- Executed local `npm audit --omit=dev --audit-level=high` scans:
  - Backend exited `1` with **5 high-severity advisories** (`zod <4.6.6` GHSA-mrhx-c7xc-m3w5 requiring major v4 upgrade; `deepmerge-ts` & `effect` via `prisma`/`@prisma/config`).
  - Frontend exited `1` with **3 advisories (1 moderate, 2 high)** (`zod <4.6.6`, `postcss <=8.5.22` via `next`, requiring `--force` breaking v4/v16 upgrades).
