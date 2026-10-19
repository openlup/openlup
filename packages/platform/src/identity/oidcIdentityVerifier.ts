import type { IdentityJwtLibrary, IdentityJwtLibraryLoader, IdentityJwk } from "./jwtLibrary.js";
import type { IdentityVerifierPort, VerifiedPrincipal } from "./ports.js";
import type { OidcFailureCode } from "./contracts/oidc.js";
import { deriveOidcPrincipalId } from "./oidcPrincipal.js";

export interface OidcIdentityVerifierConfig {
  issuer: string;
  audience: string;
  algorithms: readonly ("RS256" | "ES256")[];
  maxTokenLifetimeSeconds: number;
  requireSingleAudience?: boolean;
  /** Conformance only: literal loopback addresses, never arbitrary HTTP hosts. */
  allowLoopbackHttp?: boolean;
}
export type OidcVerificationResult = { ok: true; principal: VerifiedPrincipal; expiresAt: string }
  | { ok: false; code: OidcFailureCode };
export interface OidcReadinessReport {
  state: "ready" | "unknown" | "unsatisfied";
  discovery: { reachable: boolean; valid: boolean; checkedAt: string | null; expiresAt: string | null };
  jwks: { loaded: boolean; checkedAt: string | null; expiresAt: string | null };
  code?: OidcFailureCode;
}
export interface OidcIdentityVerifier extends IdentityVerifierPort {
  verifyToken(token: string): Promise<OidcVerificationResult>;
  readiness(): Promise<OidcReadinessReport>;
}
class Refusal extends Error {
  constructor(readonly code: OidcFailureCode) { super(code); }
}
const refuse = (code: OidcFailureCode): never => { throw new Refusal(code); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !Array.from(value).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f);
const stamp = (value: number | null) => value === null ? null : new Date(value).toISOString();
const unavailable = (code: OidcFailureCode) => code.endsWith("_UNAVAILABLE") || code === "OIDC_JWKS_REFRESH_RATE_LIMITED";

