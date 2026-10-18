// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLoginHint, writeLoginHint } from '@/lib/customerLoginHint';
import { referenceAccountReturnTo } from '@/pages/account/login/referenceRoutes';

const managed = vi.hoisted(() => ({ loaded: vi.fn(), created: vi.fn() }));
vi.mock('@/integrations/supabase/customerAuthPort', () => {
  managed.loaded();
  return { createSupabaseCustomerAuthPort: managed.created };
});
vi.mock('@/integrations/supabase/customerClient', () => ({
  customerSocialProviders: (enabled: string[]) => enabled.includes('google') ? [{ kind: 'google', displayName: 'Example identity' }] : [],
}));

beforeEach(() => { vi.resetModules(); window.localStorage.clear(); window.sessionStorage.clear(); managed.loaded.mockClear(); managed.created.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('selected browser binding and persistence', () => {
  it('direct selection never loads or initializes the unselected managed adapter', async () => {
    vi.stubEnv('VITE_COMMERCE_AUTH_PROVIDER_KIND', 'node-postgres');
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', 'google');
    const { getCustomerAuthBinding } = await import('@/lib/auth/customerAuthPortFactory');
    const binding = await getCustomerAuthBinding();
    expect(binding.signInOptions).toEqual({ codeFormat: 'opaque', socialProviders: [] });
    expect(binding.reconcileAccount).toBe(false);
    expect(managed.loaded).not.toHaveBeenCalled();
    expect(managed.created).not.toHaveBeenCalled();
  });
  it.each(['', 'apple,facebook', 'unsupported'])('managed selection with %j exposes no supported external sign-in', async (list) => {
    vi.stubEnv('VITE_COMMERCE_AUTH_PROVIDER_KIND', 'node-supabase');
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', list);
    const { getCustomerAuthBinding } = await import('@/lib/auth/customerAuthPortFactory');
    expect((await getCustomerAuthBinding()).signInOptions).toEqual({ codeFormat: 'numeric', socialProviders: [] });
  });
  it('listed supported option is supplied by the adapter', async () => {
    vi.stubEnv('VITE_COMMERCE_AUTH_PROVIDER_KIND', 'node-supabase');
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', 'google,apple');
    const { getCustomerAuthBinding } = await import('@/lib/auth/customerAuthPortFactory');
    expect((await getCustomerAuthBinding()).signInOptions.socialProviders).toEqual([{ kind: 'google', displayName: 'Example identity' }]);
  });
  it('legacy customer keys do not restore authentication and are discarded', async () => {
    vi.stubEnv('VITE_COMMERCE_AUTH_PROVIDER_KIND', 'node-postgres');
    for (const key of ['openlup-customer', 'openlup.customer.session.v1', 'openlup-last-login']) window.localStorage.setItem(key, 'legacy');
    window.localStorage.setItem('openlup.customer.session.v1', JSON.stringify({ session: { accessToken: 'legacy-bearer', user: { id: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com' } }, expiresAt: '2099-01-01T00:00:00Z' }));
    window.sessionStorage.setItem('openlup.reference.customerToken', 'legacy');
    window.sessionStorage.setItem('openlup.reference.accountId', 'legacy');
    const { getCustomerAuthBinding } = await import('@/lib/auth/customerAuthPortFactory');
    expect(await (await getCustomerAuthBinding()).port.getSession()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
  it('hint contains only method and timestamp, rejects stale and future hints and tolerates denied storage', () => {
    writeLoginHint({ method: 'email', email: 'ignored@example.com' } as never);
    const hint = JSON.parse(window.localStorage.getItem('customer.login.hint.v1')!);
    expect(Object.keys(hint).sort()).toEqual(['method', 'savedAt']);
    expect(readLoginHint()).toEqual(hint);
    for (const savedAt of ['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'invalid']) {
      window.localStorage.setItem('customer.login.hint.v1', JSON.stringify({ method: 'email', savedAt }));
      expect(readLoginHint()).toBeNull();
    }
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    expect(readLoginHint()).toBeNull();
    expect(() => writeLoginHint({ method: 'social' })).not.toThrow();
  });
  it.each(['https://external.invalid', '//external.invalid', '/account/auth/callback', '/account/orders', '/subscribe', '/konto?token=synthetic'])('refuses unmounted return target %s', (path) => {
    expect(referenceAccountReturnTo(path, '/account')).toBe('/account');
    expect(referenceAccountReturnTo('/konto', '/account')).toBe('/konto');
  });
});
