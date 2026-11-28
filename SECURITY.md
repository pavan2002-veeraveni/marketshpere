# MarketSphere Security Architecture (`SECURITY.md`)

## 1. Authentication & Session Security
- **Password Hashing:** `bcryptjs` with cost factor 12 (salted one-way hash; passwords never logged or returned).
- **Access Tokens & Double-Submit CSRF:** Short-lived JWTs (`15m`) signed with `JWT_ACCESS_SECRET` are retained strictly in frontend JavaScript memory (never `sessionStorage`/`localStorage`), bootstrapped across page reloads via silent cookie refresh. Login/refresh issue a companion `ms_csrf_token` cookie alongside `HttpOnly` `ms_refresh_token`, and cookie-authenticated `/auth/refresh` & `/auth/logout` verify `X-CSRF-Token` via `crypto.timingSafeEqual`.
- **Content Security Policy (CSP):** Global Helmet CSP on Express (`defaultSrc: 'none'`, `frameAncestors: 'none'`, route-scoped policy on `/api/docs`) and security/CSP response headers configured in `frontend/next.config.ts`.
- **Refresh Token Rotation & Reuse Detection:** Cryptographically random 48-byte tokens stored strictly as SHA-256 hashes in `refresh_tokens` grouped by `family_id`. Presenting a previously rotated/revoked refresh token revokes the entire token family immediately (`401 REFRESH_TOKEN_REUSED`).
- **Rate Limiting:** Global API rate limiter (`300 req/min`) and dedicated strict authentication limiter (`25 attempts / 15 min` on login, registration, and password reset).

## 2. Authorization, RBAC & Isolation
- **Server-Side RBAC:** `authenticate` verifies account existence and `ACTIVE` status on every request; `requireRoles(...)` and `requirePermissions(...)` enforce permissions server-side.
- **Seller Data Isolation:** `assertSellerOwnership` enforces `resource.sellerId === req.user.sellerId`; cross-seller reads/updates return `403 SELLER_ISOLATION_VIOLATION`.
- **Customer Order Privacy (IDOR Prevention):** `ordersService.getOrderDetail` and `cancelOrder` enforce `order.customerId === req.user.userId` for customers; cross-customer access returns `403 ORDER_PRIVACY_VIOLATION`.
- **Verified-Purchase Reviews:** Review creation verifies the caller owns a `DELIVERED` order containing the reviewed product.

## 3. Commerce & Financial Integrity
- **Server-Authoritative Pricing:** Cart and checkout disregard client-submitted prices and always query authoritative `skus.price` + Python FastAPI calculation rules.
- **Decimal Arithmetic:** `decimal.js` (Node.js) and `decimal.Decimal` (Python) with `ROUND_HALF_UP` prevent floating-point rounding drift.
- **Concurrency-Safe Inventory:** `SELECT ... FROM inventory ... FOR UPDATE` inside PostgreSQL transactions combined with `CHECK (reserved_qty <= on_hand_qty)` prevents overselling.
- **Idempotent Webhooks & Refunds:**
  - Webhooks verify HMAC-SHA256 `X-Marketplace-Signature` via `crypto.timingSafeEqual` and claim unique `(provider, provider_event_id)` in `webhook_events`.
  - Refunds lock `payments` rows `FOR UPDATE` and enforce `sum(refunds) + requested <= payment.amount` plus `Idempotency-Key` uniqueness.

## 4. Upload, Input & Transport Hardening
- **Safe File Uploads (`src/common/upload.ts`):** Validates allowlisted MIME types, file extensions, size limits (`5 MiB`), binary magic bytes (`%PDF`, JPEG/PNG/WEBP signatures), SHA-256 checksums, and canonical path containment. Onboarding documents are never served publicly via static routes.
- **Input & Error Safety:** Strict Zod validation on body/query/params, parameterized Prisma queries (SQL injection immune), Helmet security headers, strict CORS origin allowlist, Pino secret/token redaction, and sanitized error responses (never exposing stack traces or raw SQL errors).
