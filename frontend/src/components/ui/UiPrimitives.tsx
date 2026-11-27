'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
  const variants = {
    primary: 'bg-blue-700 text-white hover:bg-blue-800 shadow-sm',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-base',
  };
  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Card({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-xs ${className}`}>
      {children}
    </div>
  );
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {icon && <div className="rounded-lg bg-blue-50 p-2.5 text-blue-700">{icon}</div>}
      </div>
    </Card>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  let tone = 'bg-slate-100 text-slate-700 border-slate-200';
  if (['ACTIVE', 'APPROVED', 'CAPTURED', 'DELIVERED', 'PAID', 'SUCCEEDED', 'RESOLVED', 'COMPLETED', 'VERIFIED'].includes(s)) {
    tone = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (['PENDING_PAYMENT', 'SUBMITTED', 'UNDER_REVIEW', 'PROCESSING', 'IN_TRANSIT', 'PENDING_APPROVAL', 'INVESTIGATING', 'OPEN', 'INITIATED', 'REQUESTED'].includes(s)) {
    tone = 'bg-amber-50 text-amber-800 border-amber-200';
  } else if (['CANCELLED', 'REJECTED', 'FAILED', 'SUSPENDED', 'EXPIRED', 'DEAD_LETTER', 'HIDDEN'].includes(s)) {
    tone = 'bg-red-50 text-red-700 border-red-200';
  } else if (['SHIPPED', 'READY_TO_SHIP', 'PAYMENT_CONFIRMED', 'OUT_FOR_DELIVERY', 'ESCALATED', 'REFUNDED', 'SETTLED'].includes(s)) {
    tone = 'bg-blue-50 text-blue-700 border-blue-200';
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function Skeleton({ className = 'h-6 w-full' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200 ${className}`} />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center p-10 text-center">
      <div className="rounded-full bg-slate-100 p-3 text-slate-400">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="mt-3 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-xs font-medium text-slate-500">
      {items.map((item, idx) => (
        <React.Fragment key={item.label}>
          {idx > 0 && <span>/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-slate-900 transition-colors">
              {item.label}
            </Link>
          ) : (
            <span className="text-slate-900">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (nextPage: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4 text-sm">
      <span className="text-slate-600">
        Page <strong>{page}</strong> of <strong>{totalPages}</strong>
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-100 p-2 text-amber-700">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            <p className="mt-1 text-sm text-slate-600">{description}</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="m-6 p-6 border-red-200 bg-red-50">
          <h2 className="text-base font-semibold text-red-900">Something went wrong rendering this view</h2>
          <p className="mt-1 text-sm text-red-700">{this.state.message}</p>
        </Card>
      );
    }
    return this.props.children;
  }
}