/** One binding per host/configuration. Imports and construction perform no I/O or JWT loading. */
export function createOidcIdentityVerifier(config: OidcIdentityVerifierConfig, dependencies: {
  loadJwt: IdentityJwtLibraryLoader; fetch?: typeof globalThis.fetch; now?: () => number;
}): OidcIdentityVerifier {
  const settings = { ...config, algorithms: [...config.algorithms] };
  const now = dependencies.now ?? Date.now;
  const transport = dependencies.fetch ?? globalThis.fetch;
  function validUrl(value: string) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:"
      && !(settings.allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return url;
  }
  let origin = "", configurationValid = true;
  try {
    if (!bounded(settings.issuer, 2048) || !bounded(settings.audience, 256)
      || !settings.algorithms.length || settings.algorithms.some(alg => alg !== "RS256" && alg !== "ES256")
      || !Number.isInteger(settings.maxTokenLifetimeSeconds) || settings.maxTokenLifetimeSeconds < 1 || settings.maxTokenLifetimeSeconds > 3600) throw new Error();
    origin = validUrl(settings.issuer).origin;
  } catch { configurationValid = false; }
  let library: Promise<IdentityJwtLibrary> | undefined;
  const jwt = () => library ??= Promise.resolve().then(dependencies.loadJwt).catch(() => { library = undefined; return refuse("OIDC_JWT_LIBRARY_UNAVAILABLE"); });
  let discovery: { jwksUrl: string; expires: number } | undefined;
  let keys: { values: IdentityJwk[]; expires: number } | undefined;
  let discoveryCheck: number | null = null, keyCheck: number | null = null, lastKeyAttempt = -Infinity;
  let reachable = false, discoveryValid = false;
  let discoveryFlight: Promise<NonNullable<typeof discovery>> | undefined;
  let keyFlight: Promise<NonNullable<typeof keys>> | undefined;
  let keyFailure: OidcFailureCode | undefined;

  async function document(url: string, kind: "DISCOVERY" | "JWKS", maxAge: number) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {});
      reject(new Refusal(`OIDC_${kind}_UNAVAILABLE`));
    }, 3000); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await transport(url, { redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
        if (kind === "DISCOVERY") reachable = true;
        if (!response.ok) return refuse(`OIDC_${kind}_UNAVAILABLE`);
        if (response.redirected || (response.url && response.url !== url)) return refuse(`OIDC_${kind}_INVALID`);
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) return refuse(`OIDC_${kind}_INVALID`);
        if (!response.body) return refuse(`OIDC_${kind}_INVALID`);
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) { void reader.cancel().catch(() => {}); return refuse(`OIDC_${kind}_INVALID`); }
          chunks.push(part.value);
        }
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return refuse(`OIDC_${kind}_INVALID`); }
        const control = response.headers.get("cache-control") ?? "";
        const ages = [...control.matchAll(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/gi)].map(match => Number(match[1]));
        const age = Number(response.headers.get("age") ?? "0");
        // Revalidate no-cache documents at the next permitted JWKS refresh.
        const cacheBound = /(?:^|,)\s*no-cache(?:\s|,|$)/i.test(control) ? 30 : maxAge;
        const seconds = /(?:^|,)\s*no-store(?:\s|,|$)/i.test(control) ? 0
          : Math.max(0, Math.min(maxAge, cacheBound, ...ages) - (Number.isFinite(age) && age >= 0 ? age : maxAge));
        return { value, expires: now() + seconds * 1000 };
      })()]);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      return refuse(`OIDC_${kind}_UNAVAILABLE`);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function metadata() {
    if (!configurationValid) return refuse("OIDC_CONFIGURATION_INVALID");
    if (discovery && discovery.expires > now()) return discovery;
    if (discoveryFlight) return discoveryFlight;
    discoveryFlight = (async () => {
      discoveryCheck = now(); reachable = false; discoveryValid = false;
      const fetched = await document(`${settings.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "DISCOVERY", 3600);
      if (!record(fetched.value) || fetched.value.issuer !== settings.issuer || typeof fetched.value.jwks_uri !== "string") return refuse("OIDC_DISCOVERY_INVALID");
      try { if (validUrl(fetched.value.jwks_uri).origin !== origin) throw new Error(); }
      catch { return refuse("OIDC_DISCOVERY_INVALID"); }
      if (discovery?.jwksUrl !== fetched.value.jwks_uri) keys = undefined;
      discoveryValid = true;
      return discovery = { jwksUrl: fetched.value.jwks_uri, expires: fetched.expires };
    })();
    try { return await discoveryFlight; } finally { discoveryFlight = undefined; }
  }
  async function keySet(force = false) {
    const meta = await metadata();
    if (!force && keys && keys.expires > now()) return keys;
    if (keyFlight) return keyFlight;
    if (now() - lastKeyAttempt < 30000) return refuse("OIDC_JWKS_REFRESH_RATE_LIMITED");
    lastKeyAttempt = now(); keyCheck = now();
    keyFlight = (async () => {
      const fetched = await document(meta.jwksUrl, "JWKS", 300);
      const value = fetched.value;
      if (!record(value) || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 64) return refuse("OIDC_JWKS_INVALID");
      const eligible: IdentityJwk[] = [];
      for (const key of value.keys) {
        if (!record(key) || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => field in key)) return refuse("OIDC_JWKS_INVALID");
        if ((key.use !== undefined && key.use !== "sig") || (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.length || !key.key_ops.every(operation => operation === "verify")))) continue;
        const alg = key.alg === undefined ? (key.kty === "RSA" ? "RS256" : key.kty === "EC" && key.crv === "P-256" ? "ES256" : "") : key.alg;
        if (!settings.algorithms.includes(alg as "RS256" | "ES256")
          || (alg === "RS256" ? key.kty !== "RSA" : key.kty !== "EC" || key.crv !== "P-256")) continue;
        if (!bounded(key.kid, 128) || (alg === "RS256" ? !bounded(key.n, 2048) || !bounded(key.e, 16)
          : !bounded(key.x, 128) || !bounded(key.y, 128))) return refuse("OIDC_JWKS_INVALID");
        eligible.push({ ...key, alg: String(alg) });
      }
      if (!eligible.length || new Set(eligible.map(key => key.kid)).size !== eligible.length) return refuse("OIDC_JWKS_INVALID");
      const lib = await jwt();
      try { await Promise.all(eligible.map(key => lib.importJWK(key, key.alg!))); }
      catch { return refuse("OIDC_JWKS_INVALID"); }
      keyFailure = undefined;
      return keys = { values: eligible, expires: fetched.expires };
    })();
    try { return await keyFlight; }
    catch (error) { keyFailure = error instanceof Refusal ? error.code : "OIDC_JWKS_UNAVAILABLE"; throw error; }
    finally { keyFlight = undefined; }
  }
  async function verifyToken(token: string): Promise<OidcVerificationResult> {
    try {
      if (!configurationValid) return refuse("OIDC_CONFIGURATION_INVALID");
      if (typeof token !== "string" || Buffer.byteLength(token) > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return refuse("OIDC_TOKEN_INVALID");
      let header: unknown, unverifiedPayload: unknown;
      try {
        const parts = token.split(".").map(part => {
          const bytes = Buffer.from(part, "base64url");
          if (bytes.toString("base64url") !== part) return refuse("OIDC_TOKEN_INVALID");
          return bytes;
        });
        const decoder = new TextDecoder("utf-8", { fatal: true });
        header = JSON.parse(decoder.decode(parts[0]!));
        unverifiedPayload = JSON.parse(decoder.decode(parts[1]!));
      } catch { return refuse("OIDC_TOKEN_INVALID"); }
      if (!record(header) || !record(unverifiedPayload) || !bounded(header.kid, 128)
        || !settings.algorithms.includes(header.alg as "RS256" | "ES256")) return refuse("OIDC_TOKEN_INVALID");
      // Unverified claims may refuse before I/O; only verified claims can admit.
      if (unverifiedPayload.iss !== settings.issuer) return refuse("OIDC_ISSUER_MISMATCH");
      let set = await keySet();
      const select = () => set.values.find(key => key.kid === header.kid && key.alg === header.alg);
      if (!select()) { set = await keySet(true); if (!select()) return refuse("OIDC_KID_UNKNOWN"); }
      const lib = await jwt();
      const selected = select()!;
      let payload;
      try {
        const key = await lib.importJWK(selected, String(header.alg));
        ({ payload } = await lib.jwtVerify(token, async protectedHeader => {
          if (protectedHeader.alg !== header.alg || protectedHeader.kid !== header.kid) return refuse("OIDC_TOKEN_INVALID");
          return key;
        }, { algorithms: settings.algorithms, audience: settings.audience, issuer: settings.issuer, currentDate: new Date(now()), clockTolerance: 0 }));
      } catch (error) {
        if (record(error)) {
          if (error.code === "ERR_JWT_EXPIRED") return refuse("OIDC_TOKEN_EXPIRED");
          if (error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
            if (error.claim === "iss") return refuse("OIDC_ISSUER_MISMATCH");
            if (error.claim === "aud") return refuse("OIDC_AUDIENCE_MISMATCH");
            if (error.claim === "nbf") return refuse("OIDC_TOKEN_NOT_ACTIVE");
          }
        }
        return refuse("OIDC_TOKEN_INVALID");
      }
      if (payload.iss !== settings.issuer) return refuse("OIDC_ISSUER_MISMATCH");
      if (settings.requireSingleAudience ? payload.aud !== settings.audience
        : !(payload.aud === settings.audience || (Array.isArray(payload.aud) && payload.aud.every(aud => typeof aud === "string") && payload.aud.includes(settings.audience)))) return refuse("OIDC_AUDIENCE_MISMATCH");
      const seconds = now() / 1000;
      if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp! <= payload.iat!
        || payload.exp! - payload.iat! > settings.maxTokenLifetimeSeconds || payload.iat! > seconds) return refuse("OIDC_TOKEN_LIFETIME_INVALID");
      if (payload.exp! <= seconds) return refuse("OIDC_TOKEN_EXPIRED");
      if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > seconds)) return refuse("OIDC_TOKEN_NOT_ACTIVE");
      if (!bounded(payload.sub, 1024)) return refuse("OIDC_SUBJECT_INVALID");
      if (!bounded(payload.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return refuse("OIDC_EMAIL_INVALID");
      if (payload.email_verified !== true) return refuse("OIDC_EMAIL_UNVERIFIED");
      return { ok: true, principal: { principalId: deriveOidcPrincipalId(settings.issuer, payload.sub), email: payload.email.trim().toLowerCase(), emailVerified: true }, expiresAt: stamp(payload.exp! * 1000)! };
    } catch (error) { return { ok: false, code: error instanceof Refusal ? error.code : "OIDC_TOKEN_INVALID" }; }
  }
  return {
    verifyToken,
    async verifyAccessToken(token) {
      const result = await verifyToken(token);
      if (result.ok) return result.principal;
      if (unavailable(result.code)) throw new Error("OIDC identity verification unavailable");
      return null;
    },
    async readiness() {
      let code: OidcFailureCode | undefined;
      try { await keySet(); } catch (error) { code = error instanceof Refusal ? error.code : "OIDC_JWKS_UNAVAILABLE"; }
      if (code === "OIDC_JWKS_REFRESH_RATE_LIMITED" && keyFailure) code = keyFailure;
      const fresh = !!keys && keys.expires > now();
      return { state: code ? unavailable(code) ? "unknown" : "unsatisfied" : fresh ? "ready" : "unsatisfied",
        discovery: { reachable, valid: discoveryValid && !!discovery && discovery.expires > now(), checkedAt: stamp(discoveryCheck), expiresAt: stamp(discovery?.expires ?? null) },
        jwks: { loaded: fresh, checkedAt: stamp(keyCheck), expiresAt: stamp(keys?.expires ?? null) }, ...(code ? { code } : {}) };
    },
  };
}
