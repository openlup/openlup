/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/bff/client', () => ({ requestBff: vi.fn() }));
vi.mock('@/domains/platform/adminMeClient', () => ({ getAdminPlatformMe: vi.fn() }));
vi.mock('@/domains/platform/adminMagicLinkClient', () => ({ requestAdminMagicLink: vi.fn() }));
import { requestBff } from '@/lib/bff/client';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { createPostgresOperatorAuthPort } from './operatorAuthPort';
const KEY = 'openlup.operator.session.v1';
const session = { accessToken: 'signed', expiresAt: '2026-10-18T12:15:00.000Z', user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' } };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  window.sessionStorage.clear(); vi.mocked(requestBff).mockResolvedValue(session);
  vi.mocked(getAdminPlatformMe).mockResolvedValue({ isAdmin: true, role: 'admin' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('restores only unexpired authorized tab sessions and clears on sign-out or expiry', async () => {
  const port = createPostgresOperatorAuthPort(); const listener = vi.fn(); port.onAuthStateChange(listener);
  await port.verifyChallenge('a'.repeat(43));
  expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toEqual(session);
  expect(await createPostgresOperatorAuthPort().getSession()).toEqual(session);
  expect(getAdminPlatformMe).toHaveBeenCalledWith('signed');
  await vi.advanceTimersByTimeAsync(900000); expect(listener).toHaveBeenLastCalledWith(null);
  expect(window.sessionStorage.getItem(KEY)).toBeNull();
  expect(await port.getSession()).toBeNull();
});
it('revocation and malformed stored data refuse restoration', async () => {
  window.sessionStorage.setItem(KEY, JSON.stringify(session));
  vi.mocked(getAdminPlatformMe).mockResolvedValue({ isAdmin: false, role: null });
  expect(await createPostgresOperatorAuthPort().getSession()).toBeNull(); expect(window.sessionStorage.getItem(KEY)).toBeNull();
  window.sessionStorage.setItem(KEY, '{bad'); expect(await createPostgresOperatorAuthPort().getSession()).toBeNull();
});
it('denied storage uses document memory without rejecting successful login', async () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
  const port = createPostgresOperatorAuthPort(); expect(await port.verifyChallenge('a'.repeat(43))).toEqual(session);
  expect(await port.getSession()).toEqual(session); await port.signOut(); expect(await port.getSession()).toBeNull();
});
it('sign-out during authority read prevents late restoration', async () => {
  const port = createPostgresOperatorAuthPort(); await port.verifyChallenge('a'.repeat(43));
  let resolve!: (value: { isAdmin: boolean; role: 'admin' }) => void;
  vi.mocked(getAdminPlatformMe).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const restoring = port.getSession(); await port.signOut(); resolve({ isAdmin: true, role: 'admin' });
  expect(await restoring).toBeNull(); expect(window.sessionStorage.getItem(KEY)).toBeNull();
});

it.each([{ label: 'signed out', stored: null }, { label: 'stored session', stored: session }])('restoration and focus reads preserve pending redemption: $label', async ({ stored }) => {
  if (stored) window.sessionStorage.setItem(KEY, JSON.stringify(stored));
  const port = createPostgresOperatorAuthPort();
  let resolve!: (value: typeof session) => void;
  vi.mocked(requestBff).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const verifying = port.verifyChallenge('a'.repeat(43));
  expect(await port.getSession()).toEqual(stored);
  expect(await port.getSession()).toEqual(stored);
  resolve(session);
  await expect(verifying).resolves.toEqual(session);
  expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toEqual(session);
  await port.signOut();
});
it('explicit sign-out still cancels a pending redemption', async () => {
  const port = createPostgresOperatorAuthPort();
  let resolve!: (value: typeof session) => void;
  vi.mocked(requestBff).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const verifying = port.verifyChallenge('a'.repeat(43));
  await port.signOut(); resolve(session);
  await expect(verifying).rejects.toThrow('operator_session_superseded');
  expect(await port.getSession()).toBeNull(); expect(window.sessionStorage.getItem(KEY)).toBeNull();
});

it.each(['denied', 'failed'])('a stale %s restoration returns the session established by redemption', async outcome => {
  window.sessionStorage.setItem(KEY, JSON.stringify({ ...session, accessToken: 'old' }));
  const port = createPostgresOperatorAuthPort();
  let finish!: () => void;
  vi.mocked(getAdminPlatformMe).mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = () => outcome === 'denied' ? resolve({ isAdmin: false, role: null }) : reject(new Error('read failed'));
  }));
  const restoring = port.getSession();
  await expect(port.verifyChallenge('a'.repeat(43))).resolves.toEqual(session);
  finish();
  expect(await restoring).toEqual(session);
  expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toEqual(session);
  await port.signOut();
});
