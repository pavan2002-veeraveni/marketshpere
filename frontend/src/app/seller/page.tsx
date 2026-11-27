'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { DollarSign, Package, ShoppingBag, TrendingUp, Upload } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, StatCard, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast } from '@/store';
import { ApiEnvelope, CategoryItem, OrderRecord, ProductItem } from '@/types/api';

type SellerTab = 'overview' | 'onboarding' | 'catalog' | 'inventory' | 'orders' | 'finance';

export default function SellerPortalPage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SellerTab>('overview');

  // Create product state
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [skuCode, setSkuCode] = useState('');
  const [price, setPrice] = useState('99.00');
  const [initialStock, setInitialStock] = useState('15');
  const [feedText, setFeedText] = useState(
    'title,sku_code,price,category_slug,quantity,brand\nStudio Pop Filter,APX-POP-01,29.99,audio-studio,25,Apex',
  );

  // Stock adjustment state
  const [adjSkuId, setAdjSkuId] = useState('');
  const [adjWhId, setAdjWhId] = useState('');
  const [adjQty, setAdjQty] = useState('5');
  const [adjType, setAdjType] = useState<'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGED'>('ADJUSTMENT_IN');

  // Onboarding file upload state
  const [docFile, setDocFile] = useState<File | null>(null);

  const analyticsQuery = useQuery({
    queryKey: ['seller-analytics'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<{
          storeName: string;
          onboardingStatus: string;
          productsCount: number;
          ordersCount: number;
          unitsSold: number;
          grossSales: string;
          totalCommission: string;
          netEarnings: string;
          topProducts: Array<{ title: string; units: number; revenue: string }>;
        }>
      >('/sellers/me/analytics');
      return res.data.data;
    },
  });

  const profileQuery = useQuery({
    queryKey: ['seller-me'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<{
          id: string;
          storeName: string;
          onboardingStatus: string;
          rejectionReason?: string | null;
          profile?: { legalBusinessName: string; supportEmail: string; returnPolicy?: string };
          onboardingRecords: Array<{ id: string; documentType: string; originalName: string; status: string }>;
        }>
      >('/sellers/me');
      return res.data.data;
    },
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<CategoryItem[]>>('/categories');
      return res.data.data;
    },
  });

  const productsQuery = useQuery({
    queryKey: ['seller-products'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<ProductItem[]>>('/seller/products');
      return res.data.data;
    },
  });

  const inventoryQuery = useQuery({
    queryKey: ['seller-inventory'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            skuId: string;
            warehouseId: string;
            onHandQty: number;
            reservedQty: number;
            availableQty: number;
            isLowStock: boolean;
            warehouse: { code: string; name: string };
            sku: { skuCode: string; product: { title: string } };
          }>
        >
      >('/inventory');
      return res.data.data;
    },
  });

  const ordersQuery = useQuery({
    queryKey: ['seller-orders'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders');
      return res.data.data;
    },
  });

  const returnsQuery = useQuery({
    queryKey: ['seller-returns'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; status: string; reason: string; order: { orderNumber: string } }>>
      >('/returns');
      return res.data.data;
    },
  });

  const ledgerQuery = useQuery({
    queryKey: ['seller-commissions'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            grossAmount: string;
            commissionAmount: string;
            netSellerAmount: string;
            status: string;
            order: { orderNumber: string };
            orderItem: { productTitleSnapshot: string };
          }>
        >
      >('/commissions/ledger');
      return res.data.data;
    },
  });

  const settlementsQuery = useQuery({
    queryKey: ['seller-settlements'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{ id: string; settlementNumber: string; grossSales: string; totalCommissions: string; netPayout: string; status: string }>
        >
      >('/settlements');
      return res.data.data;
    },
  });

  const createProduct = useMutation({
    mutationFn: async () => {
      await apiClient.post('/seller/products', {
        categoryId: categoryId || categoriesQuery.data?.[0]?.id,
        title,
        description,
        status: 'ACTIVE',
        variants: [
          {
            name: 'Default',
            optionValues: { edition: 'Standard' },
            skuCode,
            price,
            initialStock: Number(initialStock),
          },
        ],
      });
    },
    onSuccess: () => {
      setTitle('');
      setDescription('');
      setSkuCode('');
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      queryClient.invalidateQueries({ queryKey: ['seller-inventory'] });
      dispatch(pushToast({ type: 'success', message: 'Product and SKU created!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const importFeed = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<ApiEnvelope<{ importedCount: number; invalidRows: number }>>(
        '/seller/products/feed-import',
        { format: 'csv', content: feedText },
      );
      return res.data.data;
    },
    onSuccess: (report) => {
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      queryClient.invalidateQueries({ queryKey: ['seller-inventory'] });
      dispatch(
        pushToast({
          type: 'success',
          message: `Feed processed: ${report.importedCount} imported, ${report.invalidRows} invalid rows`,
        }),
      );
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const adjustStock = useMutation({
    mutationFn: async () => {
      await apiClient.post('/inventory/adjust', {
        skuId: adjSkuId,
        warehouseId: adjWhId,
        movementType: adjType,
        quantity: Number(adjQty),
        notes: 'Seller portal stock adjustment',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-inventory'] });
      dispatch(pushToast({ type: 'success', message: 'Inventory adjusted & logged to ledger' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const createShipment = useMutation({
    mutationFn: async (orderId: string) => {
      await apiClient.post('/shipments', { orderId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-orders'] });
      dispatch(pushToast({ type: 'success', message: 'Sandbox shipment & tracking label created!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const decideReturn = useMutation({
    mutationFn: async ({ returnId, status }: { returnId: string; status: 'APPROVED' | 'REJECTED' }) => {
      await apiClient.patch(`/returns/${returnId}/decision`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-returns'] });
      dispatch(pushToast({ type: 'success', message: 'Return decision recorded' }));
    },
  });

  const uploadDoc = useMutation({
    mutationFn: async () => {
      if (!docFile) throw new Error('Select a PDF/PNG/JPEG file');
      const form = new FormData();
      form.append('file', docFile);
      form.append('step', 'BUSINESS_VERIFICATION');
      form.append('documentType', 'BUSINESS_LICENSE');
      form.append('submitForReview', 'true');
      await apiClient.post('/sellers/me/documents', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    onSuccess: () => {
      setDocFile(null);
      queryClient.invalidateQueries({ queryKey: ['seller-me'] });
      dispatch(pushToast({ type: 'success', message: 'Verification document uploaded!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  return (
    <AppShell>
      <ProtectedRoute allowedRoles={['SELLER', 'ADMIN']}>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'Seller Portal' }]} />

        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {analyticsQuery.data?.storeName ?? 'Seller Operations Portal'}
            </h1>
            <p className="text-xs text-slate-500 mt-1">Isolated vendor catalog, stock, fulfillment & settlements</p>
          </div>
          {analyticsQuery.data && <StatusBadge status={analyticsQuery.data.onboardingStatus} />}
        </div>

        <div className="mb-6 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
          {(
            [
              ['overview', 'Analytics Overview'],
              ['onboarding', 'Onboarding & Profile'],
              ['catalog', 'Products & Feed Import'],
              ['inventory', 'Inventory & Ledger'],
              ['orders', 'Orders & Returns'],
              ['finance', 'Commissions & Settlements'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                tab === id ? 'bg-blue-700 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && analyticsQuery.data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard title="Gross Sales" value={`$${analyticsQuery.data.grossSales}`} icon={<DollarSign className="h-5 w-5" />} />
              <StatCard title="Net Seller Earnings" value={`$${analyticsQuery.data.netEarnings}`} icon={<TrendingUp className="h-5 w-5" />} />
              <StatCard title="Orders Fulfilled" value={analyticsQuery.data.ordersCount} icon={<ShoppingBag className="h-5 w-5" />} />
              <StatCard title="Active Products" value={analyticsQuery.data.productsCount} icon={<Package className="h-5 w-5" />} />
            </div>

            <Card className="p-6">
              <h2 className="text-base font-bold text-slate-900 mb-3">Top Performing Products</h2>
              {analyticsQuery.data.topProducts.length === 0 ? (
                <p className="text-sm text-slate-500">No sales recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {analyticsQuery.data.topProducts.map((tp) => (
                    <div key={tp.title} className="flex items-center justify-between text-sm border-b border-slate-100 pb-2">
                      <span className="font-medium text-slate-800">{tp.title}</span>
                      <span className="text-slate-600">
                        {tp.units} units &bull; <strong>${tp.revenue}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'onboarding' && profileQuery.data && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6 space-y-3 text-sm">
              <h2 className="text-base font-bold text-slate-900">Store Verification Status</h2>
              <div className="flex items-center gap-2">
                <span>Current Status:</span>
                <StatusBadge status={profileQuery.data.onboardingStatus} />
              </div>
              {profileQuery.data.rejectionReason && (
                <p className="text-xs text-red-600">Rejection reason: {profileQuery.data.rejectionReason}</p>
              )}
              <p className="text-slate-600">Legal Entity: {profileQuery.data.profile?.legalBusinessName ?? 'N/A'}</p>
              <p className="text-slate-600">Support Email: {profileQuery.data.profile?.supportEmail ?? 'N/A'}</p>
            </Card>

            <Card className="p-6 space-y-4">
              <h2 className="text-base font-bold text-slate-900">Upload Verification Document (PDF/PNG/JPEG)</h2>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
                className="text-xs"
              />
              <Button size="sm" disabled={!docFile || uploadDoc.isPending} onClick={() => uploadDoc.mutate()}>
                <Upload className="h-4 w-4" /> Upload Document
              </Button>
              <div className="border-t border-slate-200 pt-3 space-y-2">
                {profileQuery.data.onboardingRecords.map((rec) => (
                  <div key={rec.id} className="flex items-center justify-between text-xs">
                    <span>{rec.originalName}</span>
                    <StatusBadge status={rec.status} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'catalog' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold text-slate-900">Create Product & SKU</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createProduct.mutate();
                }}
                className="space-y-3"
              >
                <select
                  value={categoryId || categoriesQuery.data?.[0]?.id || ''}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                >
                  {categoriesQuery.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  required
                  placeholder="Product Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <textarea
                  required
                  rows={2}
                  placeholder="Product Description (min 10 chars)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <div className="grid grid-cols-3 gap-2">
                  <input
                    required
                    placeholder="SKU Code"
                    value={skuCode}
                    onChange={(e) => setSkuCode(e.target.value.toUpperCase())}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs uppercase"
                  />
                  <input
                    required
                    placeholder="Price"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                  <input
                    required
                    type="number"
                    min={0}
                    placeholder="Stock"
                    value={initialStock}
                    onChange={(e) => setInitialStock(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <Button type="submit" size="sm" disabled={createProduct.isPending}>
                  Create Product
                </Button>
              </form>
            </Card>

            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold text-slate-900">Bulk CSV Feed Import (Python FastAPI)</h2>
              <textarea
                rows={5}
                value={feedText}
                onChange={(e) => setFeedText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 p-2.5 font-mono text-xs"
              />
              <Button size="sm" onClick={() => importFeed.mutate()} disabled={importFeed.isPending}>
                Normalize & Import CSV Feed
              </Button>
            </Card>

            <Card className="lg:col-span-2 p-6">
              <h2 className="text-base font-bold text-slate-900 mb-3">My Products</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2">Product</th>
                      <th>Category</th>
                      <th>SKUs</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productsQuery.data?.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2.5 font-medium text-slate-900">{p.title}</td>
                        <td>{p.category?.name}</td>
                        <td>{p.skus.map((s) => `${s.skuCode} ($${s.price})`).join(', ')}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {tab === 'inventory' && (
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="text-base font-bold text-slate-900 mb-3">Adjust Stock</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  adjustStock.mutate();
                }}
                className="flex flex-wrap gap-2 items-center"
              >
                <select
                  required
                  value={adjSkuId ? `${adjSkuId}:${adjWhId}` : ''}
                  onChange={(e) => {
                    const [sId, wId] = e.target.value.split(':');
                    setAdjSkuId(sId ?? '');
                    setAdjWhId(wId ?? '');
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                >
                  <option value="">Select SKU & Warehouse...</option>
                  {inventoryQuery.data?.map((inv) => (
                    <option key={inv.id} value={`${inv.skuId}:${inv.warehouseId}`}>
                      {inv.sku.skuCode} ({inv.warehouse.code}) — Avail: {inv.availableQty}
                    </option>
                  ))}
                </select>
                <select
                  value={adjType}
                  onChange={(e) => setAdjType(e.target.value as typeof adjType)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                >
                  <option value="ADJUSTMENT_IN">Add Stock (+)</option>
                  <option value="ADJUSTMENT_OUT">Remove Stock (-)</option>
                  <option value="DAMAGED">Mark Damaged</option>
                </select>
                <input
                  type="number"
                  min={1}
                  value={adjQty}
                  onChange={(e) => setAdjQty(e.target.value)}
                  className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Button type="submit" size="sm" disabled={!adjSkuId || adjustStock.isPending}>
                  Apply Adjustment
                </Button>
              </form>
            </Card>

            <Card className="p-6 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2">SKU</th>
                    <th>Product</th>
                    <th>Warehouse</th>
                    <th>On Hand</th>
                    <th>Reserved</th>
                    <th>Available</th>
                    <th>Alert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inventoryQuery.data?.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2 font-mono">{inv.sku.skuCode}</td>
                      <td>{inv.sku.product.title}</td>
                      <td>{inv.warehouse.code}</td>
                      <td>{inv.onHandQty}</td>
                      <td>{inv.reservedQty}</td>
                      <td className="font-bold">{inv.availableQty}</td>
                      <td>
                        <StatusBadge status={inv.isLowStock ? 'LOW_STOCK' : 'HEALTHY'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {tab === 'orders' && (
          <div className="space-y-6">
            <Card className="p-6 overflow-x-auto">
              <h2 className="text-base font-bold text-slate-900 mb-3">Incoming Store Orders</h2>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2">Order</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ordersQuery.data?.map((ord) => (
                    <tr key={ord.id}>
                      <td className="py-2.5 font-bold">{ord.orderNumber}</td>
                      <td>{ord.customer?.email}</td>
                      <td>{ord.items.map((i) => `${i.skuCodeSnapshot} x${i.quantity}`).join(', ')}</td>
                      <td>
                        <StatusBadge status={ord.status} />
                      </td>
                      <td>
                        {['PAYMENT_CONFIRMED', 'PROCESSING'].includes(ord.status) && (
                          <Button size="sm" onClick={() => createShipment.mutate(ord.id)}>
                            Create Shipment
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-6">
              <h2 className="text-base font-bold text-slate-900 mb-3">Return Requests</h2>
              <div className="space-y-2">
                {returnsQuery.data?.map((ret) => (
                  <div key={ret.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                    <span>
                      <strong>{ret.order.orderNumber}</strong> — {ret.reason}
                    </span>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={ret.status} />
                      {ret.status === 'REQUESTED' && (
                        <>
                          <Button size="sm" onClick={() => decideReturn.mutate({ returnId: ret.id, status: 'APPROVED' })}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => decideReturn.mutate({ returnId: ret.id, status: 'REJECTED' })}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'finance' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6 overflow-x-auto">
              <h2 className="text-base font-bold text-slate-900 mb-3">Commission Ledger</h2>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2">Order</th>
                    <th>Gross</th>
                    <th>Commission</th>
                    <th>Net Seller</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledgerQuery.data?.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2">{l.order.orderNumber}</td>
                      <td>${l.grossAmount}</td>
                      <td className="text-red-600">-${l.commissionAmount}</td>
                      <td className="font-bold text-emerald-700">${l.netSellerAmount}</td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-6 overflow-x-auto">
              <h2 className="text-base font-bold text-slate-900 mb-3">Settlement Statements</h2>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2">Statement</th>
                    <th>Net Payout</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {settlementsQuery.data?.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2 font-mono">{s.settlementNumber}</td>
                      <td className="font-bold">${s.netPayout}</td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
