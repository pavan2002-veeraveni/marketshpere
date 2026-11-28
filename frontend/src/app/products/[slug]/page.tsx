'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch, useSelector } from 'react-redux';
import { ShoppingCart, Star, CheckCircle2, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Breadcrumbs, Button, Card, Skeleton, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast, RootState, setCartCount } from '@/store';
import { ApiEnvelope, OrderRecord, ProductItem } from '@/types/api';

export default function ProductDetailPage() {
  const params = useParams<{ slug: string }>();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const user = useSelector((s: RootState) => s.auth.user);

  const [selectedSkuId, setSelectedSkuId] = useState<string>('');
  const [quantity, setQuantity] = useState(1);
  const [reviewOrderId, setReviewOrderId] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewComment, setReviewComment] = useState('');

  const productQuery = useQuery({
    queryKey: ['product', params.slug],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<ProductItem>>(`/products/${params.slug}`);
      return res.data.data;
    },
  });

  const product = productQuery.data;

  const recsQuery = useQuery({
    queryKey: ['product-recs', product?.id],
    enabled: Boolean(product?.id),
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<{ strategy: string; items: ProductItem[] }>>(
        `/products/${product!.id}/recommendations`,
      );
      return res.data.data;
    },
  });

  const deliveredOrdersQuery = useQuery({
    queryKey: ['my-delivered-orders-for-review', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders', {
        params: { status: 'DELIVERED', limit: 20 },
      });
      return res.data.data;
    },
  });

  const addToCart = useMutation({
    mutationFn: async () => {
      const targetSkuId =
        product?.skus.find((s) => s.id === selectedSkuId)?.id ?? product?.skus[0]?.id;
      const res = await apiClient.post<ApiEnvelope<{ items: unknown[] }>>('/cart/items', {
        skuId: targetSkuId,
        quantity,
      });
      return res.data.data;
    },
    onSuccess: (data) => {
      dispatch(setCartCount(data.items.length));
      dispatch(pushToast({ type: 'success', message: 'Added to cart!' }));
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (err) => {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err, 'Could not add to cart') }));
    },
  });

  const submitReview = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/products/${product!.id}/reviews`, {
        orderId: reviewOrderId,
        rating: reviewRating,
        title: reviewTitle,
        comment: reviewComment,
      });
    },
    onSuccess: () => {
      dispatch(pushToast({ type: 'success', message: 'Verified review submitted!' }));
      setReviewTitle('');
      setReviewComment('');
      queryClient.invalidateQueries({ queryKey: ['product', params.slug] });
    },
    onError: (err) => {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) }));
    },
  });

  if (productQuery.isLoading) {
    return (
      <AppShell>
        <div className="grid gap-8 md:grid-cols-2">
          <Skeleton className="h-96" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-12 w-48" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (!product) {
    return (
      <AppShell>
        <Card className="p-8 text-center">
          <h1 className="text-xl font-bold">Product not found</h1>
          <Link href="/" className="mt-4 inline-block text-blue-700 hover:underline">
            Return to catalog
          </Link>
        </Card>
      </AppShell>
    );
  }

  const activeSku = product.skus.find((s) => s.id === selectedSkuId) ?? product.skus[0];
  const availableQty = activeSku?.availableQty ?? 0;

  const eligibleOrders =
    deliveredOrdersQuery.data?.filter((ord) => ord.items.some((i) => i.productId === product.id)) ?? [];

  return (
    <AppShell>
      <Breadcrumbs
        items={[
          { label: 'Storefront', href: '/' },
          { label: product.category?.name ?? 'Catalog' },
          { label: product.title },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-2">
        <Card className="overflow-hidden bg-slate-100 h-96 flex items-center justify-center">
          {product.images[0]?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.images[0].url} alt={product.title} className="h-full w-full object-cover" />
          ) : (
            <span className="text-slate-400">No product image</span>
          )}
        </Card>

        <div className="space-y-5">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-blue-700">{product.category?.name}</span>
              <span>&bull;</span>
              <span>Sold by {product.seller?.storeName}</span>
            </div>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">{product.title}</h1>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 font-semibold text-amber-600">
                <Star className="h-4 w-4 fill-amber-500" />
                {product.averageRating ? product.averageRating.toFixed(1) : 'No ratings yet'}
              </span>
              <span className="text-slate-500">({product.reviewCount ?? 0} verified reviews)</span>
            </div>
          </div>

          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-extrabold text-slate-900">${activeSku?.price ?? '0.00'}</span>
            {activeSku?.compareAtPrice && (
              <span className="text-base text-slate-400 line-through">${activeSku.compareAtPrice}</span>
            )}
            <StatusBadge status={availableQty > 0 ? `${availableQty} AVAILABLE` : 'OUT OF STOCK'} />
          </div>

          <p className="text-sm leading-relaxed text-slate-600">{product.description}</p>

          {/* Variant / SKU Selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Select Variant / SKU
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {product.skus.map((sku) => (
                <button
                  key={sku.id}
                  type="button"
                  onClick={() => setSelectedSkuId(sku.id)}
                  className={`rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                    sku.id === activeSku?.id
                      ? 'border-blue-700 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {sku.variant?.name ?? sku.skuCode} &bull; ${sku.price}
                </button>
              ))}
            </div>
            {activeSku && (
              <p className="mt-1.5 text-xs text-slate-500">
                SKU Code: <code>{activeSku.skuCode}</code>
              </p>
            )}
          </div>

          {/* Quantity + Add to Cart */}
          <div className="flex items-center gap-3 pt-2">
            <input
              type="number"
              min={1}
              max={Math.max(1, availableQty)}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
              aria-label="Quantity"
              className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm text-center"
            />
            <Button
              size="lg"
              disabled={!activeSku || availableQty <= 0 || addToCart.isPending}
              onClick={() => addToCart.mutate()}
              className="flex-1"
            >
              <ShoppingCart className="h-4 w-4" />
              {addToCart.isPending ? 'Adding...' : 'Add to Cart'}
            </Button>
          </div>

          {product.attributes && product.attributes.length > 0 && (
            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Specifications</h3>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                {product.attributes.map((attr) => (
                  <React.Fragment key={attr.id}>
                    <dt className="text-slate-500">{attr.name}</dt>
                    <dd className="font-medium text-slate-900">{attr.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </Card>
          )}
        </div>
      </div>

      {/* Reviews */}
      <section className="mt-12 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="text-xl font-bold text-slate-900 mb-4">Customer Reviews</h2>
          {!product.reviews?.length ? (
            <Card className="p-6 text-sm text-slate-500">No reviews yet for this product.</Card>
          ) : (
            <div className="space-y-3">
              {product.reviews.map((rev) => (
                <Card key={rev.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-slate-900">{rev.title}</span>
                    <span className="text-xs font-bold text-amber-600">{rev.rating} / 5</span>
                  </div>
                  <p className="mt-1.5 text-sm text-slate-600">{rev.comment}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                    <span>
                      {rev.user.firstName} {rev.user.lastName}
                    </span>
                    {rev.isVerifiedPurchase && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                        <CheckCircle2 className="h-3 w-3" /> Verified Purchase
                      </span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-xl font-bold text-slate-900 mb-4">Write a Verified Review</h2>
          <Card className="p-5">
            {!user ? (
              <p className="text-sm text-slate-600">
                <Link href="/login" className="text-blue-700 font-semibold hover:underline">
                  Sign in
                </Link>{' '}
                to review products from delivered orders.
              </p>
            ) : eligibleOrders.length === 0 ? (
              <p className="text-sm text-slate-500">
                Verified reviews require a delivered order containing this product.
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitReview.mutate();
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-xs font-medium text-slate-700">Delivered Order</label>
                  <select
                    required
                    value={reviewOrderId}
                    onChange={(e) => setReviewOrderId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                  >
                    <option value="">Select order...</option>
                    {eligibleOrders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.orderNumber}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Rating</label>
                  <select
                    value={reviewRating}
                    onChange={(e) => setReviewRating(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                  >
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {n} Star{n > 1 ? 's' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Review Title</label>
                  <input
                    required
                    value={reviewTitle}
                    onChange={(e) => setReviewTitle(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Review Comment</label>
                  <textarea
                    required
                    rows={3}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <Button type="submit" disabled={submitReview.isPending}>
                  Submit Verified Review
                </Button>
              </form>
            )}
          </Card>
        </div>
      </section>

      {/* Similar Recommendations */}
      {recsQuery.data && recsQuery.data.items.length > 0 && (
        <section className="mt-12">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-700" />
            <h2 className="text-xl font-bold text-slate-900">Similar & Related Products</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {recsQuery.data.items.slice(0, 3).map((rec) => (
              <Card key={rec.id} className="p-4">
                <Link href={`/products/${rec.slug}`} className="font-semibold text-sm text-slate-900 hover:text-blue-700">
                  {rec.title}
                </Link>
                <p className="mt-1 text-xs text-slate-500">{rec.recommendationReason}</p>
                <p className="mt-2 font-bold text-sm">${rec.skus?.[0]?.price ?? '0.00'}</p>
              </Card>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
