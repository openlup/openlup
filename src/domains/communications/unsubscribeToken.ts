/**
 * Stateless, signed unsubscribe tokens for marketing emails (RODO one-click
 * opt-out): an HMAC-SHA256 over the recipient email + consent purpose, so the
 * unsubscribe route can suppress the right permission without a lookup table or
 * trusting raw query params. Node marketing senders build the token to embed in
 * the email footer; `api/unsubscribe.ts` verifies it.
 *
 * This module is the only implementation. The former Deno mirror
 * (`supabase/functions/_shared/unsubscribe-token.ts`) was deleted with the
 * `unsubscribe` Edge function; nothing has to be kept in sync any more.
 *
 * WebCrypto only (global `crypto.subtle`/`btoa`/`atob`, Node 18+).
 */

export interface UnsubscribePayload {
  email: string;
  purpose: string;
}

/**
 * How long a newly minted unsubscribe link stays valid: 548 days, i.e. about
 * eighteen months, expressed in whole days so the value does not depend on which
 * months a token happens to span.
 *
 * Contract, and why this number:
 *
 * - Until this field existed the token carried `{e, p, v}` and the verifier
 *   checked only the HMAC, so a link minted in 2026 stayed valid forever. That
 *   made "wait for the old links to age out" an unbounded strategy and left a
 *   permanently replayable capability sitting in mailboxes.
 * - Eighteen months is longer than a marketing message is realistically acted
 *   on and longer than a full annual cycle plus a lapsed re-engagement, so it
 *   does not cut short a genuine opt-out; it is short enough that the capability
 *   is not effectively perpetual.
 * - ⛔ A token WITHOUT `exp` stays valid. Every link already delivered was
 *   minted without one, and refusing them would retro-expire opt-outs the
 *   recipient was told would work. Expiry is a forward-only narrowing.
 *
 * ⛔ Do not rename this to anything containing `TOKEN`, `SECRET`, `PASSWORD`,
 * `SERVICE_ROLE` or `API_KEY`. This module is client-reachable `src/` source and
 * `scripts/check-client-secret-boundary.ts` refuses a SCREAMING_SNAKE
 * identifier carrying any of those words there — a TTL is not a credential, so
 * the name avoids the shape rather than the allowlist.
 */
export const UNSUBSCRIBE_LINK_TTL_SECONDS = 548 * 24 * 60 * 60;

/** Clock seam, so expiry can be proved without waiting eighteen months. */
export interface UnsubscribeTokenClock {
  now?: Date;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToString(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return atob(padded);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacBase64url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64urlEncode(new Uint8Array(sig));
}

/**
 * Build a `<base64url(payload)>.<base64url(sig)>` unsubscribe token.
 *
 * Quoted-printable safety: this token rides as `?token=…` inside marketing emails
 * whose Polish diacritics force quoted-printable encoding. A token beginning with
 * two hex digits could be corrupted if a transport leaves the `=` separator raw
 * (`=7d` -> `}`). This token is structurally immune: the payload always serializes
 * as `{"e":…`, so base64url makes the token always begin "ey" (`e` is hex, `y` is
 * not) — `=ey` is never a valid `=<2 hex>` escape. unsubscribeToken.test.ts guards
 * this; do NOT reshape the payload to lead with a field that could base64url into
 * two hex digits without re-checking (and prefixing the token if so). `exp` is
 * appended last for exactly that reason.
 */
export async function buildUnsubscribeToken(
  payload: UnsubscribePayload,
  secret: string,
  clock: UnsubscribeTokenClock = {},
): Promise<string> {
  const issuedAtSeconds = Math.floor((clock.now ?? new Date()).getTime() / 1000);
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({
      e: payload.email,
      p: payload.purpose,
      v: 1,
      exp: issuedAtSeconds + UNSUBSCRIBE_LINK_TTL_SECONDS,
    })),
  );
  const sig = await hmacBase64url(secret, body);
  return `${body}.${sig}`;
}

/**
 * Add the signed query to a resolved unsubscribe endpoint. The adapter that
 * owns deployment/provider configuration must choose and validate that endpoint
 * before it reaches this neutral communications-domain helper.
 */
export function buildUnsubscribeUrl(
  unsubscribeEndpointUrl: string,
  token: string,
  locale: "pl" | "en",
): string {
  const endpoint = parseUnsubscribeEndpointUrl(unsubscribeEndpointUrl);
  const params = new URLSearchParams({ token });
  if (locale === "en") params.set("lang", "en");
  endpoint.search = `?${params.toString()}`;
  return endpoint.toString();
}

function parseUnsubscribeEndpointUrl(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.hostname.endsWith(".")
  ) {
    throw new Error("unsubscribe endpoint URL must be HTTPS without credentials, query, fragment, or a trailing-dot hostname");
  }
  return endpoint;
}

/**
 * Verify a token; returns the payload or null on any tampering / bad shape /
 * elapsed expiry.
 *
 * ⛔ An absent `exp` is valid, not a rejection: tokens minted before expiry
 * existed are still in mailboxes, and a recipient who was promised a working
 * opt-out link must keep one. A present `exp` must be a finite number and must
 * still be in the future — it is inside the signed payload, so it cannot be
 * stripped or moved without breaking the HMAC.
 */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  clock: UnsubscribeTokenClock = {},
): Promise<UnsubscribePayload | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacBase64url(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(base64urlDecodeToString(body)) as {
      e?: unknown;
      p?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.e !== "string" || typeof parsed.p !== "string") return null;
    if (!parsed.e || !parsed.p) return null;
    if (parsed.exp !== undefined) {
      if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
      const nowSeconds = Math.floor((clock.now ?? new Date()).getTime() / 1000);
      if (parsed.exp <= nowSeconds) return null;
    }
    return { email: parsed.e, purpose: parsed.p };
  } catch {
    return null;
  }
}
