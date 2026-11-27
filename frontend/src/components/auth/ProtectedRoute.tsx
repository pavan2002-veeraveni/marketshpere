'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSelector } from 'react-redux';
import { RootState } from '@/store';
import { RoleName } from '@/types/api';
import { Card, Skeleton } from '@/components/ui/UiPrimitives';

export function ProtectedRoute({
  allowedRoles,
  children,
}: {
  allowedRoles?: RoleName[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, hydrated } = useSelector((s: RootState) => s.auth);

  useEffect(() => {
    if (hydrated && !user) {
      router.replace('/login');
    }
  }, [hydrated, user, router]);

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!user) return null;

  if (allowedRoles && allowedRoles.length > 0) {
    const authorized = user.roles.some((r) => allowedRoles.includes(r));
    if (!authorized) {
      return (
        <Card className="p-8 text-center border-red-200 bg-red-50">
          <h2 className="text-lg font-bold text-red-900">Access Restricted</h2>
          <p className="mt-1 text-sm text-red-700">
            Your role ({user.primaryRole}) does not have permission to access this portal.
          </p>
        </Card>
      );
    }
  }

  return <>{children}</>;
}
