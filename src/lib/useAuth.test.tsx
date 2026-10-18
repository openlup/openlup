import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { OperatorSession } from '@openlup/platform/identity/contracts';
const f = vi.hoisted(() => ({ clear: vi.fn(), managed: vi.fn() }));
vi.mock('@/integrations/supabase/adminAuthPort', () => ({ loadManagedAdminAuth: f.managed }));
vi.mock('@/lib/bff/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/bff/client')>(), requestBff: vi.fn() }));
vi.mock('@/domains/platform/adminMagicLinkClient', () => ({ requestAdminMagicLink: vi.fn(async () => ({ accepted: true })) }));
vi.mock('@/domains/platform/adminMeClient', () => ({ getAdminPlatformMe: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ clearAuthScopedQueryCache: f.clear }));
import { requestBff } from '@/lib/bff/client';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { AuthProvider } from './useAuth';
import { useAuth } from './authContext';
import ProtectedRoute from '@/components/admin/ProtectedRoute';
import LoginPage from '@/pages/admin/LoginPage';
import AuthCallbackPage from '@/pages/admin/AuthCallbackPage';
let auth: ReturnType<typeof useAuth>;
function Consumer() { auth = useAuth(); return <div>{auth.session?.access_token ?? 'signed out'}:{auth.role}</div>; }
const session = (accessToken: string): OperatorSession => ({ accessToken, expiresAt: new Date(Date.now() + 900000).toISOString(), user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const allowed = { isAdmin: true, role: 'admin' as const };
const KEY = 'openlup.operator.session.v1';
beforeEach(() => {
  vi.clearAllMocks(); window.sessionStorage.clear();
  f.managed.mockImplementation(() => { throw new Error('managed must stay cold'); });
  vi.mocked(getAdminPlatformMe).mockResolvedValue(allowed);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('direct selection keeps managed SDK cold and expiry clears the auth scoped cache', async () => {
  vi.useFakeTimers();
  vi.mocked(requestBff).mockResolvedValue(session('signed'));
  await act(async () => { render(<AuthProvider providerKind="direct"><Consumer /></AuthProvider>); });
  expect(auth.loading).toBe(false);
  await act(async () => { expect(await auth.signInWithOtpCode('', 'a'.repeat(43))).toEqual({ error: null }); });
  expect(screen.getByText('signed:admin')).toBeTruthy(); f.clear.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(900000); });
  expect(screen.getByText('signed out:')).toBeTruthy(); expect(f.clear).toHaveBeenCalled();
  expect(window.sessionStorage.getItem(KEY)).toBeNull(); expect(f.managed).not.toHaveBeenCalled();
});
it.each(['older check first', 'newer redemption first'])('an older authorization failure cannot sign out or cancel a newer login: %s', async order => {
  const olderCheck = deferred<Awaited<ReturnType<typeof getAdminPlatformMe>>>();
  const newerResponse = deferred<OperatorSession>();
  let olderReads = 0;
  vi.mocked(getAdminPlatformMe).mockImplementation(async token => {
    if (token === 'older' && ++olderReads > 1) return olderCheck.promise;
    return allowed;
  });
  vi.mocked(requestBff).mockResolvedValueOnce(session('older')).mockReturnValueOnce(newerResponse.promise);
  render(<AuthProvider providerKind="direct"><Consumer /></AuthProvider>);
  await waitFor(() => expect(auth.loading).toBe(false));
  let older!: Promise<{ error: string | null }>;
  await act(async () => { older = auth.signInWithOtpCode('', 'a'.repeat(43)); });
  await waitFor(() => expect(olderReads).toBeGreaterThanOrEqual(2));
  let newer!: Promise<{ error: string | null }>;
  await act(async () => { newer = auth.signInWithOtpCode('', 'b'.repeat(43)); });
  const finishOlder = async () => {
    await act(async () => { olderCheck.resolve({ isAdmin: false, role: null }); await older; });
  };
  const finishNewer = async () => {
    await act(async () => { newerResponse.resolve(session('newer')); await newer; });
  };
  if (order === 'older check first') { await finishOlder(); await finishNewer(); }
  else { await finishNewer(); await finishOlder(); }
  expect(await newer).toEqual({ error: null });
  await screen.findByText('newer:admin');
  expect(JSON.parse(window.sessionStorage.getItem(KEY)!).accessToken).toBe('newer');
  expect(await older).toEqual({ error: null });
  expect(f.managed).not.toHaveBeenCalled();
  await act(async () => auth.signOut());
});

it.each(['pasted token', 'callback link'])('delayed authorization reaches the protected admin shell through the real %s journey', async journey => {
  vi.mocked(requestBff).mockResolvedValue(session('signed'));
  vi.mocked(getAdminPlatformMe).mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return allowed;
  });
  const callback = journey === 'callback link';
  window.history.replaceState(null, '', callback ? '/admin/auth/callback#operator_token=' + 'a'.repeat(43) : '/admin/login');
  const view = render(<StrictMode><MemoryRouter initialEntries={[callback ? '/admin/auth/callback' : '/admin/login']}>
    <AuthProvider providerKind="direct"><Routes>
      <Route path="/admin/login" element={<LoginPage />} />
      <Route path="/admin/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/admin" element={<ProtectedRoute><div>Protected operator shell</div></ProtectedRoute>} />
    </Routes></AuthProvider>
  </MemoryRouter></StrictMode>);
  if (!callback) {
    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBeNull());
    fireEvent.change(view.container.querySelector('input[type=email]')!, { target: { value: 'admin@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: /link/i }));
    fireEvent.change(await screen.findByLabelText('Email link token'), { target: { value: 'a'.repeat(43) } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with token' }));
  }
  await screen.findByText('Protected operator shell');
  expect(getAdminPlatformMe).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe('');
  expect(f.managed).not.toHaveBeenCalled();
  view.unmount();
});

it('managed restoration applies the initial session before checking admin and cannot restore it after sign-out', async () => {
  const initialCheck = deferred<Awaited<ReturnType<typeof getAdminPlatformMe>>>();
  const initial = { access_token: 'managed', user: session('managed').user };
  let changed!: (event: string, next: typeof initial | null) => void;
  f.managed.mockResolvedValueOnce({ supabase: { auth: {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: (listener: typeof changed) => { changed = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
  } } });
  vi.mocked(getAdminPlatformMe).mockReturnValueOnce(initialCheck.promise);
  render(<AuthProvider><Consumer /></AuthProvider>);
  await screen.findByText('managed:');
  expect(auth.loading).toBe(true);
  act(() => changed('SIGNED_OUT', null));
  await act(async () => { initialCheck.resolve(allowed); });
  expect(auth.user).toBeNull();
  expect(auth.session).toBeNull();
  expect(auth.loading).toBe(false);
});

it('sign-in waits for a focus check that supersedes its pending session acceptance', async () => {
  const firstAcceptance = deferred<Awaited<ReturnType<typeof getAdminPlatformMe>>>();
  const focusedAcceptance = deferred<Awaited<ReturnType<typeof getAdminPlatformMe>>>();
  vi.mocked(requestBff).mockResolvedValue(session('signed'));
  vi.mocked(getAdminPlatformMe)
    .mockResolvedValueOnce(allowed)
    .mockReturnValueOnce(firstAcceptance.promise)
    .mockResolvedValueOnce(allowed)
    .mockReturnValueOnce(focusedAcceptance.promise);
  render(<AuthProvider providerKind="direct"><Consumer /></AuthProvider>);
  await waitFor(() => expect(auth.loading).toBe(false));
  let finished = false;
  let signingIn!: Promise<{ error: string | null }>;
  await act(async () => {
    signingIn = auth.signInWithOtpCode('', 'a'.repeat(43)).then(result => { finished = true; return result; });
  });
  expect(getAdminPlatformMe).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(getAdminPlatformMe).toHaveBeenCalledTimes(4);
  await act(async () => { firstAcceptance.resolve(allowed); });
  expect(finished).toBe(false);
  await act(async () => { focusedAcceptance.resolve(allowed); await signingIn; });
  expect(finished).toBe(true);
  expect(auth.isAdmin).toBe(true);
  expect(auth.session?.access_token).toBe('signed');
  await act(async () => auth.signOut());
});
