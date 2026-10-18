import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OperatorSession } from '@openlup/platform/identity/contracts';
const f = vi.hoisted(() => ({ clear: vi.fn(), managed: vi.fn(() => { throw new Error('managed must stay cold'); }) }));
vi.mock('@/integrations/supabase/adminAuthPort', () => ({ loadManagedAdminAuth: f.managed }));
vi.mock('@/lib/bff/client', () => ({ requestBff: vi.fn() }));
vi.mock('@/domains/platform/adminMeClient', () => ({ getAdminPlatformMe: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ clearAuthScopedQueryCache: f.clear }));
import { requestBff } from '@/lib/bff/client';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { AuthProvider } from './useAuth';
import { useAuth } from './authContext';
let auth: ReturnType<typeof useAuth>;
function Consumer() { auth = useAuth(); return <div>{auth.session?.access_token ?? 'signed out'}:{auth.role}</div>; }
const session = (accessToken: string): OperatorSession => ({ accessToken, expiresAt: new Date(Date.now() + 900000).toISOString(), user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const allowed = { isAdmin: true, role: 'admin' as const };
const KEY = 'openlup.operator.session.v1';
beforeEach(() => {
  vi.clearAllMocks(); window.sessionStorage.clear();
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
