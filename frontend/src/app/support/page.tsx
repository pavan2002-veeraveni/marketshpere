'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast } from '@/store';
import { ApiEnvelope, OrderRecord } from '@/types/api';

export default function SupportPortalPage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [customerSearch, setCustomerSearch] = useState('');
  const [noteInput, setNoteInput] = useState<Record<string, string>>({});

  const customersQuery = useQuery({
    queryKey: ['support-customers', customerSearch],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; email: string; firstName: string; lastName: string; status: string }>>
      >('/support/customers', { params: { search: customerSearch } });
      return res.data.data;
    },
  });

  const ordersQuery = useQuery({
    queryKey: ['support-orders'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders', { params: { limit: 20 } });
      return res.data.data;
    },
  });

  const casesQuery = useQuery({
    queryKey: ['support-cases'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            caseNumber: string;
            subject: string;
            priority: string;
            status: string;
            customer: { email: string };
            notes: Array<{ id: string; body: string; isInternal: boolean }>;
          }>
        >
      >('/support/cases');
      return res.data.data;
    },
  });

  const returnsQuery = useQuery({
    queryKey: ['support-returns'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; orderId: string; status: string; reason: string; order: { orderNumber: string; totalAmount: string } }>>
      >('/returns');
      return res.data.data;
    },
  });

  const disputesQuery = useQuery({
    queryKey: ['support-disputes'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; reason: string; status: string; order: { orderNumber: string }; seller: { storeName: string } }>>
      >('/disputes');
      return res.data.data;
    },
  });

  const addNote = useMutation({
    mutationFn: async ({ caseId, body }: { caseId: string; body: string }) =>
      apiClient.post(`/support/cases/${caseId}/notes`, { body, isInternal: true }),
    onSuccess: (_d, vars) => {
      setNoteInput((prev) => ({ ...prev, [vars.caseId]: '' }));
      queryClient.invalidateQueries({ queryKey: ['support-cases'] });
      dispatch(pushToast({ type: 'success', message: 'Internal note added' }));
    },
  });

  const updateCase = useMutation({
    mutationFn: async ({ caseId, status }: { caseId: string; status: string }) =>
      apiClient.patch(`/support/cases/${caseId}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['support-cases'] }),
  });

  const issueRefund = useMutation({
    mutationFn: async ({ orderId, returnId, amount }: { orderId: string; returnId?: string; amount: string }) =>
      apiClient.post('/refunds', { orderId, returnId, amount, reason: 'Support agent verified return/refund' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-returns'] });
      queryClient.invalidateQueries({ queryKey: ['support-orders'] });
      dispatch(pushToast({ type: 'success', message: 'Idempotent refund processed!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const resolveDispute = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/disputes/${id}`, { status, resolutionSummary: 'Resolved by Support Desk' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['support-disputes'] }),
  });

  return (
    <AppShell>
      <ProtectedRoute allowedRoles={['SUPPORT_AGENT', 'ADMIN']}>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'Support Desk' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Customer Support, Returns & Disputes Desk</h1>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-6 space-y-3">
            <h2 className="text-base font-bold">Customer Lookup</h2>
            <input
              placeholder="Search customers by email or name..."
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
            <div className="space-y-2 max-h-56 overflow-y-auto text-xs">
              {customersQuery.data?.map((c) => (
                <div key={c.id} className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span>
                    <strong>
                      {c.firstName} {c.lastName}
                    </strong>{' '}
                    ({c.email})
                  </span>
                  <StatusBadge status={c.status} />
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6 space-y-3">
            <h2 className="text-base font-bold">Recent Orders Lookup</h2>
            <div className="space-y-2 max-h-64 overflow-y-auto text-xs">
              {ordersQuery.data?.map((o) => (
                <div key={o.id} className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                  <span>
                    <strong>{o.orderNumber}</strong> &bull; {o.customer?.email} &bull; ${o.totalAmount}
                  </span>
                  <StatusBadge status={o.status} />
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6 space-y-4">
            <h2 className="text-base font-bold">Support Cases & Internal Notes</h2>
            {casesQuery.data?.map((c) => (
              <div key={c.id} className="rounded-xl border border-slate-200 p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold">
                    {c.caseNumber} — {c.subject}
                  </span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="text-slate-500">Customer: {c.customer.email}</p>
                <div className="space-y-1 bg-slate-50 p-2 rounded-lg">
                  {c.notes.map((n) => (
                    <p key={n.id}>
                      {n.isInternal ? <strong>[INTERNAL] </strong> : '[PUBLIC] '}
                      {n.body}
                    </p>
                  ))}
                </div>
                <div className="flex gap-2 pt-1">
                  <input
                    placeholder="Add internal agent note..."
                    value={noteInput[c.id] ?? ''}
                    onChange={(e) => setNoteInput((p) => ({ ...p, [c.id]: e.target.value }))}
                    className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={() => noteInput[c.id] && addNote.mutate({ caseId: c.id, body: noteInput[c.id]! })}
                  >
                    Add Note
                  </Button>
                  {c.status !== 'RESOLVED' && (
                    <Button size="sm" variant="secondary" onClick={() => updateCase.mutate({ caseId: c.id, status: 'RESOLVED' })}>
                      Resolve
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </Card>

          <div className="space-y-6">
            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Returns & Refund Processing</h2>
              {returnsQuery.data?.map((r) => (
                <div key={r.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                  <div>
                    <p className="font-bold">{r.order.orderNumber}</p>
                    <p className="text-slate-500">{r.reason}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    {['APPROVED', 'RECEIVED'].includes(r.status) && (
                      <Button
                        size="sm"
                        onClick={() => issueRefund.mutate({ orderId: r.orderId, returnId: r.id, amount: r.order.totalAmount })}
                      >
                        Issue Refund (${r.order.totalAmount})
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </Card>

            <Card className="p-6 space-y-3">
              <h2 className="text-base font-bold">Disputes Queue</h2>
              {disputesQuery.data?.map((d) => (
                <div key={d.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                  <div>
                    <p className="font-bold">
                      {d.order.orderNumber} ({d.seller.storeName})
                    </p>
                    <p className="text-slate-500">{d.reason}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {d.status !== 'RESOLVED_BUYER' && d.status !== 'CLOSED' && (
                      <Button size="sm" variant="secondary" onClick={() => resolveDispute.mutate({ id: d.id, status: 'RESOLVED_BUYER' })}>
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </ProtectedRoute>
    </AppShell>
  );
}
