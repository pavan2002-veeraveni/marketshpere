# MarketSphere — System Design & Architecture (`SYSTEM_DESIGN.md`)

---

## 1. Architectural Overview

MarketSphere uses a **modular monorepo** separating four independently deployable runtime tiers behind an Nginx reverse proxy:

1. **Frontend (`frontend/`)**: Next.js App Router (React + TypeScript + Tailwind CSS) serving the Customer Storefront and role-gated Seller, Warehouse, Support, and Admin portals.
2. **Core Commerce Backend (`backend/`)**: Node.js + Express.js + TypeScript + Prisma ORM acting as the **sole authoritative commerce orchestrator** and database owner.
3. **Background Worker Runtime (`backend/src/worker.ts`)**: BullMQ + Redis asynchronous workers coupled with PostgreSQL transactional outbox / job tracking records.
4. **Python Calculation & Intelligence Service (`python-services/`)**: FastAPI + Pydantic service providing stateless, deterministic pricing/promotion evaluation, commission math, bulk catalog feed normalization, and explainable product recommendations.
5. **Data Infrastructure**: PostgreSQL (authoritative relational store) and Redis (cache, rate-limit store, BullMQ queues, short-lived distributed locks).

---

## 2. High-Level System Architecture Diagram

```mermaid
flowchart TB
    Client["Browser / Mobile Client"] -->|HTTPS / REST| Nginx["Nginx Reverse Proxy"]
    Nginx -->|"/* (SSR & Static)"| Frontend["Next.js App Router (Port 3000)"]
    Nginx -->|"/api/v1/* & /api/docs"| Backend["Express.js Core API (Port 4000)"]

    Frontend -->|Typed Axios Client + JWT| Nginx
    Backend -->|Prisma ORM (Authoritative RW)| Postgres[("PostgreSQL 16+")]
    Backend -->|Cache & BullMQ Enqueue| Redis[("Redis 7+")]
    Backend -->|Internal Service HTTP + HMAC/Token| FastAPI["Python FastAPI Service (Port 8000)"]
    Backend -->|Sandbox Adapters| Sandbox["Sandbox Gateways (Pay / Ship / Mail / Storage)"]

    Worker["BullMQ Background Workers"] -->|Consume Jobs| Redis
    Worker -->|Idempotent Updates & Audit| Postgres
    Worker -->|Bulk Feed / Calc Calls| FastAPI
    Worker -->|Email / Webhook Retry| Sandbox
```

---

## 3. Bounded Service Responsibilities & Ownership

| Layer | Owns | Must Never Do |
|---|---|---|
| **Frontend (Next.js)** | UI state (Redux Toolkit), server cache (TanStack Query), form UX (RHF+Zod), route presentation | Enforce authoritative RBAC/pricing/stock rules; embed secrets |
| **Backend (Express.js)** | Auth, RBAC, Seller isolation, Catalog, Inventory reservations & ledger, Cart, Checkout, Orders, Payments, Shipping, Returns/Refunds, Commissions, Settlements, Audit | Delegate authoritative order/payment/stock persistence to Python or client |
| **Python Service (FastAPI)** | Deterministic pricing/promotions, commission rules evaluation, streaming CSV/JSON catalog feed normalization, recommendation ranking & cold-start fallback | Maintain a separate database of orders, payments, inventory, or customer PII |
| **Redis + BullMQ** | Reservation expiry sweep scheduling, async emails/notifications, payment reconciliation, feed batch processing, settlement batch generation | Act as sole unpersisted truth for financial or stock state transitions |

---

## 4. Inter-Service Component Diagram

```mermaid
flowchart LR
    subgraph Express["Express Core Backend"]
        MW["Middleware: RequestID -> Helmet -> CORS -> RateLimit -> Auth -> RBAC"]
        ModAuth["Auth & Users"]
        ModSeller["Seller Onboarding & Catalog"]
        ModInv["Inventory & Reservation Engine"]
        ModOrder["Cart, Checkout & Order State Machine"]
        ModFin["Payments, Webhooks, Returns, Commissions, Settlements"]
        Adapters["Integration Adapters (Pay / Ship / Mail / Storage / Python)"]
    end

    MW --> ModAuth & ModSeller & ModInv & ModOrder & ModFin
    ModOrder --> ModInv
    ModOrder --> Adapters
    ModFin --> Adapters
```

---

## 5. Critical Sequence Diagrams

### 5.1 Authentication & Refresh Token Rotation Flow

```mermaid
sequenceDiagram
    actor U as User
    participant FE as Next.js Frontend
    participant API as Express Auth API
    participant DB as PostgreSQL

    U->>FE: Submit email + password
    FE->>API: POST /api/v1/auth/login
    API->>DB: Lookup user + verify Argon2/bcrypt hash + check status
    API->>DB: Insert RefreshToken (hashed token, familyId, expiresAt)
    API-->>FE: 200 { accessToken (15m JWT), refreshToken (HttpOnly cookie / token) }

    Note over FE,API: Access token expires
    FE->>API: POST /api/v1/auth/refresh
    API->>DB: Verify refresh token hash & check revokedAt
    alt Token already revoked (reuse detected)
        API->>DB: Revoke entire token family
        API-->>FE: 401 REFRESH_TOKEN_REUSED
    else Valid unrevoked token
        API->>DB: Mark old token revoked, issue new RefreshToken in same family
        API-->>FE: 200 { newAccessToken, newRefreshToken }
    end
```

