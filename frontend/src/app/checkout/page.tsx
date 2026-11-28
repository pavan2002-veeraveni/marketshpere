'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch } from 'react-redux';
import { CreditCard, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast, setCartCount } from '@/store';
import { ApiEnvelope, CartData, OrderRecord } from '@/types/api';

interface AddressItem {
  id: string;
  label: string;
  recipientName: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  isDefault: boolean;
}

export default function CheckoutPage() {
  const router = useRouter();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();

  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [discountCode, setDiscountCode] = useState(() => {
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search).get('coupon') ?? '';
    }
    return '';
  });
  const [recipientName, setRecipientName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [phone, setPhone] = useState('');
  const [placedOrder, setPlacedOrder] = useState<
    (OrderRecord & { payment?: { id: string; status: string; amount: string; failureMessage?: string | null } }) | null
  >(null);
  const [idempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID ? `chk_${crypto.randomUUID()}` : `chk_${Date.now()}`,
  );

  const addressesQuery = useQuery({
    queryKey: ['addresses'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<AddressItem[]>>('/users/me/addresses');
      return res.data.data;
    },
  });

  const activeAddressId =
    selectedAddressId || (addressesQuery.data?.find((a) => a.isDefault) ?? addressesQuery.data?.[0])?.id || '';

  const cartQuery = useQuery({
    queryKey: ['cart', discountCode],
    enabled: !placedOrder,
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<CartData>>('/cart', {
        params: discountCode ? { discountCode } : {},
      });
      return res.data.data;
    },
  });

  const placeOrder = useMutation({
    mutationFn: async () => {
      const body =
        activeAddressId && activeAddressId !== 'NEW'
          ? { addressId: activeAddressId, discountCode: discountCode || undefined }
          : {
              shippingAddress: { recipientName, line1, city, state: stateVal, postalCode, country: 'US', phone },
              discountCode: discountCode || undefined,
            };
      const res = await apiClient.post<
        ApiEnvelope<OrderRecord & { payment: { id: string; status: string; amount: string; failureMessage?: string | null } }>
      >(
        '/checkout',
        body,
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      return res.data.data;
    },
    onSuccess: (order) => {
      setPlacedOrder(order);
      dispatch(setCartCount(0));
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      dispatch(pushToast({ type: 'success', message: `Order ${order.orderNumber} reserved! Complete sandbox payment.` }));
    },
    onError: (err) => {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err, 'Checkout failed') }));
    },
  });

  const sandboxPay = useMutation({
    mutationFn: async ({ paymentId, outcome }: { paymentId: string; outcome: 'SUCCEED' | 'FAIL' }) => {
      const res = await apiClient.post<ApiEnvelope<{ order: OrderRecord }>>(
        `/payments/${paymentId}/confirm-sandbox`,
        { outcome },
      );
      return res.data.data.order;
    },
    onSuccess: (updatedOrder) => {
      setPlacedOrder(updatedOrder);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      dispatch(
        pushToast({
          type: updatedOrder.status === 'PAYMENT_CONFIRMED' ? 'success' : 'error',
          message:
            updatedOrder.status === 'PAYMENT_CONFIRMED'
              ? 'Payment confirmed! Inventory committed.'
              : 'Sandbox payment declined; you can retry.',
        }),
      );
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const retryPayment = useMutation({
    mutationFn: async (paymentId: string) => {
      await apiClient.post(`/payments/${paymentId}/retry`);
      const orderRes = await apiClient.get<ApiEnvelope<OrderRecord>>(`/orders/${placedOrder!.id}`);
      return orderRes.data.data;
    },
    onSuccess: (updatedOrder) => {
      setPlacedOrder(updatedOrder);
      dispatch(pushToast({ type: 'info', message: 'Payment intent reset for retry.' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const activePayment = placedOrder?.payments?.[0] ?? placedOrder?.payment;

  return (
    <AppShell>
      <ProtectedRoute>
        <Breadcrumbs items={[{ label: 'Cart', href: '/cart' }, { label: 'Checkout & Payment' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Checkout & Sandbox Payment</h1>

        {placedOrder ? (
          <Card className="mx-auto max-w-2xl p-6 sm:p-8 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Order Reference</p>
                <h2 className="text-xl font-bold text-slate-900">{placedOrder.orderNumber}</h2>
              </div>
              <StatusBadge status={placedOrder.status} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm space-y-1">
              <div className="flex justify-between">
                <span>Order Total:</span>
                <strong className="text-lg">${placedOrder.totalAmount}</strong>
              </div>
              <div className="flex justify-between">
                <span>Payment Status:</span>
                <StatusBadge status={activePayment?.status ?? 'INITIATED'} />
              </div>
              {activePayment?.failureMessage && (
                <p className="text-xs text-red-600 pt-1">{activePayment.failureMessage}</p>
              )}
            </div>

            {placedOrder.status === 'PENDING_PAYMENT' && activePayment && (
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <CreditCard className="h-4 w-4 text-blue-700" />
                  Sandbox Payment Gateway (No real card numbers collected)
                </div>

                {activePayment.status === 'FAILED' ? (
                  <Button
                    onClick={() => retryPayment.mutate(activePayment.id)}
                    disabled={retryPayment.isPending}
                    className="w-full"
                  >
                    <RefreshCw className="h-4 w-4" /> Retry Payment Intent
                  </Button>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Button
                      onClick={() => sandboxPay.mutate({ paymentId: activePayment.id, outcome: 'SUCCEED' })}
                      disabled={sandboxPay.isPending}
                      className="bg-emerald-600 hover:bg-emerald-700"
                    >
                      <CheckCircle2 className="h-4 w-4" /> Simulate Payment Success
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => sandboxPay.mutate({ paymentId: activePayment.id, outcome: 'FAIL' })}
                      disabled={sandboxPay.isPending}
                    >
                      <AlertTriangle className="h-4 w-4" /> Simulate Payment Failure
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => router.push(`/orders/${placedOrder.id}`)}>
                Track Order Details
              </Button>
              <Button onClick={() => router.push('/orders')}>View All Orders</Button>
            </div>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2 p-6 space-y-5">
              <h2 className="text-lg font-bold text-slate-900">1. Shipping Address</h2>
              <div className="space-y-2">
                {addressesQuery.data?.map((addr) => (
                  <label
                    key={addr.id}
                    className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer ${
                      activeAddressId === addr.id ? 'border-blue-700 bg-blue-50/40' : 'border-slate-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="addr"
                      checked={activeAddressId === addr.id}
                      onChange={() => setSelectedAddressId(addr.id)}
                      className="mt-1"
                    />
                    <div className="text-sm">
                      <p className="font-semibold text-slate-900">
                        {addr.label} — {addr.recipientName}
                      </p>
                      <p className="text-slate-600">
                        {addr.line1}, {addr.city}, {addr.state} {addr.postalCode}, {addr.country}
                      </p>
                    </div>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm font-medium text-blue-700 cursor-pointer pt-1">
                  <input
                    type="radio"
                    name="addr"
                    checked={activeAddressId === 'NEW' || !addressesQuery.data?.length}
                    onChange={() => setSelectedAddressId('NEW')}
                  />
                  Enter a new shipping address
                </label>
              </div>

              {(activeAddressId === 'NEW' || !addressesQuery.data?.length) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <input
                    placeholder="Recipient Name"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="Phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="Street Address Line 1"
                    value={line1}
                    onChange={(e) => setLine1(e.target.value)}
                    className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="City"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="State"
                      value={stateVal}
                      onChange={(e) => setStateVal(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <input
                      placeholder="Postal Code"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              )}

              <div className="border-t border-slate-200 pt-4">
                <h2 className="text-lg font-bold text-slate-900 mb-2">2. Promotion Code</h2>
                <input
                  placeholder="Optional discount code (e.g. WELCOME10)"
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
                  className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
                />
              </div>
            </Card>

            <Card className="p-6 h-fit space-y-4">
              <h2 className="text-lg font-bold text-slate-900">Checkout Summary</h2>
              {cartQuery.data ? (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Items ({cartQuery.data.items.length})</dt>
                    <dd>${cartQuery.data.pricing.subtotalAmount}</dd>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <dt>Discount</dt>
                    <dd>-${cartQuery.data.pricing.discountAmount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Tax</dt>
                    <dd>${cartQuery.data.pricing.taxAmount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Shipping</dt>
                    <dd>${cartQuery.data.pricing.shippingAmount}</dd>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-3 text-base font-bold">
                    <dt>Total Due</dt>
                    <dd>${cartQuery.data.pricing.totalAmount}</dd>
                  </div>
                </dl>
              ) : null}

              <Button
                className="w-full"
                size="lg"
                disabled={placeOrder.isPending || !cartQuery.data?.items.length}
                onClick={() => placeOrder.mutate()}
              >
                {placeOrder.isPending ? 'Reserving Inventory...' : 'Reserve Stock & Place Order'}
              </Button>
              <p className="text-[11px] text-slate-400">
                Inventory is locked transactionally in PostgreSQL (`SELECT ... FOR UPDATE`) for 15 minutes.
              </p>
            </Card>
          </div>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
