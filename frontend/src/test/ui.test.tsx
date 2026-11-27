import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppProviders } from '@/providers/AppProviders';
import { store, pushToast } from '@/store';
import { StatusBadge, EmptyState, Pagination, Button } from '@/components/ui/UiPrimitives';
import LoginPage from '@/app/login/page';
import ForgotPasswordPage from '@/app/forgot-password/page';

describe('MarketSphere Frontend Components & Auth Validation', () => {
  it('renders semantic status badges cleanly', () => {
    render(<StatusBadge status="PAYMENT_CONFIRMED" />);
    expect(screen.getByText('PAYMENT CONFIRMED')).toBeInTheDocument();
  });

  it('renders empty states and triggers pagination callbacks', () => {
    let nextPage = 1;
    render(
      <div>
        <EmptyState title="No orders" description="Try placing an order." action={<Button>Shop</Button>} />
        <Pagination page={2} totalPages={5} onPageChange={(p) => (nextPage = p)} />
      </div>,
    );
    expect(screen.getByText('No orders')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    expect(nextPage).toBe(3);
  });

  it('renders login form, quick-fill sandbox buttons, and validates bad email input', async () => {
    render(
      <AppProviders>
        <LoginPage />
      </AppProviders>,
    );
    expect(screen.getByText('Sign in to MarketSphere')).toBeInTheDocument();
    const customerQuickBtn = screen.getByText('Customer (Maya Lin)');
    fireEvent.click(customerQuickBtn);
    const emailInput = screen.getByLabelText('Email address') as HTMLInputElement;
    expect(emailInput.value).toBe('customer@marketsphere.test');

    // Clear and submit empty to verify validation error
    fireEvent.change(emailInput, { target: { value: 'invalid-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
  });

  it('caps Redux toast queue at 3 without mutating/returning conflict', () => {
    for (let i = 1; i <= 5; i += 1) {
      store.dispatch(pushToast({ type: 'info', message: `Toast ${i}` }));
    }
    const toasts = store.getState().toast;
    expect(toasts).toHaveLength(3);
    expect(toasts.map((t) => t.message)).toEqual(['Toast 3', 'Toast 4', 'Toast 5']);
  });

  it('renders forgot-password flow switching between request and token confirmation steps', () => {
    render(
      <AppProviders>
        <ForgotPasswordPage />
      </AppProviders>,
    );
    expect(screen.getByText('Reset your password')).toBeInTheDocument();
    expect(screen.getByLabelText('Account email')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2. Confirm Token' }));
    expect(screen.getByLabelText('Reset Token')).toBeInTheDocument();
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
  });
});