### 5.2 Concurrency-Safe Inventory Reservation & Checkout Sequence

```mermaid
sequenceDiagram
    actor C1 as Customer A
    actor C2 as Customer B
    participant API as Express Checkout Service
    participant PY as Python Pricing Engine
    participant DB as PostgreSQL
    participant Q as Redis / BullMQ

    par Simultaneous Checkout for Last Unit (available = 1)
        C1->>API: POST /api/v1/checkout (Idempotency-Key: k1)
        C2->>API: POST /api/v1/checkout (Idempotency-Key: k2)
    end

    API->>PY: POST /api/v1/pricing/calculate (server prices + coupons)
    PY-->>API: Deterministic totals (Decimal)

    API->>DB: BEGIN TRANSACTION
    API->>DB: SELECT * FROM inventory WHERE sku_id = X ORDER BY id FOR UPDATE
    Note over DB: Customer A acquires row lock first (on_hand=1, reserved=0)
    API->>DB: Verify (on_hand - reserved) >= 1 -> OK
    API->>DB: UPDATE inventory SET reserved_qty = reserved_qty + 1
    API->>DB: INSERT inventory_reservations (status=ACTIVE, expires_at=+15m)
    API->>DB: INSERT inventory_ledger (delta=1, type=RESERVE)
    API->>DB: INSERT orders (PENDING_PAYMENT) + order_items + payment (INITIATED)
    API->>DB: COMMIT
    API->>Q: Schedule reservation expiry check (+15m)
    API-->>C1: 201 Order & Payment Intent Created

    Note over DB: Customer B resumes after lock release (on_hand=1, reserved=1)
    API->>DB: Verify (on_hand - reserved) >= 1 -> 0 < 1
    API->>DB: ROLLBACK
    API-->>C2: 409 INSUFFICIENT_STOCK
```

### 5.3 Idempotent Payment Webhook Sequence

```mermaid
sequenceDiagram
    participant PG as Sandbox Payment Gateway
    participant API as Express Webhook Controller
    participant DB as PostgreSQL

    PG->>API: POST /api/v1/webhooks/payments (X-Marketplace-Signature, eventId=evt_123)
    API->>API: Verify HMAC-SHA256 signature & timestamp tolerance
    API->>DB: BEGIN TRANSACTION
    API->>DB: INSERT INTO webhook_events (provider, provider_event_id) ON CONFLICT DO NOTHING
    alt Already exists & status = PROCESSED
        API->>DB: COMMIT
        API-->>PG: 200 { success: true, idempotent: true }
    else New event
        API->>DB: Lock Payment & Order rows FOR UPDATE
        API->>DB: Update Payment (CAPTURED) + PaymentEvent
        API->>DB: Transition Order PENDING_PAYMENT -> PAYMENT_CONFIRMED + History
        API->>DB: Convert ACTIVE Reservations -> COMMITTED, decrement on_hand & reserved, insert Ledger (COMMIT_SALE)
        API->>DB: Insert CommissionLedger entries + OutboxEvent (ORDER_CONFIRMED)
        API->>DB: Mark webhook_events status = PROCESSED
        API->>DB: COMMIT
        API-->>PG: 200 { success: true, processed: true }
    end
```

### 5.4 Order Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT
    PENDING_PAYMENT --> PAYMENT_CONFIRMED: Payment captured
    PENDING_PAYMENT --> CANCELLED: Customer cancel / Reservation expired / Payment failed
    PAYMENT_CONFIRMED --> PROCESSING: Seller/Warehouse accepts
    PAYMENT_CONFIRMED --> CANCELLED: Admin/Customer cancel before shipment
    PROCESSING --> READY_TO_SHIP: Pick & pack completed
    READY_TO_SHIP --> SHIPPED: Carrier handoff
    SHIPPED --> OUT_FOR_DELIVERY: Carrier transit update
    OUT_FOR_DELIVERY --> DELIVERED: Delivery confirmed
    DELIVERED --> RETURN_REQUESTED: Customer requests return within window
    RETURN_REQUESTED --> RETURN_APPROVED: Seller/Support/Admin approves
    RETURN_REQUESTED --> DELIVERED: Return rejected
    RETURN_APPROVED --> RETURNED: Warehouse receives returned items
    RETURNED --> REFUND_PENDING: Refund initiated
    CANCELLED --> REFUND_PENDING: Paid order cancelled
    REFUND_PENDING --> REFUNDED: Refund settled
```

---

## 6. Deployment & Network Topology

```mermaid
flowchart TB
    Internet["HTTPS Traffic (:443)"] --> Nginx["Nginx Reverse Proxy + TLS Termination + Static Asset Cache"]
    subgraph PrivateNet["Docker Internal Network (marketsphere-net)"]
        Nginx --> FE["frontend:3000 (Next.js)"]
        Nginx --> BE["backend:4000 (Express API)"]
        BE --> PY["python-service:8000 (FastAPI)"]
        BE --> PG[("postgres:5432")]
        BE --> RD[("redis:6379")]
        WK["background-worker (BullMQ)"] --> PG
        WK --> RD
        WK --> PY
    end
```
