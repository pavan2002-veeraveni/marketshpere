'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDispatch } from 'react-redux';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Card } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast } from '@/store';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const dispatch = useDispatch();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiClient.post('/auth/password-reset/request', { email });
      dispatch(
        pushToast({
          type: 'success',
          message: 'If the email exists, reset instructions have been queued to your inbox.',
        }),
      );
      setStep('confirm');
    } catch (err) {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiClient.post('/auth/password-reset/confirm', { token, newPassword });
      dispatch(pushToast({ type: 'success', message: 'Password updated cleanly. Please sign in.' }));
      router.push('/login');
    } catch (err) {
      dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-md py-8">
        <Card className="p-6 sm:p-8 space-y-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Reset your password</h1>
            <p className="mt-1 text-sm text-slate-500">
              Request a single-use reset token or confirm with an active token.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={step === 'request' ? 'primary' : 'secondary'}
              onClick={() => setStep('request')}
            >
              1. Request Reset
            </Button>
            <Button
              type="button"
              size="sm"
              variant={step === 'confirm' ? 'primary' : 'secondary'}
              onClick={() => setStep('confirm')}
            >
              2. Confirm Token
            </Button>
          </div>

          {step === 'request' ? (
            <form onSubmit={handleRequest} className="space-y-4">
              <div>
                <label htmlFor="reset-email" className="block text-sm font-medium text-slate-700">
                  Account email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="you@example.com"
                />
              </div>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? 'Submitting...' : 'Send Reset Instructions'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleConfirm} className="space-y-4">
              <div>
                <label htmlFor="reset-token" className="block text-sm font-medium text-slate-700">
                  Reset Token
                </label>
                <input
                  id="reset-token"
                  required
                  minLength={20}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  placeholder="Paste reset token"
                />
              </div>
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-slate-700">
                  New Password
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Min 8 chars, upper/lower/digit"
                />
              </div>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? 'Updating Password...' : 'Reset Password'}
              </Button>
            </form>
          )}

          <p className="text-center text-sm text-slate-600">
            Remembered it?{' '}
            <Link href="/login" className="font-semibold text-blue-700 hover:underline">
              Back to Sign in
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
