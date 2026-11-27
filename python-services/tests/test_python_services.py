import json
import time
from decimal import Decimal
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import settings

client = TestClient(app)
HEADERS = {"X-Internal-Service-Token": settings.internal_service_token}


def test_health_endpoint():
    res = client.get("/api/v1/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_requires_internal_service_token():
    res = client.post(
        "/api/v1/pricing/calculate",
        json={
            "items": [
                {
                    "product_id": "p1",
                    "sku_id": "s1",
                    "sku_code": "SKU-1",
                    "seller_id": "sel1",
                    "category_id": "cat1",
                    "unit_price": "10.00",
                    "quantity": 1,
                }
            ]
        },
    )
    assert res.status_code == 401


def test_pricing_percentage_coupon_cap_and_exact_cent_allocation():
    payload = {
        "currency": "USD",
        "tax_rate": "0.0825",
        "items": [
            {
                "product_id": "p1",
                "sku_id": "s1",
                "sku_code": "APX-1",
                "seller_id": "sel1",
                "category_id": "cat1",
                "unit_price": "100.00",
                "quantity": 2,
            },
            {
                "product_id": "p2",
                "sku_id": "s2",
                "sku_code": "APX-2",
                "seller_id": "sel2",
                "category_id": "cat2",
                "unit_price": "33.33",
                "quantity": 3,
            },
        ],
        "promotion": {
            "code": "BIGSAVE25",
            "discount_type": "PERCENTAGE",
            "value": "25.00",
            "min_cart_amount": "50.00",
            "max_discount_amount": "50.00",
        },
    }
    res = client.post("/api/v1/pricing/calculate", json=payload, headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["subtotalAmount"] == "299.99"
    assert body["discountAmount"] == "50.00"
    assert body["shippingAmount"] == "0.00"  # >= 150 free shipping
    line_discounts = sum(Decimal(item["discountAmount"]) for item in body["items"])
    assert line_discounts == Decimal("50.00")


def test_pricing_min_cart_not_met():
    payload = {
        "items": [
            {
                "product_id": "p1",
                "sku_id": "s1",
                "sku_code": "APX-1",
                "seller_id": "sel1",
                "category_id": "cat1",
                "unit_price": "20.00",
                "quantity": 1,
            }
        ],
        "promotion": {
            "code": "SAVE20",
            "discount_type": "FIXED",
            "value": "20.00",
            "min_cart_amount": "100.00",
        },
    }
    res = client.post("/api/v1/pricing/calculate", json=payload, headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["promotionApplied"] is False
    assert body["discountAmount"] == "0.00"
    assert body["shippingAmount"] == "9.99"


def test_commissions_seller_override_and_rules():
    payload = {
        "items": [
            {
                "order_item_id": "oi-1",
                "seller_id": "sel-1",
                "category_id": "cat-audio",
                "unit_price": "200.00",
                "quantity": 1,
                "discount_amount": "20.00",
            },
            {
                "order_item_id": "oi-2",
                "seller_id": "sel-2",
                "category_id": "cat-home",
                "unit_price": "100.00",
                "quantity": 2,
                "discount_amount": "0.00",
                "seller_rate_override": "0.1250",
            },
        ],
        "rules": [
            {
                "name": "Audio 8%",
                "category_id": "cat-audio",
                "commission_type": "PERCENTAGE",
                "percentage_rate": "0.0800",
                "priority": 10,
            }
        ],
    }
    res = client.post("/api/v1/commissions/calculate", json=payload, headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    # oi-1: (200-20)*0.08 = 14.40; net = 165.60
    assert data["items"][0]["commission_amount"] == "14.40"
    assert data["items"][0]["net_seller_amount"] == "165.60"
    # oi-2: 200*0.125 = 25.00; net = 175.00
    assert data["items"][1]["commission_amount"] == "25.00"
    assert data["total_commission"] == "39.40"


def test_feed_processing_csv_with_duplicates_and_invalid_rows():
    csv_content = "\n".join(
        [
            "title,sku_code,price,category_slug,quantity,brand",
            "  Wireless   Mic  ,apx-mic-01,$129.99,audio-studio,15,Apex",
            "Duplicate Mic,APX-MIC-01,129.99,audio-studio,5,Apex",
            "Bad Price Item,BAD-02,-10.00,electronics,3,Apex",
            "Studio Stand,APX-STD-02,49.50,accessories,20,Apex",
        ]
    )
    res = client.post(
        "/api/v1/feeds/process",
        json={"format": "csv", "content": csv_content},
        headers=HEADERS,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["total_rows"] == 4
    assert body["valid_rows"] == 2
    assert body["invalid_rows"] == 2
    assert body["duplicate_skus"] == ["APX-MIC-01"]
    assert body["normalized_items"][0]["title"] == "Wireless Mic"
    assert body["normalized_items"][0]["sku_code"] == "APX-MIC-01"


def test_feed_processing_json_invalid_input():
    res = client.post(
        "/api/v1/feeds/process",
        json={"format": "json", "content": json.dumps([{"title": "X", "sku_code": "INVALID SKU", "price": "abc"}])},
        headers=HEADERS,
    )
    assert res.status_code == 200
    assert res.json()["invalid_rows"] == 1
    assert res.json()["valid_rows"] == 0


def test_recommendations_cold_start_deterministic_fallback():
    res = client.get("/api/v1/recommendations/unknown-new-user", headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert data["strategy"] == "deterministic-cold-start-popularity"
    assert len(data["recommendations"]) > 0
    assert "no customer history available" in data["recommendations"][0]["reason"].lower()


def test_recommendations_personalized_category_affinity():
    res = client.get("/api/v1/recommendations/demo-customer-office", headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert data["strategy"] == "hybrid-personalized-similarity"
    assert data["recommendations"][0]["product_id"] in {"syn-prod-5", "syn-prod-3", "syn-prod-6"}


def test_feed_and_pricing_benchmark_under_threshold():
    rows = ["title,sku_code,price,category_slug,quantity"]
    for i in range(500):
        rows.append(f"Item {i},SKU-BENCH-{i:04d},{10 + (i % 90)}.99,electronics,{i % 50}")
    csv_blob = "\n".join(rows)
    start = time.perf_counter()
    res = client.post(
        "/api/v1/feeds/process",
        json={"format": "csv", "content": csv_blob},
        headers=HEADERS,
    )
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert res.status_code == 200
    assert res.json()["valid_rows"] == 500
    assert elapsed_ms < 2000


def test_feed_upload_multipart_csv():
    csv_bytes = (
        "title,sku_code,price,category_slug,quantity,brand\n"
        "Uploaded Ribbon Mic,UP-MIC-01,299.00,audio-studio,12,Apex\n"
    ).encode("utf-8")
    res = client.post(
        "/api/v1/feeds/upload",
        files={"file": ("feed.csv", csv_bytes, "text/csv")},
        headers=HEADERS,
    )
    assert res.status_code == 200
    data = res.json()
    assert data["valid_rows"] == 1
    assert data["normalized_items"][0]["sku_code"] == "UP-MIC-01"
