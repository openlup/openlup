import { operatorSessionSchema, type OperatorBrowserAuthPort, type OperatorSession } from '@openlup/platform/identity/contracts';
import { z } from '@/lib/validation/zod';
import { BffClientError, requestBff } from '@/lib/bff/client';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { readStorageItem, removeStorageItem, writeStorageItem } from '@/lib/browserStorage';
import { requestAdminMagicLink } from '@/domains/platform/adminMagicLinkClient';
const KEY = 'openlup.operator.session.v1';
export function createPostgresOperatorAuthPort(): OperatorBrowserAuthPort {
  let memory: OperatorSession | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let loginAttempt = 0;
  const listeners = new Set<(session: OperatorSession | null) => void>();
  function apply(session: OperatorSession | null) {
    generation++;
    clearTimeout(timer);
    memory = session;
    if (session) {
      writeStorageItem('sessionStorage', KEY, JSON.stringify(session));
      timer = setTimeout(() => apply(null), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    } else removeStorageItem('sessionStorage', KEY);
    for (const listener of listeners) listener(session);
  }
  async function authorized(session: OperatorSession) {
    if (Date.parse(session.expiresAt) <= Date.now()) return false;
    const result = await getAdminPlatformMe(session.accessToken);
    return result.isAdmin && (result.role === 'admin' || result.role === 'distributor');
  }
  return {
    async getSession() {
      const version = generation;
      let session = memory;
      if (!session) {
        try {
          const parsed = operatorSessionSchema.safeParse(JSON.parse(readStorageItem('sessionStorage', KEY) ?? 'null'));
          session = parsed.success ? parsed.data : null;
        } catch { session = null; }
      }
      try {
        if (!session || !await authorized(session)) { if (version === generation) apply(null); return memory; }
      } catch (error) {
        if (version === generation && error instanceof BffClientError && (error.status === 401 || error.status === 403)) apply(null);
        return memory;
      }
      if (version !== generation) return memory;
      apply(session);
      return session;
    },
    async requestChallenge(email) { await requestAdminMagicLink(email); },
    async verifyChallenge(token) {
      const attempt = loginAttempt;
      const session = await requestBff('/api/bff/admin/platform/verify-otp', z.custom<OperatorSession>(value => operatorSessionSchema.safeParse(value).success), { method: 'POST', body: { token } });
      if (!await authorized(session)) throw new Error('operator_access_denied');
      if (attempt !== loginAttempt) throw new Error('operator_session_superseded');
      loginAttempt++;
      apply(session);
      return session;
    },
    async signOut() { loginAttempt++; apply(null); },
    onAuthStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
