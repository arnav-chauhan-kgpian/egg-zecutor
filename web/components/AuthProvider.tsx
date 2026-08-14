'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  SESSION_EXPIRED_EVENT,
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
  login as loginRequest,
  register as registerRequest,
} from '@/lib/api';
import type { AuthUser } from '@/lib/types';

interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  signIn: (identifier: string, password: string) => Promise<void>;
  signUp: (email: string, username: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  // Rehydrate from localStorage on mount.
  useEffect(() => {
    const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    const stored = window.localStorage.getItem(USER_STORAGE_KEY);
    if (token && stored) {
      try {
        setUser(JSON.parse(stored) as AuthUser);
      } catch {
        window.localStorage.removeItem(USER_STORAGE_KEY);
      }
    }
    setReady(true);
  }, []);

  // The API layer clears the stored token when the server rejects it; this puts
  // the UI back in its signed-out state so the sign-in form reappears, rather
  // than leaving a stale username in the header beside a stream of 401s.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const persist = useCallback((token: string, nextUser: AuthUser) => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(nextUser));
    setUser(nextUser);
  }, []);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const { token, user: nextUser } = await loginRequest(identifier, password);
      persist(token, nextUser);
    },
    [persist],
  );

  const signUp = useCallback(
    async (email: string, username: string, password: string) => {
      const { token, user: nextUser } = await registerRequest(email, username, password);
      persist(token, nextUser);
    },
    [persist],
  );

  const signOut = useCallback(() => {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(USER_STORAGE_KEY);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, signIn, signUp, signOut }),
    [user, ready, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
