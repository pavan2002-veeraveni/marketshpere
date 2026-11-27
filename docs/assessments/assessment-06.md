# Assessment 06 — FastAPI Recommendation Service

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`python-services/app/services/recommendation_service.py`](../../python-services/app/services/recommendation_service.py)
- [`python-services/app/api/v1/router.py`](../../python-services/app/api/v1/router.py)
- [`backend/src/modules/catalog/catalog.service.ts`](../../backend/src/modules/catalog/catalog.service.ts)

## Objective & Requirements
Expose `POST /api/v1/recommendations` and `GET /api/v1/recommendations/{customer_id}` providing explainable product recommendations combining purchase history, category affinity, item similarity, and popularity, with deterministic empty-history fallback.

## Architecture Decisions
- **Non-authoritative boundary:** Express collects active catalog vectors and authenticated customer purchase categories from PostgreSQL and passes them to FastAPI over HTTP (`X-Internal-Service-Token` + `X-Request-ID`). FastAPI does not own customer PII or order tables.
- **Cold-start determinism:** When `purchased_product_ids` and `viewed_category_ids` are empty and no anchor product is supplied, the service sorts deterministically by `(-popularity_score, product_id)` and emits `"Popular marketplace pick (no customer history available)"` without inventing synthetic history.

## Observed Execution Results
- `test_recommendations_cold_start_deterministic_fallback`: **PASSED**
- `test_recommendations_personalized_category_affinity`: **PASSED**
- `python -m tests.benchmark` (`200` recommendation requests over a `200`-product catalog): **`127.85 ms`** total (`~0.64 ms` per request).
- Integrated live with Storefront `/` ("Recommended For You") and Product Detail `/products/[slug]` ("Similar & Related Products").

## Known Limitations
- Similarity uses deterministic category, price-band, and token-overlap scoring rather than an offline trained vector embedding model; this keeps execution deterministic and explainable without external ML GPU dependencies.
