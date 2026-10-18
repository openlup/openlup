import type { EmailTrustAssessment, EmailTrustPolicy } from "./emailTrustPolicy.js";

const unavailable: EmailTrustAssessment = { trusted: false, code: "EMAIL_TRUST_SETTINGS_UNAVAILABLE" };
const refused: EmailTrustAssessment = { trusted: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" };
const providerId = /^[a-z][a-z0-9_-]*$/;
/** Server-side assertion by the adopter, never a provider certification. */
export function parseEmailVerifyingProviders(value: string): readonly string[] {
  if (!value.trim()) return [];
  const entries = value.split(",").map(entry => entry.trim().toLowerCase());
  if (entries.some(entry => !providerId.test(entry))) throw new Error("Invalid email-verifying provider declaration");
  return [...new Set(entries)].sort();
}

/** One immutable origin/key/allowlist binding; import and construction perform no I/O. */
export function createManagedEmailTrustPolicy(options: {
  authBaseUrl: string;
  publicKey: string;
  emailVerifyingProviders?: readonly string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): EmailTrustPolicy {
  const origin = new URL(options.authBaseUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || !options.publicKey.trim()) {
    throw new Error("Invalid identity email-trust configuration");
  }
  const url = new URL("/auth/v1/settings", origin);
  const publicKey = options.publicKey;
  const allowed = new Set(parseEmailVerifyingProviders((options.emailVerifyingProviders ?? []).join(",")));
  const fetchSettings = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached: { result: EmailTrustAssessment; expires: number } | undefined;
  let inFlight: Promise<EmailTrustAssessment> | undefined;

  function decode(value: unknown): EmailTrustAssessment {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
    const { mailer_autoconfirm: automatic, external } = value as Record<string, unknown>;
    if (typeof automatic !== "boolean" || !external || typeof external !== "object" || Array.isArray(external)) return unavailable;
    const entries = Object.entries(external);
    if (entries.some(([key, enabled]) => !providerId.test(key) || typeof enabled !== "boolean")) return unavailable;
    if (automatic || entries.some(([key, enabled]) => enabled && key !== "email" && !allowed.has(key))) return refused;
    return { trusted: true };
  }

  async function load(): Promise<EmailTrustAssessment> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Identity settings deadline")); }, 3000);
    });
    async function read(): Promise<EmailTrustAssessment> {
      const response = await fetchSettings(url, {
        headers: { apikey: publicKey }, redirect: "error", signal: controller.signal,
      });
      if (!response.ok || response.redirected || !response.body) return unavailable;
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65536) { controller.abort(); void reader.cancel().catch(() => {}); return unavailable; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    }
    try { return await Promise.race([read(), deadline]); }
    catch { return unavailable; }
    finally { controller.abort(); clearTimeout(timer); }
  }
  return {
    async assess() {
      if (cached && now() < cached.expires) return cached.result;
      if (!inFlight) {
        inFlight = load().then(result => {
          const ttl = !result.trusted && result.code === "EMAIL_TRUST_SETTINGS_UNAVAILABLE" ? 5000 : 60000;
          cached = { result, expires: now() + ttl };
          return result;
        }).finally(() => { inFlight = undefined; });
      }
      return inFlight;
    },
  };
}
