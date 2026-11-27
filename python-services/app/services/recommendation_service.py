from decimal import Decimal
from app.models.schemas import (
    CatalogItemVector,
    RecommendationRequest,
    RecommendationResponse,
    RecommendationResultItem,
)

# Deterministic synthetic dataset used ONLY when GET /recommendations/{customer_id}
# is called standalone without an explicit Express catalog vector payload.
SYNTHETIC_CATALOG: list[CatalogItemVector] = [
    CatalogItemVector(product_id="syn-prod-1", category_id="audio-studio", title="Apex Studio Pro ANC Headphones", popularity_score=95.0, price=Decimal("249.00")),
    CatalogItemVector(product_id="syn-prod-2", category_id="electronics", title="Apex KeyForge 75% Mechanical Keyboard", popularity_score=88.0, price=Decimal("169.00")),
    CatalogItemVector(product_id="syn-prod-3", category_id="accessories", title="Apex ThunderDock 11-in-1 USB-C Hub", popularity_score=82.0, price=Decimal("89.00")),
    CatalogItemVector(product_id="syn-prod-4", category_id="home-office", title="Nordic Solis Architect Desk Lamp", popularity_score=79.0, price=Decimal("139.00")),
    CatalogItemVector(product_id="syn-prod-5", category_id="home-office", title="Fjord Ergonomic Oak Monitor Riser", popularity_score=74.0, price=Decimal("119.00")),
    CatalogItemVector(product_id="syn-prod-6", category_id="accessories", title="Vester Merino Felt Desk Mat", popularity_score=70.0, price=Decimal("49.00")),
]

SYNTHETIC_CUSTOMER_HISTORY: dict[str, tuple[list[str], list[str]]] = {
    "demo-customer-audio": (["syn-prod-1"], ["audio-studio", "electronics"]),
    "demo-customer-office": (["syn-prod-4"], ["home-office", "accessories"]),
}


def _tokenize(text: str) -> set[str]:
    return {w for w in text.lower().split() if len(w) > 2}


def generate_recommendations(req: RecommendationRequest) -> RecommendationResponse:
    catalog = req.catalog if req.catalog else SYNTHETIC_CATALOG
    purchased_set = set(req.purchased_product_ids)
    viewed_cats = set(req.viewed_category_ids)

    anchor_item = next((c for c in catalog if req.product_id and c.product_id == req.product_id), None)
    anchor_tokens = _tokenize(anchor_item.title) if anchor_item else set()

    has_history = bool(purchased_set or viewed_cats)
    candidates = [c for c in catalog if c.product_id != req.product_id and c.product_id not in purchased_set]

    if not has_history and anchor_item is None:
        # Strict deterministic cold-start fallback — never invents purchase history
        ranked = sorted(candidates, key=lambda c: (-c.popularity_score, c.product_id))[: req.limit]
        return RecommendationResponse(
            customer_id=req.customer_id,
            strategy="deterministic-cold-start-popularity",
            recommendations=[
                RecommendationResultItem(
                    product_id=c.product_id,
                    score=round(c.popularity_score, 4),
                    reason="Popular marketplace pick (no customer history available)",
                )
                for c in ranked
            ],
        )

    scored: list[tuple[float, str, str]] = []
    for item in candidates:
        score = item.popularity_score * 0.4
        reasons: list[str] = []

        if item.category_id in viewed_cats:
            score += 35.0
            reasons.append("Matches your recent category interest")

        if anchor_item is not None:
            if item.category_id == anchor_item.category_id:
                score += 40.0
                reasons.append("Same category as viewed product")
            overlap = len(anchor_tokens & _tokenize(item.title))
            if overlap > 0:
                score += overlap * 12.0
                reasons.append("Similar product attributes")
            if anchor_item.price > Decimal("0") and item.price > Decimal("0"):
                ratio = float(min(anchor_item.price, item.price) / max(anchor_item.price, item.price))
                score += ratio * 10.0

        if not reasons:
            reasons.append("High overall marketplace demand")

        scored.append((round(score, 4), item.product_id, "; ".join(reasons)))

    scored.sort(key=lambda tup: (-tup[0], tup[1]))
    top = scored[: req.limit]
    strategy = "hybrid-personalized-similarity" if has_history else "item-similarity-popularity"

    return RecommendationResponse(
        customer_id=req.customer_id,
        strategy=strategy,
        recommendations=[
            RecommendationResultItem(product_id=pid, score=sc, reason=reason)
            for sc, pid, reason in top
        ],
    )
