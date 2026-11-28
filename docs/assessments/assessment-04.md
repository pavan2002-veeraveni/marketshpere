# Assessment 04 — Marketplace Security

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`backend/src/common/middleware/auth.ts`](../../backend/src/common/middleware/auth.ts)
- [`backend/src/common/upload.ts`](../../backend/src/common/upload.ts)
- [`backend/tests/auth_security.test.ts`](../../backend/tests/auth_security.test.ts)
- [`SECURITY.md`](../../SECURITY.md)

## Objective & Requirements
Enforce RBAC, seller data isolation, customer order privacy, refresh token rotation/reuse revocation, server-authoritative checkout pricing, magic-byte file upload validation, rate limiting, and audit logging.

## Observed Execution Results (`auth_security.test.ts` — 9/9 PASSED)
1. **Refresh token rotation & reuse attack detection (`401 REFRESH_TOKEN_REUSED`)**: Passed.
2. **Seller isolation (`403 SELLER_ISOLATION_VIOLATION` on cross-seller GET/PATCH)**: Passed.
3. **Customer order privacy (`403 ORDER_PRIVACY_VIOLATION` on cross-customer GET)**: Passed.
4. **Admin RBAC enforcement (`403` for non-admin, `200` for admin)**: Passed.
5. **Upload magic-byte & extension validation (`400 INVALID_FILE_SIGNATURE` on spoofed `.pdf`)**: Passed.
6. **Verified-purchase review enforcement (`403` when non-buyer attempts review)**: Passed.
7. **Password reset token non-disclosure (`POST /auth/password-reset/request` & `/confirm`)**: Passed (zero `sandboxResetToken` leak in HTTP response).
8. **Cookie flags (`HttpOnly` `SameSite=Lax`) & Double-Submit CSRF protection (`403 CSRF_TOKEN_INVALID` without `X-CSRF-Token` matching `ms_csrf_token`)**: Passed.

## Post-Fix Security Hardening & Dependency Audit
- Replaced `MemoryStore` in `backend/src/common/middleware/rate-limit.ts` with `HybridRedisRateLimitStore` (`INCR` + `PEXPIRE` on Redis when ready, `Map` fallback offline).
- Eliminated `sessionStorage`/`localStorage` token storage on frontend: `accessToken` lives strictly in JavaScript memory (`inMemoryAccessToken`) with silent cookie refresh on page reload; `/auth/refresh` and `/auth/logout` verify `X-CSRF-Token` via `crypto.timingSafeEqual`.
- Added global Helmet CSP on Express (`app.ts`) and security/CSP headers in `frontend/next.config.ts`.
- Verified `npm audit --omit=dev --audit-level=moderate` -> **`found 0 vulnerabilities`** in both `backend` (`zod ^4.6.7`, `prisma 6.12.0`) and `frontend` (`next ^16.4.6`, `zod ^4.6.7`).
