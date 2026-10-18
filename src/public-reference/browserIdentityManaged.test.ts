// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// Exercise the actual SDK callback consumer, not a fragment-parser imitation.
it('managed SDK consumes realistic callback credentials and persists its own session', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56421');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-public-key');
  window.localStorage.clear();
  const id = '11111111-1111-4111-8111-111111111111';
  const payload = { sub: id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.synthetic-signature`;
  window.history.replaceState({}, '', `/account/auth/callback#access_token=${token}&refresh_token=synthetic-refresh&expires_in=3600&token_type=bearer&type=magiclink`);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id, email: 'customer@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const { createSupabaseCustomerAuthPort } = await import('@/integrations/supabase/customerAuthPort');
  const { getCustomerSupabase } = await import('@/integrations/supabase/customerClient');
  const port = createSupabaseCustomerAuthPort();
  try {
    expect(await port.getSession()).toEqual({ accessToken: token, user: { id, email: 'customer@example.com' } });
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('customer.auth.managed.v1')).toContain('synthetic-refresh');
    expect(window.localStorage.getItem('customer.auth.direct.v1')).toBeNull();
    expect(window.location.hash).toBe('');
  } finally {
    getCustomerSupabase().auth.stopAutoRefresh();
    await port.signOut();
  }
});
it.each(['returned', 'thrown'])('failed remote logout (%s) removes credentials before a fresh bootstrap', async (failure) => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56421');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-public-key');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/sign-in');
  const { createSupabaseCustomerAuthPort } = await import('@/integrations/supabase/customerAuthPort');
  const { getCustomerSupabase, CUSTOMER_AUTH_STORAGE_KEY } = await import('@/integrations/supabase/customerClient');
  const client = getCustomerSupabase();
  const port = createSupabaseCustomerAuthPort();
  await port.getSession();
  window.localStorage.setItem(CUSTOMER_AUTH_STORAGE_KEY, JSON.stringify({
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com' },
  }));
  expect(await port.getSession()).not.toBeNull();
  const remoteError = Object.assign(new Error('synthetic transport failure'), { status: 503 });
  // Simulate remote failure retaining the SDK session; the follow-up cleanup is real.
  const signOut = vi.spyOn(client.auth, 'signOut');
  if (failure === 'returned') signOut.mockResolvedValueOnce({ error: remoteError } as Awaited<ReturnType<typeof client.auth.signOut>>);
  else signOut.mockRejectedValueOnce(remoteError);
  const fetcher = vi.fn(() => { throw new Error('Unexpected remote request during local cleanup'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    await port.signOut();
    expect(window.localStorage.getItem(CUSTOMER_AUTH_STORAGE_KEY)).toBeNull();
    expect(await port.getSession()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    client.auth.stopAutoRefresh();
    vi.resetModules();
    const fresh = await import('@/integrations/supabase/customerAuthPort');
    const freshClient = await import('@/integrations/supabase/customerClient');
    try { expect(await fresh.createSupabaseCustomerAuthPort().getSession()).toBeNull(); }
    finally { freshClient.getCustomerSupabase().auth.stopAutoRefresh(); }
  } finally {
    client.auth.stopAutoRefresh();
    vi.restoreAllMocks();
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
