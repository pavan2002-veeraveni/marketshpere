'use client';

import React, { useEffect, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { clearUser, dismissToast, RootState, setUser, store } from '@/store';
import { apiClient, refreshAccessTokenSingleFlight, tokenStorage } from '@/lib/api-client';
import { ApiEnvelope, UserProfile } from '@/types/api';

function SessionBootstrap({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      let token = tokenStorage.getAccess();
      if (!token) {
        // Silent refresh via HttpOnly ms_refresh_token + Double-Submit CSRF header
        if (typeof document !== 'undefined' && document.cookie.includes('ms_csrf_token=')) {
          token = await refreshAccessTokenSingleFlight();
        }
      }
      if (!token) {
        if (active && !store.getState().auth.hydrated) {
          dispatch(clearUser());
        }
        return;
      }
      try {
        const res = await apiClient.get<ApiEnvelope<UserProfile>>('/auth/me');
        if (active) dispatch(setUser(res.data.data));
      } catch {
        tokenStorage.clear();
        if (active) dispatch(clearUser());
      }
    }
    void restoreSession();
    return () => {
      active = false;
    };
  }, [dispatch]);

  return <>{children}</>;
}

function ToastViewport() {
  const toasts = useSelector((s: RootState) => s.toast);
  const dispatch = useDispatch();

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => dispatch(dismissToast(t.id)), 4500));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dispatch]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 shadow-lg text-sm font-medium bg-white ${
            toast.type === 'error'
              ? 'border-red-200 text-red-800'
              : toast.type === 'success'
                ? 'border-emerald-200 text-emerald-800'
                : 'border-slate-200 text-slate-800'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
          ) : toast.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          )}
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => dispatch(dismissToast(toast.id))}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <SessionBootstrap>
          {children}
          <ToastViewport />
        </SessionBootstrap>
      </QueryClientProvider>
    </Provider>
  );
}
