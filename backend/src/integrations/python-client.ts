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

export interface CommissionLineCalcInput {
  orderItemId: string;
  sellerId: string;
  categoryId: string;
  unitPrice: string;
  quantity: number;
  discountAmount: string;
  sellerRateOverride?: string | null;
}

export interface CommissionRuleCalcInput {
  ruleId?: string | null;
  name: string;
  sellerId?: string | null;
  categoryId?: string | null;
  commissionType: 'PERCENTAGE' | 'FIXED' | 'HYBRID';
  percentageRate: string;
  fixedAmount: string;
  priority: number;
}

export interface CommissionCalcResultItem {
  orderItemId: string;
  sellerId: string;
  grossAmount: string;
  discountAllocated: string;
  netCommissionableAmount: string;
  commissionAmount: string;
  netSellerAmount: string;
  appliedRule: string;
  explanation: string;
}

class PythonServiceClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.PYTHON_SERVICE_URL.replace(/\/+$/, ''),
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

  async processFeedUpload(payload: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    requestId?: string;
  }) {
    const base = env.PYTHON_SERVICE_URL.replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(payload.buffer)], { type: payload.mimeType }), payload.filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.PYTHON_TIMEOUT_MS);
    try {
      const resp = await fetch(`${base}/api/v1/feeds/upload`, {
        method: 'POST',
        headers: {
          'X-Internal-Service-Token': env.INTERNAL_SERVICE_TOKEN,
          ...(payload.requestId ? { 'X-Request-ID': payload.requestId } : {}),
        },
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`Python /feeds/upload returned ${resp.status}`);
      }
      return (await resp.json()) as {
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
      };
    } catch (err) {
      logger.warn(
        { requestId: payload.requestId, err: err instanceof Error ? err.message : String(err) },
        'Python multipart /feeds/upload failed; falling back to /feeds/process',
      );
      const format = payload.filename.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
      return this.processFeed({ format, content: payload.buffer.toString('utf8'), requestId: payload.requestId });
    } finally {
      clearTimeout(timer);
    }
  }

  async calculateCommissions(params: {
    items: CommissionLineCalcInput[];
    rules: CommissionRuleCalcInput[];
    requestId?: string;
  }): Promise<{
    items: CommissionCalcResultItem[];
    totalCommission: string;
    totalNetSeller: string;
    source: 'python-fastapi' | 'deterministic-fallback';
  }> {
    if (params.items.length === 0) {
      return { items: [], totalCommission: '0.00', totalNetSeller: '0.00', source: 'deterministic-fallback' };
    }

    try {
      const resp = await this.postWithRetry<{
        total_commission: string;
        total_net_seller: string;
        items: Array<{
          order_item_id: string;
          seller_id: string;
          gross_amount: string;
          discount_allocated: string;
          net_commissionable_amount: string;
          commission_amount: string;
          net_seller_amount: string;
          applied_rule: string;
          explanation: string;
        }>;
      }>(
        '/api/v1/commissions/calculate',
        {
          items: params.items.map((i) => ({
            order_item_id: i.orderItemId,
            seller_id: i.sellerId,
            category_id: i.categoryId,
            unit_price: i.unitPrice,
            quantity: i.quantity,
            discount_amount: i.discountAmount,
            seller_rate_override: i.sellerRateOverride ?? null,
          })),
          rules: params.rules.map((r) => ({
            rule_id: r.ruleId ?? null,
            name: r.name,
            seller_id: r.sellerId ?? null,
            category_id: r.categoryId ?? null,
            commission_type: r.commissionType,
            percentage_rate: r.percentageRate,
            fixed_amount: r.fixedAmount,
            priority: r.priority,
          })),
        },
        params.requestId,
      );
      return {
        items: resp.items.map((i) => ({
          orderItemId: i.order_item_id,
          sellerId: i.seller_id,
          grossAmount: i.gross_amount,
          discountAllocated: i.discount_allocated,
          netCommissionableAmount: i.net_commissionable_amount,
          commissionAmount: i.commission_amount,
          netSellerAmount: i.net_seller_amount,
          appliedRule: i.applied_rule,
          explanation: i.explanation,
        })),
        totalCommission: resp.total_commission,
        totalNetSeller: resp.total_net_seller,
        source: 'python-fastapi',
      };
    } catch (err) {
      logger.warn(
        { requestId: params.requestId, err: err instanceof Error ? err.message : String(err) },
        'Python commission service unavailable; using deterministic Decimal fallback',
      );
      return this.fallbackCommissions(params.items, params.rules);
    }
  }

  private fallbackCommissions(items: CommissionLineCalcInput[], rules: CommissionRuleCalcInput[]) {
    const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);
    const out: CommissionCalcResultItem[] = [];
    for (const item of items) {
      const grossBeforeDiscount = mulMoney(item.unitPrice, item.quantity);
      const discountAllocated = money(item.discountAmount);
      const netBase = maxMoney('0.00', grossBeforeDiscount.minus(discountAllocated));

      const rule =
        sortedRules.find((r) => r.sellerId === item.sellerId && r.categoryId === item.categoryId) ??
        sortedRules.find((r) => r.sellerId === item.sellerId && !r.categoryId) ??
        sortedRules.find((r) => !r.sellerId && r.categoryId === item.categoryId) ??
        sortedRules.find((r) => !r.sellerId && !r.categoryId);

      let commissionAmount = money('0.00');
      let appliedRule = 'Default Platform 10%';
      if (item.sellerRateOverride !== null && item.sellerRateOverride !== undefined) {
        commissionAmount = mulMoney(netBase, item.sellerRateOverride);
        appliedRule = `Seller Override (${item.sellerRateOverride})`;
      } else if (rule) {
        const pctPart = rule.commissionType === 'FIXED' ? money('0.00') : mulMoney(netBase, rule.percentageRate);
        const fixedPart = rule.commissionType === 'PERCENTAGE' ? money('0.00') : mulMoney(rule.fixedAmount, item.quantity);
        commissionAmount = addMoney(pctPart, fixedPart);
        appliedRule = rule.name;
      } else {
        commissionAmount = mulMoney(netBase, '0.1000');
      }
      commissionAmount = minMoney(commissionAmount, netBase);
      const netSellerAmount = maxMoney('0.00', netBase.minus(commissionAmount));

      out.push({
        orderItemId: item.orderItemId,
        sellerId: item.sellerId,
        grossAmount: netBase.toFixed(2),
        discountAllocated: discountAllocated.toFixed(2),
        netCommissionableAmount: netBase.toFixed(2),
        commissionAmount: commissionAmount.toFixed(2),
        netSellerAmount: netSellerAmount.toFixed(2),
        appliedRule,
        explanation: `Deterministic fallback (${appliedRule})`,
      });
    }
    return {
      items: out,
      totalCommission: addMoney(...out.map((o) => o.commissionAmount)).toFixed(2),
      totalNetSeller: addMoney(...out.map((o) => o.netSellerAmount)).toFixed(2),
      source: 'deterministic-fallback' as const,
    };
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
