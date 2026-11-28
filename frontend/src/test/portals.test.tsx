import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AppProviders } from '@/providers/AppProviders';
import { store, setUser, clearUser } from '@/store';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { tokenStorage, apiClient } from '@/lib/api-client';
import WarehousePortalPage from '@/app/warehouse/page';
import SupportPortalPage from '@/app/support/page';
import AdminDashboardPage from '@/app/admin/page';
import SellerPortalPage from '@/app/seller/page';

// Mock Recharts ResponsiveContainer cleanly inside jsdom
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="recharts-mock" style={{ width: 600, height: 240 }}>
        {children}
      </div>
    ),
  };
});

describe('MarketSphere Security Storage & Portal Component Rendering', () => {
  it('stores access token strictly in memory and never persists tokens in sessionStorage or localStorage', () => {
    tokenStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.clear();

    tokenStorage.setTokens('in_memory_jwt_only');
    expect(tokenStorage.getAccess()).toBe('in_memory_jwt_only');
    expect(window.sessionStorage.getItem('ms_access_token')).toBeNull();
    expect(window.localStorage.getItem('ms_access_token')).toBeNull();
    expect(window.localStorage.getItem('ms_refresh_token')).toBeNull();

    tokenStorage.clear();
    expect(tokenStorage.getAccess()).toBeNull();
  });

  it('enforces role gates in ProtectedRoute', async () => {
    act(() => {
      store.dispatch(
        setUser({
          id: 'u-1',
          email: 'cust@marketsphere.test',
          firstName: 'Maya',
          lastName: 'Lin',
          primaryRole: 'CUSTOMER',
          roles: ['CUSTOMER'],
          permissions: [],
          status: 'ACTIVE',
        }),
      );
    });

    render(
      <AppProviders>
        <ProtectedRoute allowedRoles={['ADMIN']}>
          <div>Secret Admin Panel</div>
        </ProtectedRoute>
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByText('Access Restricted')).toBeInTheDocument());
    expect(screen.queryByText('Secret Admin Panel')).not.toBeInTheDocument();
    act(() => {
      store.dispatch(clearUser());
    });
  });

  it('renders Warehouse, Support, Seller, and Admin portals for authorized roles', async () => {
    const adminUser = {
      id: 'admin-1',
      email: 'admin@marketsphere.test',
      firstName: 'Admin',
      lastName: 'User',
      primaryRole: 'ADMIN' as const,
      roles: ['ADMIN', 'SELLER', 'WAREHOUSE_OPERATOR', 'SUPPORT_AGENT'] as const,
      permissions: [],
      status: 'ACTIVE',
    };
    tokenStorage.setTokens('test-jwt-token');
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return { data: { success: true, data: adminUser } } as never;
      }
      if (url === '/admin/analytics') {
        return {
          data: {
            success: true,
            data: {
              usersCount: 6,
              sellersTotal: 3,
              sellersPending: 0,
              productsActive: 6,
              ordersCount: 10,
              gmv: '1250.00',
              totalCommission: '125.00',
              openDisputes: 1,
              pendingReturns: 0,
              lowStockCount: 1,
              ordersByStatus: { PAYMENT_CONFIRMED: 4, DELIVERED: 6 },
            },
          },
        } as never;
      }
      if (url === '/sellers/me/analytics') {
        return {
          data: {
            success: true,
            data: {
              storeName: 'Apex Studio',
              onboardingStatus: 'APPROVED',
              productsCount: 3,
              ordersCount: 5,
              unitsSold: 8,
              grossSales: '900.00',
              totalCommission: '90.00',
              netEarnings: '810.00',
              topProducts: [],
            },
          },
        } as never;
      }
      return { data: { success: true, data: [] } } as never;
    });

    store.dispatch(setUser({ ...adminUser, roles: [...adminUser.roles] }));

    const { unmount: u1 } = render(
      <AppProviders>
        <WarehousePortalPage />
      </AppProviders>,
    );
    await waitFor(() => expect(screen.getByText('Warehouse Fulfillment & Stock Control')).toBeInTheDocument());
    u1();

    const { unmount: u2 } = render(
      <AppProviders>
        <SupportPortalPage />
      </AppProviders>,
    );
    await waitFor(() => expect(screen.getByText('Customer Support, Returns & Disputes Desk')).toBeInTheDocument());
    u2();

    const { unmount: u3 } = render(
      <AppProviders>
        <SellerPortalPage />
      </AppProviders>,
    );
    await waitFor(() => expect(screen.getByText('Products & Feed Import')).toBeInTheDocument());
    u3();

    const { unmount: u4 } = render(
      <AppProviders>
        <AdminDashboardPage />
      </AppProviders>,
    );
    await waitFor(() => {
      expect(screen.getByText('Marketplace Administration Console')).toBeInTheDocument();
      expect(screen.getByTestId('recharts-mock')).toBeInTheDocument();
    });
    u4();

    vi.restoreAllMocks();
    tokenStorage.clear();
    store.dispatch(clearUser());
  });
});
