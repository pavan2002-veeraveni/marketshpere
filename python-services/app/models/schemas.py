from decimal import Decimal, ROUND_HALF_UP
from typing import Literal
from pydantic import BaseModel, Field, field_validator


TWO_PLACES = Decimal("0.01")


def q2(value: Decimal) -> Decimal:
    return value.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def fmt2(value: Decimal) -> str:
    return f"{q2(value):.2f}"


class PricingItemInput(BaseModel):
    product_id: str
    sku_id: str
    sku_code: str
    seller_id: str
    category_id: str
    unit_price: Decimal = Field(..., ge=Decimal("0"))
    quantity: int = Field(..., gt=0, le=1000)


class PromotionInput(BaseModel):
    code: str
    discount_type: Literal["PERCENTAGE", "FIXED"]
    value: Decimal = Field(..., gt=Decimal("0"))
    seller_id: str | None = None
    min_cart_amount: Decimal | None = None
    max_discount_amount: Decimal | None = None


class PricingCalculateRequest(BaseModel):
    currency: str = Field(default="USD", min_length=3, max_length=3)
    tax_rate: Decimal = Field(default=Decimal("0.0825"), ge=Decimal("0"), le=Decimal("0.5"))
    items: list[PricingItemInput] = Field(..., min_length=1)
    promotion: PromotionInput | None = None


class PricedLineItem(BaseModel):
    skuId: str
    skuCode: str
    unitPrice: str
    quantity: int
    subtotal: str
    discountAmount: str
    taxAmount: str
    lineTotal: str


class PricingCalculateResponse(BaseModel):
    currency: str
    roundingPolicy: str = "ROUND_HALF_UP_2DP"
    subtotalAmount: str
    discountAmount: str
    taxAmount: str
    shippingAmount: str
    totalAmount: str
    promotionApplied: bool
    calculationDetails: dict[str, str]
    items: list[PricedLineItem]


class CommissionRuleInput(BaseModel):
    rule_id: str | None = None
    name: str = "Default Rule"
    seller_id: str | None = None
    category_id: str | None = None
    commission_type: Literal["PERCENTAGE", "FIXED", "HYBRID"] = "PERCENTAGE"
    percentage_rate: Decimal = Field(default=Decimal("0.1000"), ge=Decimal("0"), le=Decimal("1"))
    fixed_amount: Decimal = Field(default=Decimal("0.00"), ge=Decimal("0"))
    priority: int = 100


class CommissionItemInput(BaseModel):
    order_item_id: str
    seller_id: str
    category_id: str
    unit_price: Decimal = Field(..., ge=Decimal("0"))
    quantity: int = Field(..., gt=0)
    discount_amount: Decimal = Field(default=Decimal("0.00"), ge=Decimal("0"))
    seller_rate_override: Decimal | None = Field(default=None, ge=Decimal("0"), le=Decimal("1"))


class CommissionCalculateRequest(BaseModel):
    items: list[CommissionItemInput] = Field(..., min_length=1)
    rules: list[CommissionRuleInput] = Field(default_factory=list)


class CommissionLineResult(BaseModel):
    order_item_id: str
    seller_id: str
    gross_amount: str
    discount_allocated: str
    net_commissionable_amount: str
    commission_amount: str
    net_seller_amount: str
    applied_rule: str
    explanation: str


class CommissionCalculateResponse(BaseModel):
    total_gross: str
    total_commission: str
    total_net_seller: str
    items: list[CommissionLineResult]


class FeedProcessRequest(BaseModel):
    format: Literal["csv", "json"]
    content: str = Field(..., min_length=1)

    @field_validator("format")
    @classmethod
    def check_format(cls, v: str) -> str:
        return v.lower()


class NormalizedFeedItem(BaseModel):
    title: str
    sku_code: str
    price: str
    category_slug: str
    quantity: int
    description: str
    brand: str | None = None


class FeedRowError(BaseModel):
    row: int
    sku_code: str | None = None
    message: str


class FeedProcessResponse(BaseModel):
    total_rows: int
    valid_rows: int
    invalid_rows: int
    duplicate_skus: list[str]
    normalized_items: list[NormalizedFeedItem]
    errors: list[FeedRowError]


class CatalogItemVector(BaseModel):
    product_id: str
    category_id: str
    title: str
    popularity_score: float = 1.0
    price: Decimal = Decimal("0.00")


class RecommendationRequest(BaseModel):
    customer_id: str | None = None
    product_id: str | None = None
    catalog: list[CatalogItemVector] = Field(default_factory=list)
    purchased_product_ids: list[str] = Field(default_factory=list)
    viewed_category_ids: list[str] = Field(default_factory=list)
    limit: int = Field(default=6, ge=1, le=50)


class RecommendationResultItem(BaseModel):
    product_id: str
    score: float
    reason: str


class RecommendationResponse(BaseModel):
    customer_id: str | None = None
    strategy: str
    recommendations: list[RecommendationResultItem]
