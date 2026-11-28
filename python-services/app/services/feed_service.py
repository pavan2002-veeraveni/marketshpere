import csv
import io
import json
import re
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation

from app.models.schemas import (
    FeedProcessResponse,
    FeedRowError,
    NormalizedFeedItem,
    fmt2,
)

SKU_REGEX = re.compile(r"^[A-Z0-9_-]{3,80}$")

FIELD_ALIASES = {
    "title": ["title", "product_title", "name", "product_name"],
    "sku_code": ["sku_code", "sku", "variant_sku"],
    "price": ["price", "unit_price", "amount"],
    "category_slug": ["category_slug", "category", "cat_slug"],
    "quantity": ["quantity", "stock", "qty", "inventory"],
    "description": ["description", "desc", "summary"],
    "brand": ["brand", "manufacturer"],
}


def _extract_field(row: dict, canonical: str, default: str = "") -> str:
    lower_row = {str(k).strip().lower(): v for k, v in row.items() if k is not None}
    for alias in FIELD_ALIASES[canonical]:
        if alias in lower_row and lower_row[alias] is not None:
            return str(lower_row[alias]).strip()
    return default


def _iter_rows(fmt: str, content: str) -> Iterable[tuple[int, dict]]:
    if fmt == "csv":
        stream = io.StringIO(content.strip())
        reader = csv.DictReader(stream)
        for idx, row in enumerate(reader, start=1):
            yield idx, row
    else:
        parsed = json.loads(content)
        if not isinstance(parsed, list):
            raise ValueError("JSON feed root must be an array of product objects")
        for idx, row in enumerate(parsed, start=1):
            if not isinstance(row, dict):
                raise TypeError(f"Row {idx} must be a JSON object")
            yield idx, row


def process_product_feed(fmt: str, content: str) -> FeedProcessResponse:
    total_rows = 0
    seen_skus: set[str] = set()
    duplicate_skus: list[str] = []
    normalized_items: list[NormalizedFeedItem] = []
    errors: list[FeedRowError] = []

    try:
        iterator = _iter_rows(fmt, content)
        for row_num, raw_row in iterator:
            total_rows += 1
            title = " ".join(_extract_field(raw_row, "title").split())
            sku_code = _extract_field(raw_row, "sku_code").upper()
            price_raw = _extract_field(raw_row, "price").replace("$", "").replace(",", "")
            category_slug = _extract_field(raw_row, "category_slug", "electronics").lower().replace(" ", "-")
            qty_raw = _extract_field(raw_row, "quantity", "0")
            description = _extract_field(raw_row, "description") or f"{title} catalog product"
            brand = _extract_field(raw_row, "brand") or None

            if len(title) < 2:
                errors.append(FeedRowError(row=row_num, sku_code=sku_code or None, message="Title must be at least 2 characters"))
                continue

            if not SKU_REGEX.match(sku_code):
                errors.append(
                    FeedRowError(
                        row=row_num,
                        sku_code=sku_code or None,
                        message="Invalid SKU code (must be 3-80 alphanumeric, dash, or underscore chars)",
                    )
                )
                continue

            if sku_code in seen_skus:
                if sku_code not in duplicate_skus:
                    duplicate_skus.append(sku_code)
                errors.append(FeedRowError(row=row_num, sku_code=sku_code, message=f"Duplicate SKU '{sku_code}' in feed"))
                continue

            try:
                price_dec = Decimal(price_raw)
                if price_dec <= Decimal(0):
                    raise InvalidOperation()
            except (InvalidOperation, ValueError):
                errors.append(FeedRowError(row=row_num, sku_code=sku_code, message=f"Invalid positive price '{price_raw}'"))
                continue

            try:
                qty_int = int(qty_raw)
                if qty_int < 0:
                    raise ValueError()
            except ValueError:
                errors.append(FeedRowError(row=row_num, sku_code=sku_code, message=f"Invalid non-negative integer quantity '{qty_raw}'"))
                continue

            seen_skus.add(sku_code)
            normalized_items.append(
                NormalizedFeedItem(
                    title=title,
                    sku_code=sku_code,
                    price=fmt2(price_dec),
                    category_slug=category_slug or "electronics",
                    quantity=qty_int,
                    description=description,
                    brand=brand,
                )
            )
    except (json.JSONDecodeError, ValueError, TypeError, csv.Error) as exc:
        errors.append(FeedRowError(row=0, message=f"Malformed {fmt.upper()} feed: {exc}"))
        if total_rows == 0:
            total_rows = 1

    return FeedProcessResponse(
        total_rows=total_rows,
        valid_rows=len(normalized_items),
        invalid_rows=len(errors),
        duplicate_skus=duplicate_skus,
        normalized_items=normalized_items,
        errors=errors,
    )
