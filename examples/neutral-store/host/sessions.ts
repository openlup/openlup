import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface NativeSession { principalId: string; email: string; kind: 'customer' | 'operator'; expiresAt: string }
const cookieName = 'starter_session';

/** The native redemption path alone receives the issuer; browsers get only an opaque cookie. */
export function createSessions(secure: boolean, now: () => number = Date.now) {
  const sessions = new Map<string, NativeSession>();
  const cookie = (value: string, seconds: number) =>
    `${cookieName}=${value}; Path=/api/actions; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  return {
    issuer(kind: NativeSession['kind']) { return { async issue(identity: { principalId: string; email: string }) {
      for (const [key, value] of sessions) if (Date.parse(value.expiresAt) <= now()) sessions.delete(key);
      if (sessions.size >= 1000) throw new Error('starter_session_capacity_exceeded');
      const accessToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now() + 3600_000).toISOString();
      sessions.set(accessToken, { ...identity, kind, expiresAt });
      return { accessToken, expiresAt };
    } }; },
    read(request: Pick<IncomingMessage, 'headers'>): { token: string; session: NativeSession } | null {
      const matching = request.headers.cookie?.split(';').map(value => value.trim())
        .filter(value => value.split('=')[0] === cookieName) ?? [];
      if (matching.length !== 1) return null;
      const token = matching[0]!.slice(cookieName.length + 1);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const session = sessions.get(token);
      if (!session) return null;
      if (Date.parse(session.expiresAt) <= now()) { sessions.delete(token); return null; }
      return { token, session };
    },
    revoke(token: string | undefined) { if (token) sessions.delete(token); },
    cookie: (value: string) => cookie(value, 3600),
    clearCookie: () => cookie('', 0),
    close: () => sessions.clear(),
  };
}
