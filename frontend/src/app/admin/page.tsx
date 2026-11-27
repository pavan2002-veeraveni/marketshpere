'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { Activity, DollarSign, ShieldAlert, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, StatCard, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast } from '@/store';
import { ApiEnvelope, ProductItem } from '@/types/api';

type AdminTab = 'overview' | 'sellers' | 'catalog' | 'finance' | 'governance';

export default function AdminDashboardPage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AdminTab>('overview');

  const [newCatName, setNewCatName] = useState('');
  const [newDiscCode, setNewDiscCode] = useState('');
  const [newDiscValue, setNewDiscValue] = useState('15.00');

  const analyticsQuery = useQuery({
    queryKey: ['admin-analytics'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<{
          usersCount: number;
          sellersTotal: number;
          sellersPending: number;
          productsActive: number;
          ordersCount: number;
          gmv: string;
          totalCommission: string;
          openDisputes: number;
          pendingReturns: number;
          lowStockCount: number;
          ordersByStatus: Record<string, number>;
        }>
      >('/admin/analytics');
      return res.data.data;
    },
  });

  const sellersQuery = useQuery({
    queryKey: ['admin-sellers'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; storeName: string; onboardingStatus: string; user: { email: string } }>>
      >('/sellers');
      return res.data.data;
    },
  });

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; email: string; firstName: string; lastName: string; primaryRole: string; status: string }>>
      >('/admin/users');
      return res.data.data;
    },
  });

  const productsQuery = useQuery({
    queryKey: ['admin-products'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<ProductItem[]>>('/admin/products');
      return res.data.data;
    },
  });

  const settlementsQuery = useQuery({
    queryKey: ['admin-settlements'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; settlementNumber: string; netPayout: string; status: string; seller: { storeName: string } }>>
      >('/settlements');
      return res.data.data;
    },
  });

  const auditQuery = useQuery({
    queryKey: ['admin-audit'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; action: string; resourceType: string; resourceId: string; createdAt: string; actorUser?: { email: string } }>>
      >('/admin/audit-logs');
      return res.data.data;
    },
  });

  const jobsQuery = useQuery({
    queryKey: ['admin-jobs'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            queueName: string;
            jobName: string;
            status: string;
            attempts: number;
            errorMessage?: string | null;
            result?: Record<string, unknown> | null;
          }>
        >
      >('/admin/jobs');
      return res.data.data;
    },
  });

  const webhooksQuery = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            provider: string;
            providerEventId: string;
            eventType: string;
            status: string;
            retryCount: number;
            lastError?: string | null;
            createdAt: string;
          }>
        >
      >('/admin/webhooks');
      return res.data.data;
    },
  });

  const updateSellerStatus = useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; status: string; reason?: string }) =>
      apiClient.patch(`/sellers/${id}/status`, { status, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-sellers'] });
      dispatch(pushToast({ type: 'success', message: 'Seller status updated' }));
    },
  });

  const moderateProduct = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'ACTIVE' | 'REJECTED' }) =>
      apiClient.patch(`/admin/products/${id}/moderate`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      dispatch(pushToast({ type: 'success', message: 'Product moderation updated' }));
    },
  });

  const createCategory = useMutation({
    mutationFn: async () => apiClient.post('/categories', { name: newCatName }),
    onSuccess: () => {
      setNewCatName('');
      dispatch(pushToast({ type: 'success', message: 'Category created' }));
    },
  });

  const createDiscount = useMutation({
    mutationFn: async () =>
      apiClient.post('/discounts', {
        code: newDiscCode,
        discountType: 'FIXED',
        value: newDiscValue,
        startsAt: new Date(Date.now() - 3600_000).toISOString(),
        expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
      }),
    onSuccess: () => {
      setNewDiscCode('');
      dispatch(pushToast({ type: 'success', message: 'Discount code published' }));
    },
  });

  const generateSettlements = useMutation({
    mutationFn: async () => apiClient.post('/settlements/generate', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settlements'] });
      dispatch(pushToast({ type: 'success', message: 'Settlements generated' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const approveSettlement = useMutation({
    mutationFn: async (id: string) => apiClient.patch(`/settlements/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settlements'] });
      dispatch(pushToast({ type: 'success', message: 'Settlement approved & paid!' }));
    },
  });

  const replayJob = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/admin/jobs/${id}/replay`, { executeNow: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['admin-audit'] });
      dispatch(pushToast({ type: 'success', message: 'Job replayed and executed' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const triggerJob = useMutation({
    mutationFn: async (jobName: string) => apiClient.post('/admin/jobs/trigger', { jobName, executeNow: true }),
    onSuccess: (_data, jobName) => {
      queryClient.invalidateQueries({ queryKey: ['admin-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['admin-audit'] });
      queryClient.invalidateQueries({ queryKey: ['admin-analytics'] });
      dispatch(pushToast({ type: 'success', message: `Executed ${jobName}` }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  return (
    <AppShell>
      <ProtectedRoute allowedRoles={['ADMIN']}>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'Admin Console' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Marketplace Administration Console</h1>

        <div className="mb-6 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
          {(
            [
              ['overview', 'Marketplace Analytics'],
              ['sellers', 'Sellers & Users'],
              ['catalog', 'Categories & Moderation'],
              ['finance', 'Discounts & Settlements'],
              ['governance', 'Audit Logs & Jobs'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold cursor-pointer ${
                tab === id ? 'bg-blue-700 text-white' : 'bg-white border border-slate-200 text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && analyticsQuery.data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard title="Marketplace GMV" value={`$${analyticsQuery.data.gmv}`} icon={<DollarSign className="h-5 w-5" />} />
              <StatCard title="Platform Commissions" value={`$${analyticsQuery.data.totalCommission}`} icon={<Activity className="h-5 w-5" />} />
              <StatCard title="Total Users / Sellers" value={`${analyticsQuery.data.usersCount} / ${analyticsQuery.data.sellersTotal}`} subtitle={`${analyticsQuery.data.sellersPending} pending approval`} icon={<Users className="h-5 w-5" />} />
              <StatCard title="Risk & Alerts" value={`${analyticsQuery.data.lowStockCount} Low Stock`} subtitle={`${analyticsQuery.data.openDisputes} open disputes`} icon={<ShieldAlert className="h-5 w-5" />} />
            </div>

            <Card className="p-6">
              <h2 className="text-base font-bold mb-4">Order Distribution by Status</h2>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(analyticsQuery.data.ordersByStatus).map(([status, count]) => (
                  <div key={status} className="rounded-lg border border-slate-200 p-3 flex items-center justify-between text-xs">
                    <StatusBadge status={status} />
                    <span className="text-base font-bold">{count}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'sellers' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Seller Onboarding & Governance</h2>
              {sellersQuery.data?.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
                  <div>
                    <p className="font-bold">{s.storeName}</p>
                    <p className="text-slate-500">{s.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={s.onboardingStatus} />
                    {s.onboardingStatus !== 'APPROVED' && (
                      <Button size="sm" onClick={() => updateSellerStatus.mutate({ id: s.id, status: 'APPROVED' })}>
                        Approve
                      </Button>
                    )}
                    {s.onboardingStatus === 'APPROVED' && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => updateSellerStatus.mutate({ id: s.id, status: 'SUSPENDED', reason: 'Admin review' })}
                      >
                        Suspend
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </Card>

            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Registered Platform Users</h2>
              <div className="space-y-2 max-h-96 overflow-y-auto text-xs">
                {usersQuery.data?.map((u) => (
                  <div key={u.id} className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span>
                      <strong>{u.email}</strong> ({u.primaryRole})
                    </span>
                    <StatusBadge status={u.status} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'catalog' && (
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="text-base font-bold mb-3">Create Category</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createCategory.mutate();
                }}
                className="flex gap-2 max-w-md"
              >
                <input
                  required
                  placeholder="Category Name"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Button type="submit" size="sm">
                  Add Category
                </Button>
              </form>
            </Card>

            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Product Moderation Queue</h2>
              {productsQuery.data?.map((p) => (
                <div key={p.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                  <span>
                    <strong>{p.title}</strong> ({p.seller?.storeName})
                  </span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={p.status} />
                    <Button size="sm" onClick={() => moderateProduct.mutate({ id: p.id, status: 'ACTIVE' })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => moderateProduct.mutate({ id: p.id, status: 'REJECTED' })}>
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {tab === 'finance' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Create Marketplace Coupon</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createDiscount.mutate();
                }}
                className="flex gap-2"
              >
                <input
                  required
                  placeholder="CODE (e.g. SPRING15)"
                  value={newDiscCode}
                  onChange={(e) => setNewDiscCode(e.target.value.toUpperCase())}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs uppercase"
                />
                <input
                  required
                  placeholder="Amount $"
                  value={newDiscValue}
                  onChange={(e) => setNewDiscValue(e.target.value)}
                  className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Button type="submit" size="sm">
                  Create Coupon
                </Button>
              </form>
            </Card>

            <Card className="p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold">Seller Settlements</h2>
                <Button size="sm" onClick={() => generateSettlements.mutate()}>
                  Generate Pending Batch
                </Button>
              </div>
              {settlementsQuery.data?.map((s) => (
                <div key={s.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                  <span>
                    <strong>{s.settlementNumber}</strong> ({s.seller.storeName}) — ${s.netPayout}
                  </span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={s.status} />
                    {s.status !== 'PAID' && (
                      <Button size="sm" onClick={() => approveSettlement.mutate(s.id)}>
                        Approve & Pay
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {tab === 'governance' && (
          <div className="space-y-6">
            <Card className="p-6 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold">Manual Worker & Maintenance Triggers</h2>
                  <p className="text-xs text-slate-500">
                    Dispatches tracked BullMQ jobs with PostgreSQL persistence & synchronous fallback execution.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['reservation-expiry-sweep', 'Reservation Sweep'],
                    ['outbox-dispatch', 'Outbox Dispatch'],
                    ['low-stock-alerts', 'Low-Stock Alerts'],
                    ['payment-reconciliation', 'Payment Reconciliation'],
                    ['failed-webhook-recovery', 'Webhook Recovery'],
                  ] as const
                ).map(([jobName, label]) => (
                  <Button
                    key={jobName}
                    size="sm"
                    variant="secondary"
                    disabled={triggerJob.isPending}
                    onClick={() => triggerJob.mutate(jobName)}
                  >
                    Run {label}
                  </Button>
                ))}
              </div>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="p-6 space-y-3">
                <h2 className="text-base font-bold">Audit Log Timeline</h2>
                <div className="space-y-2 max-h-96 overflow-y-auto text-xs">
                  {auditQuery.data?.map((a) => (
                    <div key={a.id} className="border-b border-slate-100 pb-1.5">
                      <p className="font-semibold">
                        {a.action} ({a.resourceType})
                      </p>
                      <p className="text-slate-500">
                        Actor: {a.actorUser?.email ?? 'SYSTEM'} &bull; {new Date(a.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-6 space-y-3">
                <h2 className="text-base font-bold">Background Jobs & Dead-Letter Replay</h2>
                <div className="space-y-2 max-h-96 overflow-y-auto text-xs">
                  {jobsQuery.data?.map((j) => (
                    <div key={j.id} className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{j.jobName}</p>
                        <p className="text-slate-500">
                          {j.queueName} &bull; Attempts: {j.attempts}
                        </p>
                        {j.errorMessage && <p className="text-red-600 truncate">{j.errorMessage}</p>}
                        {j.result && (
                          <p className="text-slate-600 font-mono text-[11px] truncate">{JSON.stringify(j.result)}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={j.status} />
                        {['FAILED', 'DEAD_LETTER', 'QUEUED'].includes(j.status) && (
                          <Button size="sm" variant="secondary" onClick={() => replayJob.mutate(j.id)}>
                            Replay
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Recent Payment & Shipping Webhook Events</h2>
              <div className="space-y-2 max-h-64 overflow-y-auto text-xs">
                {webhooksQuery.data?.map((w) => (
                  <div key={w.id} className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                    <div>
                      <p className="font-semibold">
                        {w.provider} &bull; {w.eventType} ({w.providerEventId})
                      </p>
                      {w.lastError && <p className="text-red-600">{w.lastError}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">Retries: {w.retryCount}</span>
                      <StatusBadge status={w.status} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
