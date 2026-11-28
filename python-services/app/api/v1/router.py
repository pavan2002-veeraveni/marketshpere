from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile

from app.core.security import verify_internal_token
from app.models.schemas import (
    CommissionCalculateRequest,
    CommissionCalculateResponse,
    FeedProcessRequest,
    FeedProcessResponse,
    PricingCalculateRequest,
    PricingCalculateResponse,
    RecommendationRequest,
    RecommendationResponse,
)
from app.services.feed_service import process_product_feed
from app.services.pricing_service import calculate_commissions, calculate_pricing
from app.services.recommendation_service import generate_recommendations

router = APIRouter()


@router.get("/health", tags=["System"])
def health_check():
    return {"status": "ok", "service": "marketsphere-python"}


@router.post(
    "/pricing/calculate",
    response_model=PricingCalculateResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Pricing"],
)
def pricing_calculate_endpoint(payload: PricingCalculateRequest):
    return calculate_pricing(payload)


@router.post(
    "/commissions/calculate",
    response_model=CommissionCalculateResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Commissions"],
)
def commissions_calculate_endpoint(payload: CommissionCalculateRequest):
    return calculate_commissions(payload)


@router.post(
    "/feeds/process",
    response_model=FeedProcessResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Catalog Feeds"],
)
def feeds_process_endpoint(payload: FeedProcessRequest):
    return process_product_feed(payload.format, payload.content)


@router.post(
    "/feeds/upload",
    response_model=FeedProcessResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Catalog Feeds"],
)
async def feeds_upload_endpoint(file: Annotated[UploadFile, File()]):
    raw_bytes = await file.read(10 * 1024 * 1024)
    fmt = "csv" if (file.filename or "").lower().endswith(".csv") else "json"
    return process_product_feed(fmt, raw_bytes.decode("utf-8", errors="replace"))


@router.post(
    "/recommendations",
    response_model=RecommendationResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Recommendations"],
)
def recommendations_post_endpoint(payload: RecommendationRequest):
    return generate_recommendations(payload)


@router.get(
    "/recommendations/{customer_id}",
    response_model=RecommendationResponse,
    dependencies=[Depends(verify_internal_token)],
    tags=["Recommendations"],
)
def recommendations_get_endpoint(
    customer_id: str,
    product_id: Annotated[str | None, Query()] = None,
    purchased_product_ids: Annotated[str | None, Query()] = None,
    viewed_category_ids: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 6,
):
    purchased = [s.strip() for s in (purchased_product_ids or "").split(",") if s.strip()]
    viewed_cats = [s.strip() for s in (viewed_category_ids or "").split(",") if s.strip()]
    req = RecommendationRequest(
        customer_id=customer_id,
        product_id=product_id,
        catalog=[],
        purchased_product_ids=purchased,
        viewed_category_ids=viewed_cats,
        limit=limit,
    )
    return generate_recommendations(req)
