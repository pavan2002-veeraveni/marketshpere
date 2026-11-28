'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDispatch } from 'react-redux';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Card } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage, tokenStorage } from '@/lib/api-client';
import { pushToast, setUser } from '@/store';
import { ApiEnvelope, UserProfile } from '@/types/api';

const registerSchema = z.object({
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  email: z.string().email('Valid email required'),
  password: z
    .string()
    .min(8, 'Min 8 characters')
    .regex(/[A-Z]/, 'Include uppercase letter')
    .regex(/[a-z]/, 'Include lowercase letter')
    .regex(/[0-9]/, 'Include digit'),
  accountType: z.enum(['CUSTOMER', 'SELLER']),
  storeName: z.string().optional(),
});

type RegisterForm = z.infer<typeof registerSchema>;

export default function RegisterPage() {
  const router = useRouter();
  const dispatch = useDispatch();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { accountType: 'CUSTOMER' },
  });

  const accountType = useWatch({ control, name: 'accountType' });

  async function onSubmit(values: RegisterForm) {
    setSubmitting(true);
    try {
      const res = await apiClient.post<
        ApiEnvelope<{ user: UserProfile; accessToken: string; refreshToken: string }>
      >('/auth/register', values);
      tokenStorage.setTokens(res.data.data.accessToken);
      dispatch(setUser(res.data.data.user));
      dispatch(pushToast({ type: 'success', message: 'Account created!' }));
      router.push(values.accountType === 'SELLER' ? '/seller' : '/');
    } catch (err) {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err, 'Registration failed') }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-md py-8">
        <Card className="p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-slate-900">Create your MarketSphere account</h1>
          <p className="mt-1 text-sm text-slate-500">Join as a buyer or launch your vendor store.</p>

          <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">First name</label>
                <input
                  {...register('firstName')}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                {errors.firstName && <p className="mt-1 text-xs text-red-600">{errors.firstName.message}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Last name</label>
                <input
                  {...register('lastName')}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                {errors.lastName && <p className="mt-1 text-xs text-red-600">{errors.lastName.message}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">Account type</label>
              <select
                {...register('accountType')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="CUSTOMER">Customer (Shop & Track Orders)</option>
                <option value="SELLER">Seller (Vendor Store & Inventory)</option>
              </select>
            </div>

            {accountType === 'SELLER' && (
              <div>
                <label className="block text-sm font-medium text-slate-700">Store name</label>
                <input
                  {...register('storeName')}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Horizon Studio Goods"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700">Email</label>
              <input
                type="email"
                {...register('email')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">Password</label>
              <input
                type="password"
                {...register('password')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
            </div>

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Creating account...' : 'Register'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            Already registered?{' '}
            <Link href="/login" className="font-semibold text-blue-700 hover:underline">
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
