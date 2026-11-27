'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card, EmptyState, Pagination, Skeleton, StatusBadge } from '@/components/ui/UiPrimitives';
import { apiClient } from '@/lib/api-client';
import { ApiEnvelope, OrderRecord } from '@/types/api';

export default function OrdersPage() {
  const [page, setPage] = useState(1);

  const ordersQuery = useQuery({
    queryKey: ['orders', page],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders', { params: { page, limit: 10 } });
      return res.data;
    },
  });

  return (
    <AppShell>
      <ProtectedRoute>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'My Orders' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Order History & Tracking</h1>

        {ordersQuery.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !ordersQuery.data?.data.length ? (
          <EmptyState
            title="No orders yet"
            description="When you place an order, you can track fulfillment, shipments, returns, and refunds here."
            action={
              <Link href="/">
                <Button>Start Shopping</Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="space-y-4">
              {ordersQuery.data.data.map((order) => (
                <Card key={order.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{order.orderNumber}</p>
                      <p className="text-xs text-slate-500">
                        Placed {new Date(order.placedAt).toLocaleString()} &bull; {order.items.length} item(s)
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={order.status} />
                      <span className="text-base font-bold text-slate-900">${order.totalAmount}</span>
                      <Link href={`/orders/${order.id}`}>
                        <Button variant="secondary" size="sm">
                          View / Track
                        </Button>
                      </Link>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
                    {order.items.map((item) => (
                      <span key={item.id} className="rounded-md bg-slate-100 px-2.5 py-1">
                        {item.productTitleSnapshot} &times; {item.quantity}
                      </span>
                    ))}
                  </div>
                </Card>
              ))}
            </div>

            <Pagination
              page={ordersQuery.data.meta.page}
              totalPages={ordersQuery.data.meta.totalPages}
              onPageChange={setPage}
            />
          </>
        )}
      </ProtectedRoute>
    </AppShell>
  );
}
