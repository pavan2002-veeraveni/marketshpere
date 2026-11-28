'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDispatch } from 'react-redux';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Card } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage, tokenStorage } from '@/lib/api-client';
import { pushToast, setUser } from '@/store';
import { ApiEnvelope, UserProfile } from '@/types/api';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

const DEMO_ACCOUNTS = [
  { label: 'Customer (Maya Lin)', email: 'customer@marketsphere.test' },
  { label: 'Seller (Apex Studio)', email: 'seller1@marketsphere.test' },
  { label: 'Warehouse Operator', email: 'warehouse@marketsphere.test' },
  { label: 'Support Agent', email: 'support@marketsphere.test' },
  { label: 'Marketplace Admin', email: 'admin@marketsphere.test' },
];

export default function LoginPage() {
  const router = useRouter();
  const dispatch = useDispatch();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(values: LoginForm) {
    setSubmitting(true);
    try {
      const res = await apiClient.post<
        ApiEnvelope<{ user: UserProfile; accessToken: string; refreshToken: string }>
      >('/auth/login', values);
      tokenStorage.setTokens(res.data.data.accessToken);
      dispatch(setUser(res.data.data.user));
      dispatch(pushToast({ type: 'success', message: `Welcome back, ${res.data.data.user.firstName}!` }));

      const role = res.data.data.user.primaryRole;
      if (role === 'SELLER') router.push('/seller');
      else if (role === 'WAREHOUSE_OPERATOR') router.push('/warehouse');
      else if (role === 'SUPPORT_AGENT') router.push('/support');
      else if (role === 'ADMIN') router.push('/admin');
      else router.push('/');
    } catch (err) {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err, 'Sign in failed') }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-md py-8">
        <Card className="p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-slate-900">Sign in to MarketSphere</h1>
          <p className="mt-1 text-sm text-slate-500">Access your storefront, seller, warehouse, support, or admin portal.</p>

          <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Email address
              </label>
              <input
                id="email"
                type="email"
                {...register('email')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                placeholder="you@example.com"
              />
              {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                {...register('password')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                placeholder="••••••••"
              />
              {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
            </div>

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Signing in...' : 'Sign in'}
            </Button>

            <div className="text-right">
              <Link href="/forgot-password" className="text-xs font-medium text-blue-700 hover:underline">
                Forgot password?
              </Link>
            </div>
          </form>

          <div className="mt-6 border-t border-slate-200 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Synthetic Sandbox Quick-Fill (Password: MarketSphere#2026)
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((acct) => (
                <button
                  key={acct.email}
                  type="button"
                  onClick={() => {
                    setValue('email', acct.email);
                    setValue('password', 'MarketSphere#2026');
                  }}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-blue-50 hover:border-blue-200 cursor-pointer"
                >
                  {acct.label}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-slate-600">
            New to MarketSphere?{' '}
            <Link href="/register" className="font-semibold text-blue-700 hover:underline">
              Create an account
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
