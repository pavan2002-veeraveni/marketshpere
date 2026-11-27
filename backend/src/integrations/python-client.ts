import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../common/logger';
import { addMoney, money, mulMoney, minMoney, maxMoney } from '../common/decimal';

export interface PricingLineInput {
  productId: string;
  skuId: string;
  skuCode: string;
  sellerId: string;
  categoryId: string;
  unitPrice: string;
  quantity: number;
}

export interface PromotionInput {
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  value: string;
  sellerId?: string | null;
  minCartAmount?: string | null;
  maxDiscountAmount?: string | null;
}

export interface PricingCalculationResponse {
  currency: string;
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  items: Array<{
    skuId: string;
    skuCode: string;
    unitPrice: string;
    quantity: number;
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
  }>;
  source: 'python-fastapi' | 'deterministic-fallback';
}

export interface RecommendationItem {
  productId: string;
  score: number;
  reason: string;
}

class PythonServiceClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.PYTHON_SERVICE_URL,
      timeout: env.PYTHON_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': env.INTERNAL_SERVICE_TOKEN,
      },
    });
  }

  private async postWithRetry<T>(url: string, data: unknown, requestId?: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.client.post<T>(url, data, {
          headers: requestId ? { 'X-Request-ID': requestId } : undefined,
        });
        return res.data;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
    throw lastError;
  }

  async calculatePricing(params: {
    items: PricingLineInput[];
    promotion?: PromotionInput | null;
    taxRate?: string;
    requestId?: string;
  }): Promise<PricingCalculationResponse> {
    const taxRate = params.taxRate ?? env.DEFAULT_TAX_RATE;
    try {
      const resp = await this.postWithRetry<PricingCalculationResponse>(
        '/api/v1/pricing/calculate',
        {
          currency: env.DEFAULT_CURRENCY,
          tax_rate: taxRate,
          items: params.items.map((i) => ({
            product_id: i.productId,
            sku_id: i.skuId,
            sku_code: i.skuCode,
            seller_id: i.sellerId,
            category_id: i.categoryId,
            unit_price: i.unitPrice,
            quantity: i.quantity,
          })),
          promotion: params.promotion
            ? {
                code: params.promotion.code,
                discount_type: params.promotion.discountType,
                value: params.promotion.value,
                seller_id: params.promotion.sellerId ?? null,
                min_cart_amount: params.promotion.minCartAmount ?? null,
                max_discount_amount: params.promotion.maxDiscountAmount ?? null,
              }
            : null,
        },
        params.requestId,
      );
      return { ...resp, source: 'python-fastapi' };
    } catch (err) {
      logger.warn(
        { requestId: params.requestId, err: err instanceof Error ? err.message : String(err) },
        'Python pricing service unavailable; using deterministic Decimal fallback',
      );
      return this.fallbackPricing(params.items, params.promotion ?? null, taxRate);
    }
  }

  private fallbackPricing(
    items: PricingLineInput[],
    promotion: PromotionInput | null,
    taxRate: string,
  ): PricingCalculationResponse {
    const lineSubtotals = items.map((i) => mulMoney(i.unitPrice, i.quantity));
    const subtotal = addMoney(...lineSubtotals);

    let totalDiscount = money('0');
    if (promotion) {
      const eligibleSubtotal = promotion.sellerId
        ? addMoney(
            ...items
              .filter((i) => i.sellerId === promotion.sellerId)
              .map((i) => mulMoney(i.unitPrice, i.quantity)),
          )
        : subtotal;

      if (!promotion.minCartAmount || subtotal.gte(money(promotion.minCartAmount))) {
        if (promotion.discountType === 'PERCENTAGE') {
          totalDiscount = mulMoney(eligibleSubtotal, money(promotion.value).div(100));
        } else {
          totalDiscount = minMoney(eligibleSubtotal, promotion.value);
        }
        if (promotion.maxDiscountAmount) {
          totalDiscount = minMoney(totalDiscount, promotion.maxDiscountAmount);
        }
        totalDiscount = minMoney(totalDiscount, eligibleSubtotal);
      }
    }

    const shipping = subtotal.gte(money('150.00')) || subtotal.eq(0) ? money('0.00') : money('9.99');
    let allocatedDiscount = money('0');
    const pricedItems = items.map((item, idx) => {
      const lineSub = lineSubtotals[idx]!;
      let lineDisc = money('0');
      if (totalDiscount.gt(0) && subtotal.gt(0)) {
        if (idx === items.length - 1) {
          lineDisc = maxMoney('0', totalDiscount.minus(allocatedDiscount));
        } else {
          lineDisc = totalDiscount.times(lineSub).div(subtotal).toDecimalPlaces(2);
          allocatedDiscount = allocatedDiscount.plus(lineDisc);
        }
      }
      const taxable = maxMoney('0', lineSub.minus(lineDisc));
      const lineTax = mulMoney(taxable, taxRate);
      const lineTotal = taxable.plus(lineTax).toDecimalPlaces(2);
      return {
        skuId: item.skuId,
        skuCode: item.skuCode,
        unitPrice: money(item.unitPrice).toFixed(2),
        quantity: item.quantity,
        subtotal: lineSub.toFixed(2),
        discountAmount: lineDisc.toFixed(2),
        taxAmount: lineTax.toFixed(2),
        lineTotal: lineTotal.toFixed(2),
      };
    });

    const taxAmount = addMoney(...pricedItems.map((i) => i.taxAmount));
    const totalAmount = subtotal.minus(totalDiscount).plus(taxAmount).plus(shipping).toDecimalPlaces(2);

    return {
      currency: env.DEFAULT_CURRENCY,
      subtotalAmount: subtotal.toFixed(2),
      discountAmount: totalDiscount.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      shippingAmount: shipping.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      items: pricedItems,
      source: 'deterministic-fallback',
    };
  }

  async processFeed(payload: { format: 'csv' | 'json'; content: string; requestId?: string }) {
    const res = await this.postWithRetry<{
      total_rows: number;
      valid_rows: number;
      invalid_rows: number;
      duplicate_skus: string[];
      normalized_items: Array<{
        title: string;
        sku_code: string;
        price: string;
        category_slug: string;
        quantity: number;
        description: string;
        brand?: string;
      }>;
      errors: Array<{ row: number; message: string }>;
    }>('/api/v1/feeds/process', { format: payload.format, content: payload.content }, payload.requestId);
    return res;
  }

  async getRecommendations(payload: {
    customerId?: string;
    productId?: string;
    catalog: Array<{ product_id: string; category_id: string; title: string; popularity_score: number; price: string }>;
    purchasedProductIds: string[];
    viewedCategoryIds: string[];
    limit?: number;
    requestId?: string;
  }): Promise<{ recommendations: RecommendationItem[]; strategy: string }> {
    try {
      const res = await this.postWithRetry<{
        recommendations: Array<{ product_id: string; score: number; reason: string }>;
        strategy: string;
      }>(
        '/api/v1/recommendations',
        {
          customer_id: payload.customerId ?? null,
          product_id: payload.productId ?? null,
          catalog: payload.catalog,
          purchased_product_ids: payload.purchasedProductIds,
          viewed_category_ids: payload.viewedCategoryIds,
          limit: payload.limit ?? 6,
        },
        payload.requestId,
      );
      return {
        recommendations: res.recommendations.map((r) => ({
          productId: r.product_id,
          score: r.score,
          reason: r.reason,
        })),
        strategy: res.strategy,
      };
    } catch {
      const fallback = payload.catalog
        .filter((c) => c.product_id !== payload.productId)
        .sort((a, b) => b.popularity_score - a.popularity_score)
        .slice(0, payload.limit ?? 6)
        .map((c) => ({
          productId: c.product_id,
          score: c.popularity_score,
          reason: 'Popular marketplace item (deterministic fallback)',
        }));
      return { recommendations: fallback, strategy: 'popularity-fallback' };
    }
  }
}

export const pythonClient = new PythonServiceClient();
