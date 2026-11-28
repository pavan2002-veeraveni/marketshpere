from decimal import Decimal

from app.core.config import settings
from app.models.schemas import (
    CommissionCalculateRequest,
    CommissionCalculateResponse,
    CommissionLineResult,
    PricedLineItem,
    PricingCalculateRequest,
    PricingCalculateResponse,
    fmt2,
    q2,
)


def calculate_pricing(req: PricingCalculateRequest) -> PricingCalculateResponse:
    line_subtotals = [q2(item.unit_price * item.quantity) for item in req.items]
    subtotal = q2(sum(line_subtotals, Decimal("0.00")))

    total_discount = Decimal("0.00")
    promotion_applied = False
    promo_note = "No promotion applied"

    if req.promotion is not None:
        promo = req.promotion
        eligible_indices = [
            idx
            for idx, item in enumerate(req.items)
            if promo.seller_id is None or item.seller_id == promo.seller_id
        ]
        eligible_subtotal = q2(sum((line_subtotals[i] for i in eligible_indices), Decimal("0.00")))

        if eligible_subtotal <= Decimal("0.00"):
            promo_note = f"Coupon {promo.code} has no eligible items"
        elif promo.min_cart_amount is not None and subtotal < promo.min_cart_amount:
            promo_note = f"Coupon {promo.code} requires minimum subtotal {fmt2(promo.min_cart_amount)}"
        else:
            if promo.discount_type == "PERCENTAGE":
                raw_disc = q2(eligible_subtotal * (promo.value / Decimal(100)))
            else:
                raw_disc = min(eligible_subtotal, q2(promo.value))

            if promo.max_discount_amount is not None:
                raw_disc = min(raw_disc, q2(promo.max_discount_amount))

            total_discount = min(raw_disc, eligible_subtotal)
            promotion_applied = total_discount > Decimal("0.00")
            promo_note = f"Applied {promo.code} ({promo.discount_type})"

    # Allocate discount across eligible items cleanly so line discounts sum exactly to total_discount
    eligible_total_for_alloc = Decimal("0.00")
    eligible_mask = []
    for idx, item in enumerate(req.items):
        is_elig = req.promotion is None or req.promotion.seller_id is None or item.seller_id == req.promotion.seller_id
        eligible_mask.append(is_elig)
        if is_elig:
            eligible_total_for_alloc += line_subtotals[idx]

    last_eligible_idx = max((idx for idx, ok in enumerate(eligible_mask) if ok), default=-1)
    allocated_so_far = Decimal("0.00")
    priced_items: list[PricedLineItem] = []

    for idx, item in enumerate(req.items):
        line_sub = line_subtotals[idx]
        line_disc = Decimal("0.00")
        if total_discount > Decimal("0.00") and eligible_mask[idx] and eligible_total_for_alloc > Decimal("0.00"):
            if idx == last_eligible_idx:
                line_disc = max(Decimal("0.00"), q2(total_discount - allocated_so_far))
            else:
                line_disc = q2(total_discount * line_sub / eligible_total_for_alloc)
                allocated_so_far += line_disc

        taxable = max(Decimal("0.00"), q2(line_sub - line_disc))
        line_tax = q2(taxable * req.tax_rate)
        line_total = q2(taxable + line_tax)

        priced_items.append(
            PricedLineItem(
                skuId=item.sku_id,
                skuCode=item.sku_code,
                unitPrice=fmt2(item.unit_price),
                quantity=item.quantity,
                subtotal=fmt2(line_sub),
                discountAmount=fmt2(line_disc),
                taxAmount=fmt2(line_tax),
                lineTotal=fmt2(line_total),
            )
        )

    total_tax = q2(sum((Decimal(p.taxAmount) for p in priced_items), Decimal("0.00")))
    free_threshold = Decimal(settings.free_shipping_threshold)
    shipping = (
        Decimal("0.00")
        if subtotal == Decimal("0.00") or subtotal >= free_threshold
        else Decimal(settings.flat_shipping_fee)
    )
    grand_total = q2(subtotal - total_discount + total_tax + shipping)

    return PricingCalculateResponse(
        currency=req.currency.upper(),
        subtotalAmount=fmt2(subtotal),
        discountAmount=fmt2(total_discount),
        taxAmount=fmt2(total_tax),
        shippingAmount=fmt2(shipping),
        totalAmount=fmt2(grand_total),
        promotionApplied=promotion_applied,
        calculationDetails={
            "taxRate": str(req.tax_rate),
            "freeShippingThreshold": fmt2(free_threshold),
            "promotionStatus": promo_note,
        },
        items=priced_items,
    )


def calculate_commissions(req: CommissionCalculateRequest) -> CommissionCalculateResponse:
    sorted_rules = sorted(req.rules, key=lambda r: r.priority)
    results: list[CommissionLineResult] = []
    total_gross = Decimal("0.00")
    total_commission = Decimal("0.00")
    total_net = Decimal("0.00")

    for item in req.items:
        gross = q2(item.unit_price * item.quantity)
        discount_alloc = q2(item.discount_amount)
        net_base = max(Decimal("0.00"), q2(gross - discount_alloc))

        if item.seller_rate_override is not None:
            commission = q2(net_base * item.seller_rate_override)
            applied_rule = f"Seller Override ({item.seller_rate_override * 100:.2f}%)"
            explanation = f"Applied seller-specific override rate {item.seller_rate_override} on {fmt2(net_base)}"
        else:
            rule = (
                next((r for r in sorted_rules if r.seller_id == item.seller_id and r.category_id == item.category_id), None)
                or next((r for r in sorted_rules if r.seller_id == item.seller_id and r.category_id is None), None)
                or next((r for r in sorted_rules if r.seller_id is None and r.category_id == item.category_id), None)
                or next((r for r in sorted_rules if r.seller_id is None and r.category_id is None), None)
            )
            if rule is None:
                commission = q2(net_base * Decimal("0.1000"))
                applied_rule = "Default Platform 10%"
                explanation = f"Applied fallback 10% commission on {fmt2(net_base)}"
            else:
                pct_part = (
                    Decimal("0.00")
                    if rule.commission_type == "FIXED"
                    else q2(net_base * rule.percentage_rate)
                )
                fixed_part = (
                    Decimal("0.00")
                    if rule.commission_type == "PERCENTAGE"
                    else q2(rule.fixed_amount * item.quantity)
                )
                commission = q2(pct_part + fixed_part)
                applied_rule = rule.name
                explanation = (
                    f"Rule '{rule.name}' ({rule.commission_type}): pct={fmt2(pct_part)} + fixed={fmt2(fixed_part)}"
                )

        commission = min(commission, net_base)
        net_seller = max(Decimal("0.00"), q2(net_base - commission))

        total_gross += net_base
        total_commission += commission
        total_net += net_seller

        results.append(
            CommissionLineResult(
                order_item_id=item.order_item_id,
                seller_id=item.seller_id,
                gross_amount=fmt2(gross),
                discount_allocated=fmt2(discount_alloc),
                net_commissionable_amount=fmt2(net_base),
                commission_amount=fmt2(commission),
                net_seller_amount=fmt2(net_seller),
                applied_rule=applied_rule,
                explanation=explanation,
            )
        )

    return CommissionCalculateResponse(
        total_gross=fmt2(total_gross),
        total_commission=fmt2(total_commission),
        total_net_seller=fmt2(total_net),
        items=results,
    )
