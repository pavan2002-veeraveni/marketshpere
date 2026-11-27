'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { Trash2, Tag, ArrowRight } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, EmptyState, Skeleton } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast, setCartCount } from '@/store';
import { ApiEnvelope, CartData } from '@/types/api';

export default function CartPage() {
  const router = useRouter();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');

  const cartQuery = useQuery({
    queryKey: ['cart', appliedCoupon],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<CartData>>('/cart', {
        params: appliedCoupon ? { discountCode: appliedCoupon } : {},
      });
      dispatch(setCartCount(res.data.data.items.length));
      return res.data.data;
    },
  });

  const updateQty = useMutation({
    mutationFn: async ({ itemId, quantity }: { itemId: string; quantity: number }) => {
      const res = await apiClient.patch<ApiEnvelope<CartData>>(`/cart/items/${itemId}`, { quantity });
      return res.data.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cart'] }),
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const removeItem = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiClient.delete<ApiEnvelope<CartData>>(`/cart/items/${itemId}`);
      return res.data.data;
    },
    onSuccess: (data) => {
      dispatch(setCartCount(data.items.length));
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      dispatch(pushToast({ type: 'info', message: 'Item removed from cart' }));
    },
  });

  const cart = cartQuery.data;

  return (
    <AppShell>
      <ProtectedRoute>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'Shopping Cart' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Shopping Cart</h1>

        {cartQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : cartQuery.isError ? (
          <EmptyState
            title="Coupon or cart validation error"
            description={extractErrorMessage(cartQuery.error)}
            action={<Button onClick={() => setAppliedCoupon('')}>Clear coupon</Button>}
          />
        ) : !cart || cart.items.length === 0 ? (
          <EmptyState
            title="Your cart is empty"
            description="Browse products from verified sellers to begin checkout."
            action={
              <Link href="/">
                <Button>Browse Marketplace</Button>
              </Link>
            }
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-3">
              {cart.items.map((item) => (
                <Card key={item.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="h-16 w-16 rounded-lg bg-slate-100 overflow-hidden shrink-0">
                      {item.sku.product.images[0]?.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.sku.product.images[0].url}
                          alt={item.sku.product.title}
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div>
                      <Link
                        href={`/products/${item.sku.product.slug}`}
                        className="font-semibold text-slate-900 hover:text-blue-700"
                      >
                        {item.sku.product.title}
                      </Link>
                      <p className="text-xs text-slate-500">
                        SKU: <code>{item.sku.skuCode}</code> &bull; Seller: {item.sku.product.seller.storeName}
                      </p>
                      <p className="text-sm font-bold text-slate-900 mt-1">${item.currentUnitPrice} each</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex items-center rounded-lg border border-slate-300">
                      <button
                        type="button"
                        disabled={item.quantity <= 1 || updateQty.isPending}
                        onClick={() => updateQty.mutate({ itemId: item.id, quantity: item.quantity - 1 })}
                        className="px-2.5 py-1 text-sm font-bold hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
                      >
                        -
                      </button>
                      <span className="px-3 text-sm font-semibold">{item.quantity}</span>
                      <button
                        type="button"
                        disabled={item.quantity >= item.availableQty || updateQty.isPending}
                        onClick={() => updateQty.mutate({ itemId: item.id, quantity: item.quantity + 1 })}
                        className="px-2.5 py-1 text-sm font-bold hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
                      >
                        +
                      </button>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => removeItem.mutate(item.id)} aria-label="Remove">
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>

            <Card className="p-6 h-fit space-y-4">
              <h2 className="text-lg font-bold text-slate-900">Order Summary</h2>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedCoupon(couponInput.trim().toUpperCase());
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Tag className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value)}
                    placeholder="Coupon (e.g. WELCOME10)"
                    className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-xs uppercase"
                  />
                </div>
                <Button type="submit" variant="secondary" size="sm">
                  Apply
                </Button>
              </form>

              <dl className="space-y-2 border-t border-slate-200 pt-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-600">Subtotal</dt>
                  <dd className="font-medium">${cart.pricing.subtotalAmount}</dd>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <dt>Discount</dt>
                  <dd>-${cart.pricing.discountAmount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">Estimated Tax</dt>
                  <dd>${cart.pricing.taxAmount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">Shipping</dt>
                  <dd>${cart.pricing.shippingAmount}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-3 text-base font-bold text-slate-900">
                  <dt>Total</dt>
                  <dd>${cart.pricing.totalAmount}</dd>
                </div>
              </dl>

              <p className="text-[11px] text-slate-400">Pricing engine: {cart.pricing.source}</p>

              <Button
                className="w-full"
                size="lg"
                disabled={cart.stockIssues.length > 0}
                onClick={() =>
                  router.push(appliedCoupon ? `/checkout?coupon=${encodeURIComponent(appliedCoupon)}` : '/checkout')
                }
              >
                Proceed to Checkout <ArrowRight className="h-4 w-4" />
              </Button>
            </Card>
          </div>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
