'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, ConfirmDialog, Skeleton, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast } from '@/store';
import { ApiEnvelope, OrderRecord } from '@/types/api';

export default function OrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [returnDesc, setReturnDesc] = useState('');
  const [selectedReturnItemId, setSelectedReturnItemId] = useState('');

  const orderQuery = useQuery({
    queryKey: ['order', params.orderId],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord>>(`/orders/${params.orderId}`);
      return res.data.data;
    },
  });

  const cancelOrder = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/orders/${params.orderId}/cancel`, { reason: 'Cancelled by customer' });
    },
    onSuccess: () => {
      setConfirmCancel(false);
      queryClient.invalidateQueries({ queryKey: ['order', params.orderId] });
      dispatch(pushToast({ type: 'success', message: 'Order cancelled and stock released.' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const retrySandboxPay = useMutation({
    mutationFn: async (paymentId: string) => {
      await apiClient.post(`/payments/${paymentId}/retry`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', params.orderId] });
      dispatch(pushToast({ type: 'info', message: 'Payment retry initiated. Confirm payment when ready.' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const confirmSandboxPay = useMutation({
    mutationFn: async (paymentId: string) => {
      await apiClient.post(`/payments/${paymentId}/confirm-sandbox`, { outcome: 'SUCCEED' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', params.orderId] });
      dispatch(pushToast({ type: 'success', message: 'Payment confirmed!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const requestReturn = useMutation({
    mutationFn: async () => {
      const orderItemId = selectedReturnItemId || order!.items[0]!.id;
      await apiClient.post('/returns', {
        orderId: order!.id,
        reason: returnReason,
        description: returnDesc,
        items: [{ orderItemId, quantity: 1 }],
      });
    },
    onSuccess: () => {
      setReturnReason('');
      setReturnDesc('');
      queryClient.invalidateQueries({ queryKey: ['order', params.orderId] });
      dispatch(pushToast({ type: 'success', message: 'Return request submitted!' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const order = orderQuery.data;

  return (
    <AppShell>
      <ProtectedRoute>
        <Breadcrumbs items={[{ label: 'My Orders', href: '/orders' }, { label: order?.orderNumber ?? 'Order Detail' }]} />

        {orderQuery.isLoading || !order ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-6">
            <Card className="p-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{order.orderNumber}</h1>
                <p className="text-xs text-slate-500 mt-1">Placed {new Date(order.placedAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={order.status} />
                {order.status === 'PENDING_PAYMENT' && order.payments[0] && (
                  order.payments[0].status === 'FAILED' ? (
                    <Button
                      size="sm"
                      onClick={() => retrySandboxPay.mutate(order.payments[0]!.id)}
                      disabled={retrySandboxPay.isPending}
                    >
                      Retry Failed Payment
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => confirmSandboxPay.mutate(order.payments[0]!.id)}
                      disabled={confirmSandboxPay.isPending}
                    >
                      Confirm Sandbox Payment
                    </Button>
                  )
                )}
                {['PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'PROCESSING'].includes(order.status) && (
                  <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)}>
                    Cancel Order
                  </Button>
                )}
              </div>
            </Card>

            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2 p-6 space-y-4">
                <h2 className="text-base font-bold text-slate-900">Line Items</h2>
                <div className="divide-y divide-slate-100">
                  {order.items.map((item) => (
                    <div key={item.id} className="py-3 flex items-center justify-between text-sm">
                      <div>
                        <p className="font-semibold text-slate-900">{item.productTitleSnapshot}</p>
                        <p className="text-xs text-slate-500">
                          SKU: {item.skuCodeSnapshot} &bull; Qty: {item.quantity} &times; ${item.unitPrice}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge status={item.fulfillmentStatus} />
                        <span className="font-bold">${item.lineTotal}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {order.shipments.length > 0 && (
                  <div className="border-t border-slate-200 pt-4 space-y-3">
                    <h3 className="text-sm font-bold text-slate-900">Shipments & Tracking</h3>
                    {order.shipments.map((s) => (
                      <div key={s.id} className="rounded-lg bg-slate-50 p-3 text-xs space-y-2">
                        <div className="flex items-center justify-between">
                          <span>
                            {s.carrier} &bull; Tracking: <strong>{s.trackingNumber ?? 'Pending'}</strong>
                          </span>
                          <StatusBadge status={s.status} />
                        </div>
                        {s.events && s.events.length > 0 && (
                          <ul className="border-t border-slate-200 pt-2 space-y-1 text-slate-600">
                            {s.events.map((ev) => (
                              <li key={ev.id} className="flex flex-wrap items-center justify-between gap-2">
                                <span>
                                  <strong>{ev.status}</strong>
                                  {ev.location ? ` (${ev.location})` : ''}: {ev.description ?? 'Carrier event recorded'}
                                </span>
                                <span className="text-slate-400">{new Date(ev.occurredAt).toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {order.statusHistory && order.statusHistory.length > 0 && (
                  <div className="border-t border-slate-200 pt-4">
                    <h3 className="text-sm font-bold text-slate-900 mb-2">Lifecycle Timeline</h3>
                    <ol className="space-y-2 text-xs">
                      {order.statusHistory.map((h) => (
                        <li key={h.id} className="flex items-center justify-between text-slate-600">
                          <span>
                            <strong>{h.toStatus}</strong> — {h.reason}
                          </span>
                          <span className="text-slate-400">{new Date(h.createdAt).toLocaleString()}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </Card>

              <div className="space-y-6">
                <Card className="p-6 text-sm space-y-2">
                  <h2 className="text-base font-bold text-slate-900 mb-3">Financial Breakdown</h2>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Subtotal</span>
                    <span>${order.subtotalAmount}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span>Discount</span>
                    <span>-${order.discountAmount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Tax</span>
                    <span>${order.taxAmount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Shipping</span>
                    <span>${order.shippingAmount}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-base">
                    <span>Total</span>
                    <span>${order.totalAmount}</span>
                  </div>
                </Card>

                {order.status === 'DELIVERED' && (
                  <Card className="p-6">
                    <h2 className="text-base font-bold text-slate-900 mb-3">Request Return</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        requestReturn.mutate();
                      }}
                      className="space-y-3"
                    >
                      <select
                        value={selectedReturnItemId || order.items[0]?.id || ''}
                        onChange={(e) => setSelectedReturnItemId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                      >
                        {order.items.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.productTitleSnapshot}
                          </option>
                        ))}
                      </select>
                      <input
                        required
                        placeholder="Return reason (e.g. Damaged / Not as described)"
                        value={returnReason}
                        onChange={(e) => setReturnReason(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                      />
                      <textarea
                        rows={2}
                        placeholder="Additional details"
                        value={returnDesc}
                        onChange={(e) => setReturnDesc(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                      />
                      <Button type="submit" size="sm" disabled={requestReturn.isPending} className="w-full">
                        Submit Return Request
                      </Button>
                    </form>
                  </Card>
                )}
              </div>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={confirmCancel}
          title="Cancel Order?"
          description="Cancelling this order will immediately release any active inventory reservations."
          confirmLabel="Yes, Cancel Order"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => cancelOrder.mutate()}
        />
      </ProtectedRoute>
    </AppShell>
  );
}
