import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { UserProfile } from '@/types/api';

interface AuthState {
  user: UserProfile | null;
  hydrated: boolean;
}

const initialAuthState: AuthState = {
  user: null,
  hydrated: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState: initialAuthState,
  reducers: {
    setUser(state, action: PayloadAction<UserProfile | null>) {
      state.user = action.payload;
      state.hydrated = true;
    },
    clearUser(state) {
      state.user = null;
      state.hydrated = true;
    },
  },
});

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

const toastSlice = createSlice({
  name: 'toast',
  initialState: [] as ToastItem[],
  reducers: {
    pushToast(state, action: PayloadAction<Omit<ToastItem, 'id'>>) {
      state.push({ id: `${Date.now()}-${Math.random()}`, ...action.payload });
      while (state.length > 3) {
        state.shift();
      }
    },
    dismissToast(state, action: PayloadAction<string>) {
      return state.filter((t) => t.id !== action.payload);
    },
  },
});

const uiSlice = createSlice({
  name: 'ui',
  initialState: { cartCount: 0 },
  reducers: {
    setCartCount(state, action: PayloadAction<number>) {
      state.cartCount = action.payload;
    },
  },
});

export const { setUser, clearUser } = authSlice.actions;
export const { pushToast, dismissToast } = toastSlice.actions;
export const { setCartCount } = uiSlice.actions;

export const store = configureStore({
  reducer: {
    auth: authSlice.reducer,
    toast: toastSlice.reducer,
    ui: uiSlice.reducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
