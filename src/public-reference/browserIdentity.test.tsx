// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import type { AuthSession } from '@openlup/platform/identity/contracts';
import type { CustomerAuthBinding } from '@/lib/auth/customerAuthPortFactory';
import { CustomerAuthProvider } from '@/lib/useCustomerAuth';
import { useCustomerAuth } from '@/lib/customerAuthContext';
import { appQueryClient } from '@/lib/queryClient';
import LoginPage from '@/pages/account/LoginPage';
import AuthCallbackPage from '@/pages/account/AuthCallbackPage';
import { ReferenceAccount } from './SubscriptionAccount';
import { createReferenceI18n } from './subscriptionMessages';

const mocks = vi.hoisted(() => ({ binding: vi.fn() }));
vi.mock('@/lib/auth/customerAuthPortFactory', () => ({ getCustomerAuthBinding: mocks.binding }));
vi.mock('@/integrations/supabase/customerClient', () => ({ getCustomerSupabase: () => ({ auth: {
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
} }) }));
const principal = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const session: AuthSession = { accessToken: 'synthetic-bearer', user: { id: principal, email: 'customer@example.com' } };
const profile = { clientId, email: session.user.email, firstName: null, lastName: null, lifecycleStage: 'customer' };
const account = { contractVersion: 'customer.account.v3', profile: { ...profile, phone: null }, pets: [], subscriptions: [], addresses: [], ordererProfiles: [], billingProfiles: [], paymentPreferences: [], recentOrders: [], events: [], actionRequired: [] };
let listener: ((value: AuthSession | null) => void) | undefined;
let binding: CustomerAuthBinding;
let fetcher: ReturnType<typeof vi.fn>;
const result = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function Probe() {
  const auth = useCustomerAuth();
  const location = useLocation();
  return <><span data-testid="location">{location.pathname}</span><span data-testid="principal">{auth.profile?.clientId ?? 'none'}</span><button onClick={() => void auth.signOut()}>Force sign out</button></>;
}
function mount(path = '/sign-in') {
  window.history.replaceState({}, '', path);
  return render(<QueryClientProvider client={appQueryClient}><I18nextProvider i18n={createReferenceI18n(path.startsWith('/konto') || path.startsWith('/zaloguj-sie') ? 'pl' : 'en')}><MemoryRouter initialEntries={[path]}><CustomerAuthProvider><Probe /><Routes>
    {['/sign-in', '/zaloguj-sie'].map((route) => <Route key={route} path={route} element={<LoginPage />} />)}
    {['/account/auth/callback', '/konto/auth/callback'].map((route) => <Route key={route} path={route} element={<AuthCallbackPage />} />)}
    {['/account', '/konto'].map((route) => <Route key={route} path={route} element={<ReferenceAccount />} />)}
  </Routes></CustomerAuthProvider></MemoryRouter></I18nextProvider></QueryClientProvider>);
}
async function requestEmail() {
  const request = await screen.findByRole('button', { name: 'Request sign-in' });
  await waitFor(() => expect(request).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' Customer@Example.com ' } });
  fireEvent.click(request);
  await screen.findByRole('button', { name: 'Request again' });
}
beforeEach(() => {
  appQueryClient.clear();
  window.localStorage.clear(); window.sessionStorage.clear(); listener = undefined;
  binding = { reconcileAccount: false, signInOptions: { codeFormat: 'numeric', socialProviders: [] }, port: {
    getSession: vi.fn().mockResolvedValue(null),
    onAuthStateChange: vi.fn((receive) => { listener = receive; return () => { listener = undefined; }; }),
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    verifyOtpCode: vi.fn(async () => { listener?.(session); return { error: null }; }),
    signInWithOAuth: vi.fn().mockResolvedValue({ error: null }), linkIdentity: vi.fn().mockResolvedValue({ error: null }),
    signOut: vi.fn(async () => { listener?.(null); }),
  } };
  mocks.binding.mockReset().mockImplementation(async () => binding);
  fetcher = vi.fn(async (path: string) => {
    if (path === '/api/bff/customers/me') return result(profile);
    if (path === '/api/bff/customers/account') return result(account);
    throw new Error('Unexpected transport path');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); appQueryClient.clear(); });

describe('browser customer identity', () => {
  it.each([
    ['/sign-in?returnTo=/account/orders', '/account', 'en'],
    ['/sign-in?returnTo=/account/auth/callback', '/account', 'en'],
    ['/sign-in?returnTo=/konto', '/konto', 'en'],
    ['/zaloguj-sie?returnTo=/konto/auth/callback', '/konto', 'pl'],
  ])('normalizes %s across the page, adapter and BFF request', async (entry, target, locale) => {
    const { createSupabaseCustomerAuthPort } = await import('@/integrations/supabase/customerAuthPort');
    binding.port = createSupabaseCustomerAuthPort();
    let body: unknown;
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      expect(path).toBe('/api/bff/customers/magic-link');
      body = JSON.parse(String(init.body));
      return result({ accepted: true });
    });
    mount(entry);
    const request = await screen.findByRole('button', { name: locale === 'en' ? 'Request sign-in' : 'Poproś o logowanie' });
    await waitFor(() => expect(request).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'customer@example.com' } });
    fireEvent.click(request);
    await screen.findByRole('status');
    expect(body).toEqual({ email: 'customer@example.com', locale, returnTo: target });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('email request exposes accepted state without enumeration and prevents duplicate requests', async () => {
    const pending = deferred<{ error: null }>();
    vi.mocked(binding.port.signInWithOtp).mockReturnValueOnce(pending.promise);
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request sign-in' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Customer@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request sign-in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(binding.port.signInWithOtp).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ error: null }));
    expect(await screen.findByRole('status')).toHaveTextContent('does not confirm account existence or delivery');
    fireEvent.click(screen.getByRole('button', { name: 'Request again' }));
    await waitFor(() => expect(binding.port.signInWithOtp).toHaveBeenCalledTimes(2));
    expect(binding.port.signInWithOtp).toHaveBeenLastCalledWith({ email: 'customer@example.com', locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Use another address' }));
    expect(screen.getByLabelText('Email')).toBeEnabled();
    const acceptedText = 'If this address can sign in, sign-in instructions were requested. Check your mailbox for a link or code. This does not confirm account existence or delivery.';
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'unknown@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request sign-in' }));
    expect(await screen.findByRole('status')).toHaveTextContent(acceptedText);
  });

  it('login establishes the account bearer without reference storage and logout clears the mounted cache', async () => {
    mount('/sign-in?returnTo=https://external.invalid/account');
    await requestEmail();
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByRole('heading', { name: 'Your recurring orders' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/account');
    expect(fetcher.mock.calls.find(([path]) => path === '/api/bff/customers/account')?.[1].headers.get('authorization')).toBe('Bearer synthetic-bearer');
    expect(appQueryClient.getQueryData(['reference-account', principal, clientId])).toBeDefined();
    expect(window.sessionStorage.getItem('openlup.reference.customerToken')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' })).toBeInTheDocument();
    expect(binding.port.signOut).toHaveBeenCalledOnce();
    expect(appQueryClient.getQueryData(['reference-account', principal, clientId])).toBeUndefined();
    expect(appQueryClient.getQueryCache().getAll().every((query) => query.state.data === undefined)).toBe(true);
    expect(screen.queryByText('No orders are visible yet.')).not.toBeInTheDocument();
  });

  it('send and verification refusals show localized messages without provider details', async () => {
    vi.mocked(binding.port.signInWithOtp).mockRejectedValueOnce(new Error('synthetic provider detail'));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request sign-in' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'customer@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request sign-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable. Please retry later.');
    expect(document.body.textContent).not.toContain('synthetic provider detail');
    fireEvent.click(screen.getByRole('button', { name: 'Request sign-in' }));
    await screen.findByRole('button', { name: 'Request again' });
    vi.mocked(binding.port.verifyOtpCode).mockRejectedValueOnce(new Error('synthetic token detail'));
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByText('The code could not be verified. Request a new one.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('synthetic token detail');
  });

  it('numeric fallback refuses opaque input; direct fallback submits the full opaque challenge', async () => {
    mount(); await requestEmail();
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'opaque_challenge_0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByText('Enter a code in the required format.')).toBeInTheDocument();
    expect(binding.port.verifyOtpCode).not.toHaveBeenCalled();
  });
  it('direct fallback submits the full opaque challenge', async () => {
    binding.signInOptions.codeFormat = 'opaque';
    mount(); await requestEmail();
    expect(screen.getByRole('status')).toHaveTextContent('Paste the full token');
    expect(screen.getByLabelText('Sign-in code')).toHaveAttribute('inputmode', 'text');
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'opaque_challenge_0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    await waitFor(() => expect(binding.port.verifyOtpCode).toHaveBeenCalledWith({ email: 'customer@example.com', token: 'opaque_challenge_0123456789' }));
    expect(await screen.findByRole('heading', { name: 'Your recurring orders' })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([path]) => path === '/api/bff/customers/reconcile-account')).toBe(false);
  });

  it('listed supported social option starts the same-origin configured callback', async () => {
    binding.signInOptions.socialProviders = [{ kind: 'google', displayName: 'Example identity' }];
    mount('/sign-in?returnTo=//external.invalid');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Example identity' }));
    await waitFor(() => expect(binding.port.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', redirectTo: `${window.location.origin}/account/auth/callback` }));
  });

  it('callback waits for the linked profile before account navigation and cleans credentials after adapter consumption', async () => {
    const pending = deferred<Response>();
    vi.mocked(binding.port.getSession).mockImplementation(async () => {
      expect(window.location.hash).toContain('access_token=synthetic');
      return session;
    });
    fetcher.mockImplementation(async (path: string) => path === '/api/bff/customers/me' ? pending.promise : result(account));
    mount('/account/auth/callback#access_token=synthetic&refresh_token=synthetic-refresh');
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.getByTestId('location')).toHaveTextContent('/account/auth/callback');
    await waitFor(() => expect(window.location.hash).toBe(''));
    await act(async () => pending.resolve(result(profile)));
    expect(await screen.findByRole('heading', { name: 'Your recurring orders' })).toBeInTheDocument();
  });
  it.each([['otp_expired', 'This sign-in link has expired. Request a new one.'], ['bad_jwt', 'This sign-in link is invalid. Request a new one.']])('recognized callback failure %s survives an older session and removes failure descriptions', async (code, message) => {
    vi.mocked(binding.port.getSession).mockResolvedValue(session);
    mount(`/account/auth/callback?error_code=${code}&error_description=private-detail#access_token=synthetic`);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/account/auth/callback');
    expect(window.location.search + window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain('private-detail');
  });
  it('session without a profile renders account unavailable instead of redirecting', async () => {
    vi.mocked(binding.port.getSession).mockResolvedValue(session);
    fetcher.mockRejectedValue(new Error('unavailable'));
    mount('/account/auth/callback');
    expect(await screen.findByText('Your linked account is unavailable. Sign out and try again.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/account/auth/callback');
  });

  it.each([
    [new TypeError('synthetic transport failure'), 'Completion could not be confirmed. Please try again.'],
    [new Error('customer_auth_bootstrap_timeout'), 'Verification timed out. Request sign-in again.'],
    [new Error('synthetic private failure'), 'Sign-in could not be completed.'],
  ])('renders a closed callback failure for %s', async (error, message) => {
    vi.mocked(binding.port.getSession).mockRejectedValue(error);
    mount('/account/auth/callback');
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(error.message);
  });

  it('adapter setup failure displays a localized unavailable state', async () => {
    mocks.binding.mockRejectedValueOnce(new Error('synthetic setup detail'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable. Please retry later.');
    expect(screen.getByRole('button', { name: 'Request sign-in' })).toBeDisabled();
    expect(document.body.textContent).not.toContain('synthetic setup detail');
  });
  it('logout during adapter loading clears the selected persisted session', async () => {
    const pending = deferred<CustomerAuthBinding>();
    mocks.binding.mockReturnValueOnce(pending.promise);
    vi.mocked(binding.port.getSession).mockResolvedValue(session);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Force sign out' }));
    await act(async () => pending.resolve(binding));
    expect(binding.port.signOut).toHaveBeenCalledOnce();
    expect(screen.getByTestId('principal')).toHaveTextContent('none');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('late bootstrap cannot undo logout', async () => {
    const pending = deferred<AuthSession | null>();
    vi.mocked(binding.port.getSession).mockReturnValue(pending.promise);
    mount();
    await waitFor(() => expect(listener).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Force sign out' }));
    await act(async () => pending.resolve(session));
    expect(screen.getByTestId('principal')).toHaveTextContent('none');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('late profile cannot undo logout', async () => {
    vi.mocked(binding.port.getSession).mockResolvedValue(session);
    const pending = deferred<Response>(); fetcher.mockReturnValue(pending.promise);
    mount('/account');
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Force sign out' }));
    await act(async () => pending.resolve(result(profile)));
    expect(screen.getByTestId('principal')).toHaveTextContent('none');
    expect(screen.queryByRole('heading', { name: 'Your recurring orders' })).not.toBeInTheDocument();
  });
  it('principal change never uses the previous account cache identity', async () => {
    vi.mocked(binding.port.getSession).mockResolvedValue(session);
    mount('/account');
    await screen.findByText('No orders are visible yet.');
    const other = { ...session, accessToken: 'synthetic-second-bearer', user: { ...session.user, id: '33333333-3333-4333-8333-333333333333' } };
    await act(async () => listener?.(other));
    await waitFor(() => expect(appQueryClient.getQueryData(['reference-account', other.user.id, clientId])).toBeDefined());
    expect(appQueryClient.getQueryData(['reference-account', principal, clientId])).toBeUndefined();
  });
  it('storage denial leaves same-document login usable', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    mount(); await requestEmail();
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByRole('heading', { name: 'Your recurring orders' })).toBeInTheDocument();
  });
  it('Polish routes render localized login and callback failure', async () => {
    mount('/konto/auth/callback?error_code=otp_expired');
    expect(await screen.findByText('Link logowania wygasł. Poproś o nowy.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Poproś ponownie o logowanie' }));
    expect(await screen.findByRole('heading', { name: 'Zaloguj się do konta' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/zaloguj-sie');
  });
});
