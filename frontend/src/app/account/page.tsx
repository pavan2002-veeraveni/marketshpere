'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDispatch, useSelector } from 'react-redux';
import { Bell, MapPin, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Breadcrumbs, Button, Card } from '@/components/ui/UiPrimitives';
import { apiClient, extractErrorMessage } from '@/lib/api-client';
import { pushToast, RootState, setUser } from '@/store';
import { ApiEnvelope, UserProfile } from '@/types/api';

interface AddressItem {
  id: string;
  label: string;
  recipientName: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  isDefault: boolean;
}

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt?: string | null;
  createdAt: string;
}

export default function AccountPage() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const user = useSelector((s: RootState) => s.auth.user);

  const [firstNameDraft, setFirstNameDraft] = useState<string | null>(null);
  const [lastNameDraft, setLastNameDraft] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState<string | null>(null);
  const firstName = firstNameDraft ?? user?.firstName ?? '';
  const lastName = lastNameDraft ?? user?.lastName ?? '';
  const phone = phoneDraft ?? user?.phone ?? '';

  const [addrLabel, setAddrLabel] = useState('Office');
  const [recipientName, setRecipientName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateVal, setStateVal] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [addrPhone, setAddrPhone] = useState('');

  const addressesQuery = useQuery({
    queryKey: ['addresses'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<AddressItem[]>>('/users/me/addresses');
      return res.data.data;
    },
  });

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await apiClient.get<ApiEnvelope<NotificationItem[]>>('/users/me/notifications');
      return res.data.data;
    },
  });

  const updateProfile = useMutation({
    mutationFn: async () => {
      const res = await apiClient.patch<ApiEnvelope<UserProfile>>('/users/me', { firstName, lastName, phone });
      return res.data.data;
    },
    onSuccess: (updated) => {
      if (user) dispatch(setUser({ ...user, ...updated }));
      dispatch(pushToast({ type: 'success', message: 'Profile saved' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const createAddress = useMutation({
    mutationFn: async () => {
      await apiClient.post('/users/me/addresses', {
        label: addrLabel,
        recipientName,
        line1,
        city,
        state: stateVal,
        postalCode,
        country: 'US',
        phone: addrPhone,
        isDefault: true,
      });
    },
    onSuccess: () => {
      setLine1('');
      setCity('');
      setStateVal('');
      setPostalCode('');
      queryClient.invalidateQueries({ queryKey: ['addresses'] });
      dispatch(pushToast({ type: 'success', message: 'Address added' }));
    },
    onError: (err) => dispatch(pushToast({ type: 'error', message: extractErrorMessage(err) })),
  });

  const deleteAddress = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/users/me/addresses/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['addresses'] }),
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => apiClient.patch(`/users/me/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <AppShell>
      <ProtectedRoute>
        <Breadcrumbs items={[{ label: 'Storefront', href: '/' }, { label: 'My Account' }]} />
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Account, Addresses & Notifications</h1>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4">Profile Settings</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                updateProfile.mutate();
              }}
              className="space-y-3"
            >
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={firstName}
                  onChange={(e) => setFirstNameDraft(e.target.value)}
                  placeholder="First name"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  value={lastName}
                  onChange={(e) => setLastNameDraft(e.target.value)}
                  placeholder="Last name"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <input
                value={phone}
                onChange={(e) => setPhoneDraft(e.target.value)}
                placeholder="Phone"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={updateProfile.isPending}>
                Save Profile
              </Button>
            </form>
          </Card>

          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-700" /> Notifications
            </h2>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {!notificationsQuery.data?.length ? (
                <p className="text-sm text-slate-500">No notifications yet.</p>
              ) : (
                notificationsQuery.data.map((n) => (
                  <div
                    key={n.id}
                    className={`rounded-lg border p-3 text-xs ${n.readAt ? 'bg-white border-slate-200' : 'bg-blue-50/50 border-blue-200'}`}
                  >
                    <div className="flex items-center justify-between font-semibold text-slate-900">
                      <span>{n.title}</span>
                      {!n.readAt && (
                        <button
                          type="button"
                          onClick={() => markRead.mutate(n.id)}
                          className="text-blue-700 hover:underline cursor-pointer"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-slate-600">{n.message}</p>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card className="lg:col-span-2 p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <MapPin className="h-4 w-4 text-blue-700" /> Saved Shipping Addresses
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {addressesQuery.data?.map((addr) => (
                <div key={addr.id} className="rounded-xl border border-slate-200 p-4 flex justify-between text-sm">
                  <div>
                    <p className="font-semibold">
                      {addr.label} {addr.isDefault && <span className="text-xs text-blue-700">(Default)</span>}
                    </p>
                    <p className="text-slate-600">
                      {addr.recipientName} &bull; {addr.line1}, {addr.city}, {addr.state} {addr.postalCode}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteAddress.mutate(addr.id)}
                    className="text-red-600 hover:text-red-800 cursor-pointer"
                    aria-label="Delete address"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                createAddress.mutate();
              }}
              className="grid grid-cols-1 sm:grid-cols-3 gap-2 border-t border-slate-200 pt-4"
            >
              <input
                required
                placeholder="Label (Home/Work)"
                value={addrLabel}
                onChange={(e) => setAddrLabel(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <input
                required
                placeholder="Recipient Name"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <input
                required
                placeholder="Phone"
                value={addrPhone}
                onChange={(e) => setAddrPhone(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <input
                required
                placeholder="Street Line 1"
                value={line1}
                onChange={(e) => setLine1(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <input
                required
                placeholder="City"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <div className="flex gap-2">
                <input
                  required
                  placeholder="State"
                  value={stateVal}
                  onChange={(e) => setStateVal(e.target.value)}
                  className="w-1/2 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <input
                  required
                  placeholder="ZIP"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  className="w-1/2 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
              <Button type="submit" size="sm" disabled={createAddress.isPending}>
                Add Shipping Address
              </Button>
            </form>
          </Card>
        </div>
      </ProtectedRoute>
    </AppShell>
  );
}
