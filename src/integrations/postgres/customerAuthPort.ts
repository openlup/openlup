import type { CustomerAuthPort } from '@/domains/auth/ports';
import type { AuthSession, AuthStateListener } from '@/domains/auth/types';
import { requestCustomerMagicLink } from '@/domains/customers/customerMagicLinkClient';
import { requestBff } from '@/lib/bff/client';
import { readStorageItem, removeStorageItem, writeStorageItem } from '@/lib/browserStorage';
import { readCustomerReturnTo } from '@/lib/customerRecoverySession';
import { z } from '@/lib/validation/zod';

const SESSION_KEY = 'openlup.customer.session.v1';
const listeners = new Set<AuthStateListener>();

interface StoredSession {
  session: AuthSession;
  expiresAt: string;
}

export function createPostgresCustomerAuthPort(): CustomerAuthPort {
  return {
    async getSession() {
      return readSession();
    },
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signInWithOtp({ email, locale }) {
      try {
        await requestCustomerMagicLink(email, locale === 'en' ? 'en' : 'pl', {
          returnTo: readCustomerReturnTo(),
        });
        return { error: null };
      } catch {
        return { error: 'magic_link_send_failed' };
      }
    },
    async verifyOtpCode({ email, token }) {
      try {
        const result = await requestBff(
          '/api/bff/customers/verify-otp',
          z.object({
            accessToken: z.string().min(1),
            expiresAt: z.string().datetime({ offset: true }),
            user: z.object({ id: z.guid(), email: z.string().email() }).strict(),
          }).strict(),
          { method: 'POST', body: { email, token } },
        );
        const session: AuthSession = {
          accessToken: result.accessToken,
          user: result.user,
        };
        // A denied store downgrades the session to this document; it must not
        // turn a successful sign-in into a thrown promise.
        writeStorageItem('localStorage', SESSION_KEY, JSON.stringify({
          session,
          expiresAt: result.expiresAt,
        } satisfies StoredSession));
        emit(session);
        return { error: null };
      } catch {
        return { error: 'otp_invalid_or_expired' };
      }
    },
    async signInWithOAuth() {
      return { error: 'oauth_not_supported' };
    },
    async linkIdentity() {
      return { error: 'identity_linking_not_supported' };
    },
    async signOut() {
      removeStorageItem('localStorage', SESSION_KEY);
      emit(null);
    },
  };
}

function readSession(): AuthSession | null {
  const raw = readStorageItem('localStorage', SESSION_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredSession>;
    const parsed = stored.session;
    if (
      typeof stored.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(stored.expiresAt)) ||
      Date.parse(stored.expiresAt) <= Date.now() ||
      !parsed ||
      typeof parsed.accessToken !== 'string' ||
      !parsed.user ||
      typeof parsed.user.id !== 'string' ||
      (parsed.user.email !== null && typeof parsed.user.email !== 'string')
    ) {
      removeStorageItem('localStorage', SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    // ⛔ The old code re-entered `localStorage` from THIS catch. With storage
    // denied the read above threw, so the cleanup threw a second time and the
    // whole function escaped — the one shape a `try` cannot rescue itself from.
    removeStorageItem('localStorage', SESSION_KEY);
    return null;
  }
}

function emit(session: AuthSession | null): void {
  for (const listener of listeners) listener(session);
}
