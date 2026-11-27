import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { ApiEnvelope } from '@/types/api';

const baseURL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

const ACCESS_KEY = 'ms_access_token';
const LEGACY_REFRESH_KEY = 'ms_refresh_token';

let inMemoryAccessToken: string | null = null;

export const tokenStorage = {
  getAccess(): string | null {
    if (inMemoryAccessToken) return inMemoryAccessToken;
    if (typeof window === 'undefined') return null;
    inMemoryAccessToken = window.sessionStorage.getItem(ACCESS_KEY);
    return inMemoryAccessToken;
  },
  getRefresh(): string | null {
    // Refresh token is managed strictly as an HttpOnly cookie by /api/v1/auth
    return null;
  },
  setTokens(accessToken: string, _refreshToken?: string) {
    inMemoryAccessToken = accessToken;
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(ACCESS_KEY, accessToken);
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(LEGACY_REFRESH_KEY);
  },
  clear() {
    inMemoryAccessToken = null;
    if (typeof window === 'undefined') return;
    window.sessionStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(LEGACY_REFRESH_KEY);
  },
};

export const apiClient = axios.create({
  baseURL,
  timeout: 15000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStorage.getAccess();
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string; code?: string }>) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original._retry && !original.url?.includes('/auth/refresh')) {
      original._retry = true;
      if (!refreshPromise) {
        refreshPromise = axios
          .post<ApiEnvelope<{ accessToken: string }>>(
            `${baseURL}/auth/refresh`,
            {},
            { withCredentials: true },
          )
          .then((res) => {
            tokenStorage.setTokens(res.data.data.accessToken);
            return res.data.data.accessToken;
          })
          .catch(() => {
            tokenStorage.clear();
            return null;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      const nextToken = await refreshPromise;
      if (nextToken && original.headers) {
        original.headers.Authorization = `Bearer ${nextToken}`;
        return apiClient(original);
      }
    }
    return Promise.reject(error);
  },
);

export function extractErrorMessage(err: unknown, fallback = 'Operation failed'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string; details?: Array<{ message?: string }> } | undefined;
    if (data?.details?.length && data.details[0]?.message) {
      return `${data.message}: ${data.details.map((d) => d.message).join(', ')}`;
    }
    return data?.message || err.message || fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
