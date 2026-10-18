import { StrictMode } from 'react';
import { act, render, waitFor, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
const { mode, redeem, managed } = vi.hoisted(() => ({ mode: { integrated: false }, redeem: vi.fn(async () => ({ error: null })), managed: vi.fn(() => { throw new Error('managed must stay cold'); }) }));
vi.mock('@/lib/authContext', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/authContext')>();
  return { ...actual, useAuth: () => mode.integrated ? actual.useAuth() : ({ directOperatorAuth: true, signInWithOtpCode: redeem }) };
});
vi.mock('@/lib/bff/client', () => ({ requestBff: vi.fn() }));
vi.mock('@/domains/platform/adminMeClient', () => ({ getAdminPlatformMe: vi.fn(async () => ({ isAdmin: true, role: 'admin' })) }));
vi.mock('@/lib/queryClient', () => ({ clearAuthScopedQueryCache: vi.fn() }));
import { requestBff } from '@/lib/bff/client';
import { AuthProvider } from '@/lib/useAuth';
import { useAuth } from '@/lib/authContext';
vi.mock('@/integrations/supabase/adminAuthPort', () => ({ loadManagedAdminAuth: managed }));
import AuthCallbackPage from './AuthCallbackPage';
afterEach(() => { mode.integrated = false; window.sessionStorage.clear(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('StrictMode removes the fragment before a single redemption and never loads managed auth', async () => {
  vi.stubEnv('VITE_OPERATOR_AUTH_PROVIDER_KIND', 'direct');
  window.history.replaceState(null, '', '/admin/auth/callback#operator_token=' + 'a'.repeat(43));
  redeem.mockImplementationOnce(async () => { expect(window.location.hash).toBe(''); return { error: null }; });
  render(<StrictMode><MemoryRouter><AuthCallbackPage /></MemoryRouter></StrictMode>);
  await waitFor(() => expect(redeem).toHaveBeenCalledTimes(1)); expect(managed).not.toHaveBeenCalled();
});
it('expired or replayed tokens stay outside the shell', async () => {
  vi.stubEnv('VITE_OPERATOR_AUTH_PROVIDER_KIND', 'direct'); redeem.mockResolvedValueOnce({ error: 'refused' });
  window.history.replaceState(null, '', '/admin/auth/callback#operator_token=' + 'a'.repeat(43));
  render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
  await screen.findByText('Operator challenge invalid or expired'); expect(screen.getByText('Return to sign in')).toBeTruthy();
});

it('provider restoration and focus preserve the real callback redemption under StrictMode', async () => {
  mode.integrated = true;
  window.sessionStorage.clear();
  const session = { accessToken: 'signed', expiresAt: new Date(Date.now() + 900000).toISOString(), user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' } };
  let resolve!: (value: typeof session) => void;
  vi.mocked(requestBff).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  window.history.replaceState(null, '', '/admin/auth/callback#operator_token=' + 'a'.repeat(43));
  function Shell() { const auth = useAuth(); return <div>{auth.isAdmin && auth.session?.access_token === 'signed' ? 'Operator shell' : 'Signed out'}</div>; }
  const view = render(<StrictMode><MemoryRouter initialEntries={['/admin/auth/callback']}><AuthProvider providerKind="direct"><Routes>
    <Route path="/admin/auth/callback" element={<AuthCallbackPage />} />
    <Route path="/admin" element={<Shell />} />
  </Routes></AuthProvider></MemoryRouter></StrictMode>);
  await waitFor(() => expect(requestBff).toHaveBeenCalledTimes(1));
  expect(window.location.hash).toBe('');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await act(async () => { resolve(session); });
  await screen.findByText('Operator shell');
  expect(JSON.parse(window.sessionStorage.getItem('openlup.operator.session.v1')!)).toEqual(session);
  expect(requestBff).toHaveBeenCalledExactlyOnceWith('/api/bff/admin/platform/verify-otp', expect.anything(), { method: 'POST', body: { token: 'a'.repeat(43) } });
  expect(managed).not.toHaveBeenCalled();
  view.unmount();
});
