import math
from decimal import Decimal

from app.models.schemas import (
    RecommendationRequest,
    RecommendationResponse,
    RecommendationResultItem,
)


def _tokenize(text: str) -> set[str]:
    return {w for w in text.lower().split() if len(w) > 2}


def evaluate_ranking_metrics(
    recommended_ids: list[str],
    relevant_ids: set[str],
    k: int = 5,
) -> dict[str, float]:
    """Compute offline ranking quality metrics (Precision@K, Recall@K, NDCG@K)."""
    top_k = recommended_ids[:k]
    if not top_k:
        return {"precision_at_k": 0.0, "recall_at_k": 0.0, "ndcg_at_k": 0.0}

    hits = [1.0 if pid in relevant_ids else 0.0 for pid in top_k]
    precision = sum(hits) / len(top_k)
    recall = sum(hits) / len(relevant_ids) if relevant_ids else 0.0

    dcg = sum(rel / math.log2(idx + 2) for idx, rel in enumerate(hits))
    ideal_len = min(len(top_k), len(relevant_ids))
    idcg = sum(1.0 / math.log2(idx + 2) for idx in range(ideal_len))
    ndcg = (dcg / idcg) if idcg > 0 else 0.0
    return {
        "precision_at_k": round(precision, 4),
        "recall_at_k": round(recall, 4),
        "ndcg_at_k": round(ndcg, 4),
    }


def generate_recommendations(req: RecommendationRequest) -> RecommendationResponse:
    catalog = req.catalog
    if not catalog:
        return RecommendationResponse(
            customer_id=req.customer_id,
            strategy="stateless-catalog-required",
            recommendations=[],
        )

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
            item_tokens = _tokenize(item.title)
            union_tokens = anchor_tokens | item_tokens
            if union_tokens:
                jaccard = len(anchor_tokens & item_tokens) / len(union_tokens)
                if jaccard > 0:
                    score += round(jaccard * 30.0, 4)
                    reasons.append("Similar product attributes")
            if anchor_item.price > Decimal(0) and item.price > Decimal(0):
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
