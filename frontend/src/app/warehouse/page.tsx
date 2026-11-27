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

export default function WarehousePortalPage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'fulfillment' | 'inventory' | 'reservations' | 'ledger'>('fulfillment');

  const [skuId, setSkuId] = useState('');
  const [whId, setWhId] = useState('');
  const [qty, setQty] = useState('5');
  const [moveType, setMoveType] = useState<'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGED' | 'RETURN_RESTOCK'>(
    'ADJUSTMENT_IN',
  );

  const ordersQuery = useQuery({
    queryKey: ['wh-orders'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders', { params: { limit: 30 } });
      return res.data.data;
    },
  });

  const shipmentsQuery = useQuery({
    queryKey: ['wh-shipments'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; trackingNumber: string; status: string; order: { orderNumber: string }; warehouse: { code: string } }>>
      >('/shipments');
      return res.data.data;
    },
  });

  const inventoryQuery = useQuery({
    queryKey: ['wh-inventory'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{
            id: string;
            skuId: string;
            warehouseId: string;
            onHandQty: number;
            reservedQty: number;
            damagedQty: number;
            availableQty: number;
            warehouse: { code: string };
            sku: { skuCode: string; product: { title: string } };
          }>
        >
      >('/inventory');
      return res.data.data;
    },
  });

  const reservationsQuery = useQuery({
    queryKey: ['wh-reservations'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<Array<{ id: string; quantity: number; status: string; expiresAt: string; sku: { skuCode: string }; order: { orderNumber: string } }>>
      >('/inventory/reservations');
      return res.data.data;
    },
  });

  const ledgerQuery = useQuery({
    queryKey: ['wh-ledger'],
    queryFn: async () => {
      const res = await apiClient.get<
        ApiEnvelope<
          Array<{ id: string; movementType: string; quantityDelta: number; balanceAfter: number; createdAt: string; sku: { skuCode: string }; warehouse: { code: string } }>
        >
      >('/inventory/ledger');
      return res.data.data;
    },
  });

  const createShipment = useMutation({
    mutationFn: async (orderId: string) => apiClient.post('/shipments', { orderId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wh-orders'] });
      queryClient.invalidateQueries({ queryKey: ['wh-shipments'] });
      dispatch(pushToast({ type: 'success', message: 'Shipment label created' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const updateShipment = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/shipments/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wh-shipments'] });
      queryClient.invalidateQueries({ queryKey: ['wh-orders'] });
      dispatch(pushToast({ type: 'success', message: 'Shipment status updated' }));
    },
  });

  const adjustStock = useMutation({
    mutationFn: async () =>
      apiClient.post('/inventory/adjust', {
        skuId,
        warehouseId: whId,
        movementType: moveType,
        quantity: Number(qty),
        notes: 'Warehouse operator adjustment',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wh-inventory'] });
      queryClient.invalidateQueries({ queryKey: ['wh-ledger'] });
      dispatch(pushToast({ type: 'success', message: 'Warehouse stock updated' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const releaseExpired = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<ApiEnvelope<{ releasedCount: number }>>('/inventory/reservations/release-expired');
      return res.data.data;
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ['wh-reservations'] });
      queryClient.invalidateQueries({ queryKey: ['wh-inventory'] });
      dispatch(pushToast({ type: 'info', message: `Released ${d.releasedCount} expired reservation(s)` }));
    },
  });

  return (
    <AppShell>
      <ProtectedRoute allowedRoles={['WAREHOUSE_OPERATOR', 'ADMIN']}>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'Warehouse Operations' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Warehouse Fulfillment & Stock Control</h1>

        <div className="mb-6 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
          {(
            [
              ['fulfillment', 'Pick, Pack & Shipments'],
              ['inventory', 'Inventory & Adjustments'],
              ['reservations', 'Stock Reservations'],
              ['ledger', 'Movement Ledger'],
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

        {tab === 'fulfillment' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <h2 className="text-base font-bold mb-3">Allocated Orders Queue</h2>
              <div className="space-y-3">
                {ordersQuery.data
                  ?.filter((o) => ['PAYMENT_CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'].includes(o.status))
                  .map((ord) => (
                    <div key={ord.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs">
                      <div>
                        <p className="font-bold">{ord.orderNumber}</p>
                        <p className="text-slate-500">{ord.items.length} item(s)</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={ord.status} />
                        <Button size="sm" onClick={() => createShipment.mutate(ord.id)}>
                          Generate Label
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-base font-bold mb-3">Active Shipments Handoff</h2>
              <div className="space-y-3">
                {shipmentsQuery.data?.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
                    <div>
                      <p className="font-mono font-bold">{s.trackingNumber}</p>
                      <p className="text-slate-500">
                        {s.order.orderNumber} &bull; {s.warehouse.code}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={s.status} />
                      {s.status === 'READY_TO_SHIP' && (
                        <Button size="sm" onClick={() => updateShipment.mutate({ id: s.id, status: 'IN_TRANSIT' })}>
                          Hand Off
                        </Button>
                      )}
                      {s.status === 'IN_TRANSIT' && (
                        <Button size="sm" onClick={() => updateShipment.mutate({ id: s.id, status: 'DELIVERED' })}>
                          Mark Delivered
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'inventory' && (
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="text-base font-bold mb-3">Record Stock Movement / Damage</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  adjustStock.mutate();
                }}
                className="flex flex-wrap gap-2"
              >
                <select
                  required
                  value={skuId ? `${skuId}:${whId}` : ''}
                  onChange={(e) => {
                    const [s, w] = e.target.value.split(':');
                    setSkuId(s ?? '');
                    setWhId(w ?? '');
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                >
                  <option value="">Select Inventory Row...</option>
                  {inventoryQuery.data?.map((inv) => (
                    <option key={inv.id} value={`${inv.skuId}:${inv.warehouseId}`}>
                      {inv.sku.skuCode} ({inv.warehouse.code}) — OnHand: {inv.onHandQty}
                    </option>
                  ))}
                </select>
                <select
                  value={moveType}
                  onChange={(e) => setMoveType(e.target.value as typeof moveType)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                >
                  <option value="ADJUSTMENT_IN">Receive Stock (+)</option>
                  <option value="ADJUSTMENT_OUT">Write-off (-)</option>
                  <option value="DAMAGED">Damaged (-)</option>
                  <option value="RETURN_RESTOCK">Return Restock (+)</option>
                </select>
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Button type="submit" size="sm" disabled={!skuId}>
                  Commit Movement
                </Button>
              </form>
            </Card>

            <Card className="p-6 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2">SKU</th>
                    <th>Warehouse</th>
                    <th>On Hand</th>
                    <th>Reserved</th>
                    <th>Damaged</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inventoryQuery.data?.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2 font-mono">{i.sku.skuCode}</td>
                      <td>{i.warehouse.code}</td>
                      <td>{i.onHandQty}</td>
                      <td>{i.reservedQty}</td>
                      <td>{i.damagedQty}</td>
                      <td className="font-bold">{i.availableQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {tab === 'reservations' && (
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">Stock Reservations Monitor</h2>
              <Button size="sm" variant="secondary" onClick={() => releaseExpired.mutate()}>
                Sweep & Release Expired
              </Button>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2">Order</th>
                  <th>SKU</th>
                  <th>Qty</th>
                  <th>Status</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reservationsQuery.data?.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 font-semibold">{r.order.orderNumber}</td>
                    <td className="font-mono">{r.sku.skuCode}</td>
                    <td>{r.quantity}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>{new Date(r.expiresAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === 'ledger' && (
          <Card className="p-6 overflow-x-auto">
            <h2 className="text-base font-bold mb-3">Immutable Stock Movement Ledger</h2>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2">Time</th>
                  <th>SKU</th>
                  <th>Warehouse</th>
                  <th>Movement</th>
                  <th>Delta</th>
                  <th>Balance After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledgerQuery.data?.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2">{new Date(l.createdAt).toLocaleString()}</td>
                    <td className="font-mono">{l.sku.skuCode}</td>
                    <td>{l.warehouse.code}</td>
                    <td>{l.movementType}</td>
                    <td className={l.quantityDelta >= 0 ? 'text-emerald-700 font-bold' : 'text-red-600 font-bold'}>
                      {l.quantityDelta > 0 ? `+${l.quantityDelta}` : l.quantityDelta}
                    </td>
                    <td>{l.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
