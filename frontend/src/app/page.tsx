'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch, useSelector } from 'react-redux';
import { Search, Sparkles, Star, ShoppingCart, SlidersHorizontal } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Card, EmptyState, Pagination, Skeleton, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast, RootState, setCartCount } from '@/store';
import { ApiEnvelope, CategoryItem, ProductItem } from '@/types/api';

export default function StorefrontHomePage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const user = useSelector((s: RootState) => s.auth.user);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inStock, setInStock] = useState(false);
  const [sortBy, setSortBy] = useState<'newest' | 'price_asc' | 'price_desc' | 'title'>('newest');

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<CategoryItem[]>>('/categories');
      return res.data.data;
    },
  });

  const productsQuery = useQuery({
    queryKey: ['products', page, search, categorySlug, minPrice, maxPrice, inStock, sortBy],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: 9, sortBy };
      if (search) params.search = search;
      if (categorySlug) params.categorySlug = categorySlug;
      if (minPrice) params.minPrice = minPrice;
      if (maxPrice) params.maxPrice = maxPrice;
      if (inStock) params.inStock = 'true';
      const res = await apiClient.get<ApiEnvelope<ProductItem[]>>('/products', { params });
      return res.data;
    },
  });

  const recommendationsQuery = useQuery({
    queryKey: ['recommendations', user?.id ?? 'anon'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<{ strategy: string; items: ProductItem[] }>>(
        '/products/recommendations',
      );
      return res.data.data;
    },
  });

  const addToCart = useMutation({
    mutationFn: async (skuId: string) => {
      const res = await apiClient.post<ApiEnvelope<{ items: unknown[] }>>('/cart/items', {
        skuId,
        quantity: 1,
      });
      return res.data.data;
    },
    onSuccess: (data) => {
      dispatch(setCartCount(data.items.length));
      dispatch(pushToast({ type: 'success', message: 'Added item to cart!' }));
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (err) => {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err, 'Please sign in to add items') }));
    },
  });

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <AppShell>
      {/* Hero Banner */}
      <section className="mb-8 rounded-2xl bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 p-6 sm:p-10 text-white shadow-md">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/20 px-3 py-1 text-xs font-semibold text-blue-200 border border-blue-400/30">
            Enterprise Multi-Vendor Commerce
          </span>
          <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
            Discover Verified Sellers & Precision Gear
          </h1>
          <p className="mt-2 text-sm sm:text-base text-slate-300">
            Real-time concurrency-protected inventory reservations, deterministic FastAPI pricing, and full order
            traceability across independent vendors.
          </p>

          <form onSubmit={handleSearchSubmit} className="mt-6 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search products, brands, or SKUs (e.g. Headphones, Oak, APX)..."
                aria-label="Search catalog"
                className="w-full rounded-xl bg-white py-2.5 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <Button type="submit" size="lg" className="bg-blue-600 hover:bg-blue-500">
              Search Catalog
            </Button>
          </form>
        </div>
      </section>

      {/* Categories & Filters */}
      <section className="mb-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCategorySlug('');
              setPage(1);
            }}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              categorySlug === ''
                ? 'bg-blue-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            All Categories
          </button>
          {categoriesQuery.data?.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                setCategorySlug(cat.slug);
                setPage(1);
              }}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                categorySlug === cat.slug
                  ? 'bg-blue-700 text-white'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        <Card className="p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            <SlidersHorizontal className="h-4 w-4" /> Filters:
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              placeholder="Min $"
              value={minPrice}
              onChange={(e) => {
                setMinPrice(e.target.value);
                setPage(1);
              }}
              className="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
            />
            <span className="text-slate-400">-</span>
            <input
              type="number"
              min={0}
              placeholder="Max $"
              value={maxPrice}
              onChange={(e) => {
                setMaxPrice(e.target.value);
                setPage(1);
              }}
              className="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={inStock}
              onChange={(e) => {
                setInStock(e.target.checked);
                setPage(1);
              }}
              className="rounded border-slate-300"
            />
            In stock only
          </label>

          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="sortBy" className="text-xs font-medium text-slate-600">
              Sort:
            </label>
            <select
              id="sortBy"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="newest">Newest arrivals</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="title">Title A-Z</option>
            </select>
          </div>
        </Card>
      </section>

      {/* Catalog Grid */}
      <section aria-label="Product catalog">
        {productsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="p-4 space-y-3">
                <Skeleton className="h-44 w-full" />
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </Card>
            ))}
          </div>
        ) : productsQuery.isError ? (
          <EmptyState
            title="Could not load catalog"
            description={extractErrorMessage(productsQuery.error)}
            action={<Button onClick={() => productsQuery.refetch()}>Retry</Button>}
          />
        ) : !productsQuery.data?.data.length ? (
          <EmptyState
            title="No matching products found"
            description="Try clearing your search query or adjusting the price range."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setSearchInput('');
                  setCategorySlug('');
                  setMinPrice('');
                  setMaxPrice('');
                  setInStock(false);
                }}
              >
                Reset filters
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {productsQuery.data.data.map((product) => {
                const defaultSku = product.skus[0];
                const imageUrl = product.images[0]?.url;
                const stock = product.availableStock ?? 0;
                return (
                  <Card key={product.id} className="flex flex-col overflow-hidden hover:shadow-md transition-shadow">
                    <Link href={`/products/${product.slug}`} className="block bg-slate-100 h-48 overflow-hidden relative">
                      {imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageUrl}
                          alt={product.title}
                          className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-slate-400">
                          No preview image
                        </div>
                      )}
                    </Link>
                    <div className="flex flex-1 flex-col p-5">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span className="font-medium text-blue-700">{product.category?.name}</span>
                        <span>{product.seller?.storeName}</span>
                      </div>
                      <Link
                        href={`/products/${product.slug}`}
                        className="mt-1.5 text-base font-semibold text-slate-900 hover:text-blue-700 line-clamp-2"
                      >
                        {product.title}
                      </Link>
                      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                          <Star className="h-3.5 w-3.5 fill-amber-500" />
                          {product.averageRating ? product.averageRating.toFixed(1) : 'New'}
                        </span>
                        <span>({product.reviewCount ?? 0} reviews)</span>
                        <span className="ml-auto">
                          <StatusBadge status={stock > 0 ? 'IN STOCK' : 'OUT OF STOCK'} />
                        </span>
                      </div>

                      <div className="mt-auto pt-4 flex items-center justify-between border-t border-slate-100">
                        <div>
                          <span className="text-lg font-bold text-slate-900">
                            ${defaultSku?.price ?? product.minPrice ?? '0.00'}
                          </span>
                          {defaultSku?.compareAtPrice && (
                            <span className="ml-2 text-xs text-slate-400 line-through">
                              ${defaultSku.compareAtPrice}
                            </span>
                          )}
                        </div>
                        <Button
                          size="sm"
                          disabled={!defaultSku || stock <= 0 || addToCart.isPending}
                          onClick={() => defaultSku && addToCart.mutate(defaultSku.id)}
                        >
                          <ShoppingCart className="h-3.5 w-3.5" />
                          Add
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <Pagination
              page={productsQuery.data.meta.page}
              totalPages={productsQuery.data.meta.totalPages}
              onPageChange={setPage}
            />
          </>
        )}
      </section>

      {/* FastAPI Recommendations */}
      {recommendationsQuery.data && recommendationsQuery.data.items.length > 0 && (
        <section className="mt-12">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-blue-700" />
              <h2 className="text-xl font-bold text-slate-900">Recommended For You</h2>
            </div>
            <span className="text-xs text-slate-500">
              Engine: <code>{recommendationsQuery.data.strategy}</code>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recommendationsQuery.data.items.slice(0, 3).map((item) => (
              <Card key={item.id} className="p-4 flex items-center gap-4 hover:border-blue-300 transition-colors">
                <div className="h-16 w-16 shrink-0 rounded-lg bg-slate-100 overflow-hidden">
                  {item.images?.[0]?.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.images[0].url} alt={item.title} className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <Link href={`/products/${item.slug}`} className="font-semibold text-sm text-slate-900 hover:text-blue-700 block truncate">
                    {item.title}
                  </Link>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{item.recommendationReason}</p>
                  <p className="text-sm font-bold text-slate-900 mt-1">${item.skus?.[0]?.price ?? '0.00'}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
