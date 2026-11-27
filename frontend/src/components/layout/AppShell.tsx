'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useDispatch, useSelector } from 'react-redux';
import {
  ShoppingBag,
  ShoppingCart,
  Store,
  Warehouse,
  Headphones,
  ShieldCheck,
  Package,
  User as UserIcon,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { RootState, clearUser, pushToast } from '@/store';
import { apiClient, tokenStorage } from '@/lib/api-client';
import { ErrorBoundary, StatusBadge } from '@/components/ui/UiPrimitives';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const dispatch = useDispatch();
  const { user } = useSelector((s: RootState) => s.auth);
  const cartCount = useSelector((s: RootState) => s.ui.cartCount);
  const [mobileOpen, setMobileOpen] = useState(false);

  const roles = user?.roles ?? [];
  const isSeller = roles.includes('SELLER') || roles.includes('ADMIN');
  const isWarehouse = roles.includes('WAREHOUSE_OPERATOR') || roles.includes('ADMIN');
  const isSupport = roles.includes('SUPPORT_AGENT') || roles.includes('ADMIN');
  const isAdmin = roles.includes('ADMIN');

  const navLinks = [
    { href: '/', label: 'Storefront', icon: ShoppingBag, show: true },
    { href: '/orders', label: 'My Orders', icon: Package, show: Boolean(user) },
    { href: '/account', label: 'Account', icon: UserIcon, show: Boolean(user) },
    { href: '/seller', label: 'Seller Portal', icon: Store, show: isSeller },
    { href: '/warehouse', label: 'Warehouse', icon: Warehouse, show: isWarehouse },
    { href: '/support', label: 'Support Desk', icon: Headphones, show: isSupport },
    { href: '/admin', label: 'Admin Console', icon: ShieldCheck, show: isAdmin },
  ].filter((item) => item.show);

  async function handleLogout() {
    try {
      await apiClient.post('/auth/logout', {});
    } catch {
      // Ignore network errors during logout cleanup
    } finally {
      tokenStorage.clear();
      dispatch(clearUser());
      dispatch(pushToast({ type: 'info', message: 'Signed out cleanly.' }));
      router.push('/login');
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(!mobileOpen)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Toggle navigation menu"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <Link href="/" className="flex items-center gap-2.5 font-bold text-slate-900 text-lg tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-700 text-white text-sm font-black">
                MS
              </span>
              <span>MarketSphere</span>
            </Link>
          </div>

          <nav className="hidden lg:flex items-center gap-1" aria-label="Main navigation">
            {navLinks.map((item) => {
              const Icon = item.icon;
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
                    active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/cart"
              className="relative inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ShoppingCart className="h-4 w-4" />
              <span className="hidden sm:inline">Cart</span>
              {cartCount > 0 && (
                <span className="rounded-full bg-blue-700 px-1.5 py-0.5 text-[11px] font-bold text-white">
                  {cartCount}
                </span>
              )}
            </Link>

            {user ? (
              <div className="flex items-center gap-2.5">
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-xs font-semibold text-slate-900">
                    {user.firstName} {user.lastName}
                  </span>
                  <StatusBadge status={user.primaryRole} />
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800"
                >
                  Create account
                </Link>
              </div>
            )}
          </div>
        </div>

        {mobileOpen && (
          <div className="border-t border-slate-200 bg-white px-4 py-3 lg:hidden">
            <div className="flex flex-col gap-1">
              {navLinks.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>

      <footer className="border-t border-slate-200 bg-white py-5 text-xs text-slate-500">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 sm:px-6 lg:px-8">
          <span>MarketSphere Enterprise Multi-Vendor Commerce Platform (Sandbox Mode)</span>
          <span>PostgreSQL Authoritative Ledger &bull; FastAPI Pricing & Recommendations &bull; BullMQ Workers</span>
        </div>
      </footer>
    </div>
  );
}
