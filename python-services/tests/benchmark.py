"""Benchmark script for Python FastAPI pricing, feed processing, and recommendations."""

import time
from decimal import Decimal

from app.models.schemas import (
    CatalogItemVector,
    PricingCalculateRequest,
    PricingItemInput,
    RecommendationRequest,
)
from app.services.feed_service import process_product_feed
from app.services.pricing_service import calculate_pricing
from app.services.recommendation_service import generate_recommendations


def run_benchmarks():
    # 1. Feed processing benchmark (2,000 rows)
    csv_rows = ["title,sku_code,price,category_slug,quantity,brand"]
    for i in range(2000):
        csv_rows.append(f"Catalog Product {i},MS-BENCH-{i:05d},{19 + (i % 120)}.99,electronics,{i % 100},MarketBrand")
    csv_data = "\n".join(csv_rows)

    t0 = time.perf_counter()
    feed_result = process_product_feed("csv", csv_data)
    feed_ms = (time.perf_counter() - t0) * 1000

    # 2. Pricing engine benchmark (500 calculations x 10 items)
    items = [
        PricingItemInput(
            product_id=f"p-{i}",
            sku_id=f"s-{i}",
            sku_code=f"SKU-{i}",
            seller_id="sel-1",
            category_id="cat-1",
            unit_price=Decimal("49.99"),
            quantity=2,
        )
        for i in range(10)
    ]
    req = PricingCalculateRequest(items=items)
    t1 = time.perf_counter()
    for _ in range(500):
        calculate_pricing(req)
    pricing_ms = (time.perf_counter() - t1) * 1000

    # 3. Recommendation engine benchmark (200 items catalog x 200 runs)
    catalog = [
        CatalogItemVector(
            product_id=f"p-{i}",
            category_id=f"cat-{i % 5}",
            title=f"Product Audio Studio {i}",
            popularity_score=float(100 - (i % 80)),
            price=Decimal("99.00"),
        )
        for i in range(200)
    ]
    rec_req = RecommendationRequest(
        customer_id="cust-1",
        product_id="p-1",
        catalog=catalog,
        purchased_product_ids=["p-2"],
        viewed_category_ids=["cat-1", "cat-2"],
        limit=6,
    )
    t2 = time.perf_counter()
    for _ in range(200):
        generate_recommendations(rec_req)
    rec_ms = (time.perf_counter() - t2) * 1000

    print(
        f"Feed(2000 rows): {feed_ms:.2f} ms (valid={feed_result.valid_rows}) | "
        f"Pricing(500x10): {pricing_ms:.2f} ms | "
        f"Recommendations(200x200): {rec_ms:.2f} ms"
    )


if __name__ == "__main__":
    run_benchmarks()
