# Assessment 05 — Python Pricing and Feed Engine

**Completion Status:** `VERIFIED`  
**Primary Artifacts:**
- [`python-services/app/services/pricing_service.py`](../../python-services/app/services/pricing_service.py)
- [`python-services/app/services/feed_service.py`](../../python-services/app/services/feed_service.py)
- [`python-services/app/models/schemas.py`](../../python-services/app/models/schemas.py)
- [`python-services/tests/test_python_services.py`](../../python-services/tests/test_python_services.py)
- [`python-services/tests/benchmark.py`](../../python-services/tests/benchmark.py)

## Objective & Requirements
Provide a standalone FastAPI service implementing deterministic pricing & promotion evaluation, commission calculation, and streaming CSV/JSON catalog feed normalization with SKU validation, duplicate detection, and invalid-row reporting.

## Architecture Decisions
- Strictly uses Python `decimal.Decimal` with `ROUND_HALF_UP` quantization to 2 decimal places (`q2`); never uses IEEE-754 floats for currency math.
- Last-eligible-line remainder adjustment guarantees line-level discount allocations sum identically to cart-level discount totals.
- Protected internal APIs with constant-time `X-Internal-Service-Token` verification (`hmac.compare_digest`).
- Uses `io.StringIO` + `csv.DictReader` row iteration to avoid unbounded intermediate object duplication on large CSV imports.

## Observed Execution Results
- `ruff check app tests`: **All checks passed!**
- `pytest -v`: **10 passed, 0 failed** (including `test_pricing_percentage_coupon_cap_and_exact_cent_allocation`, `test_pricing_min_cart_not_met`, `test_commissions_seller_override_and_rules`, `test_feed_processing_csv_with_duplicates_and_invalid_rows`, `test_feed_processing_json_invalid_input`).
- `python -m tests.benchmark`:
  - **CSV Feed Normalization (2,000 rows):** `31.17 ms` (`valid=2000`)
  - **Pricing Calculations (500 x 10-item carts):** `55.20 ms`

## Known Limitations
- Express falls back to an identical deterministic `decimal.js` implementation if FastAPI is unreachable; live integration was verified with Uvicorn running on port `8000`.
- Post-fix Python suite verified: `ruff check` (`All checks passed!`), `pytest -v` (**`11/11` passed in `1.14s`**, including `test_feed_upload_multipart_csv` for `POST /api/v1/feeds/upload`), and live benchmark (**Feed `2,000` rows: `48.20 ms` | Pricing `500x10`: `62.72 ms` | Recommendations `200x200`: `118.82 ms`**).
