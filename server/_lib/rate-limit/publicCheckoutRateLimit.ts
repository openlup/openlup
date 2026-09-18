import { createHash } from "node:crypto";

/**
 * Fail-CLOSED rate limiter for the hidden public one-time checkout (Faza A — W11.1).
 *
 * This is intentionally a separate module from `publicSignupRateLimit.ts`. The signup
 * limiter is FAIL-OPEN (returns allowed on RPC error) because waitlist/tester sign-ups
 * are low-stakes and we never want a transient DB blip to block a marketing capture.
 *
 * Checkout mints client/pet/address identity and persists a paid order, so the inverse
 * tradeoff applies: any limiter failure MUST DENY. We never regress the existing
 * fail-open callers — they keep using their own module/RPC/table untouched.
 *
 * Backed by a dedicated `public_record_checkout_attempt` RPC + `public_checkout_attempts`
 * table so the live `public_signup_attempts` surface stays byte-identical.
 */

const RPC_NAME = "public_record_checkout_attempt" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 10;
const DEFAULT_MAX_PER_EMAIL = 5;

export type PublicCheckoutRateLimitReason = "ip_quota" | "email_quota";

export interface PublicCheckoutRateLimitResult {
  allowed: boolean;
  reason?: PublicCheckoutRateLimitReason;
  attemptsByIp: number;
  attemptsByEmail: number;
}

export interface PublicCheckoutRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export interface PublicCheckoutRateLimitArgs {
  client: PublicCheckoutRateLimitClient;
  ip: string;
  email: string;
  /** The journey portion of the exact logical provider-attempt identity. */
  journeyIdempotencyKey: string;
  /** Defaults to the initial provider attempt (0). */
  paymentAttemptSequence?: number;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
}

export function hashCheckoutRateLimitKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Exact provider-attempt identity. The null separator makes the encoding
 * unambiguous without exposing BLIK/payment data to the rate-limit ledger.
 */
export function checkoutAttemptIdentity(
  journeyIdempotencyKey: string,
  paymentAttemptSequence = 0,
): string {
  return `${journeyIdempotencyKey}\0${String(paymentAttemptSequence)}`;
}

/** Attempt keys are opaque and case-sensitive, unlike email/IP inputs. */
export function hashCheckoutAttemptIdentity(
  journeyIdempotencyKey: string,
  paymentAttemptSequence = 0,
): string {
  return createHash("sha256")
    .update(checkoutAttemptIdentity(journeyIdempotencyKey, paymentAttemptSequence))
    .digest("hex");
}

/**
 * Records the attempt and returns the quota decision. On ANY failure (RPC error,
 * empty/malformed row, thrown exception) this returns a denied result — fail-closed.
 */
export async function checkAndRecordCheckoutAttempt(
  args: PublicCheckoutRateLimitArgs,
): Promise<PublicCheckoutRateLimitResult> {
  if (!hasUsableRateLimitInputs(args)) return failClosedResult();

  const ipHash = hashCheckoutRateLimitKey(args.ip);
  const emailHash = hashCheckoutRateLimitKey(args.email);
  const attemptIdentityHash = hashCheckoutAttemptIdentity(
    args.journeyIdempotencyKey,
    args.paymentAttemptSequence ?? 0,
  );

  let data: unknown;
  let error: { message?: string } | null;
  try {
    ({ data, error } = await args.client.rpc(RPC_NAME, {
      p_ip_hash: ipHash,
      p_email_hash: emailHash,
      p_attempt_identity_hash: attemptIdentityHash,
      p_window_minutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
      p_max_per_ip: args.maxPerIp ?? DEFAULT_MAX_PER_IP,
      p_max_per_email: args.maxPerEmail ?? DEFAULT_MAX_PER_EMAIL,
    }));
  } catch {
    // Errors may carry DB inputs, so diagnostics deliberately have no payload.
    console.warn("public_checkout_rate_limit_rpc_threw");
    return failClosedResult();
  }

  if (error || data === null || data === undefined) {
    console.warn("public_checkout_rate_limit_rpc_failed");
    return failClosedResult();
  }

  const result = parseRpcResult(data);
  if (!result) {
    console.warn("public_checkout_rate_limit_rpc_malformed");
    return failClosedResult();
  }

  return result;
}

export function formatPublicCheckoutRateLimitMessage(
  reason: PublicCheckoutRateLimitReason | undefined,
): string {
  if (reason === "email_quota") {
    return "Ten adres email użyto zbyt wiele razy. Spróbuj ponownie za godzinę.";
  }
  return "Zbyt wiele prób z tego adresu. Spróbuj ponownie za godzinę.";
}

export function extractClientIp(
  headers: Record<string, string | string[] | undefined>,
): string {
  const candidates = [
    pickHeader(headers["x-forwarded-for"]),
    pickHeader(headers["cf-connecting-ip"]),
    pickHeader(headers["x-real-ip"]),
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return candidate.split(",")[0]?.trim() ?? candidate;
    }
  }

  return "unknown";
}

interface RpcRow {
  allowed?: unknown;
  reason?: unknown;
  attempts_by_ip?: unknown;
  attempts_by_email?: unknown;
}

function pickRow(data: unknown): RpcRow | null {
  if (Array.isArray(data)) {
    if (data.length !== 1) return null;
    const head = data[0];
    return isRecord(head) ? (head as RpcRow) : null;
  }
  return isRecord(data) ? (data as RpcRow) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickReason(value: unknown): PublicCheckoutRateLimitReason | undefined {
  return value === "ip_quota" || value === "email_quota" ? value : undefined;
}

function isAttemptCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRpcResult(data: unknown): PublicCheckoutRateLimitResult | null {
  const row = pickRow(data);
  if (!row || typeof row.allowed !== "boolean") return null;
  if (!isAttemptCount(row.attempts_by_ip) || !isAttemptCount(row.attempts_by_email)) return null;

  if (row.allowed) {
    if (row.reason !== null && row.reason !== undefined) return null;
    return {
      allowed: true,
      attemptsByIp: row.attempts_by_ip,
      attemptsByEmail: row.attempts_by_email,
    };
  }

  const reason = pickReason(row.reason);
  if (!reason) return null;
  return {
    allowed: false,
    reason,
    attemptsByIp: row.attempts_by_ip,
    attemptsByEmail: row.attempts_by_email,
  };
}

function hasUsableRateLimitInputs(args: PublicCheckoutRateLimitArgs): boolean {
  return isNonBlankString(args.ip) &&
    isNonBlankString(args.email) &&
    isNonBlankString(args.journeyIdempotencyKey) &&
    isAttemptSequence(args.paymentAttemptSequence ?? 0);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAttemptSequence(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 50;
}

function pickHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

/** Fail-CLOSED: deny on any limiter failure. */
function failClosedResult(): PublicCheckoutRateLimitResult {
  return { allowed: false, reason: "ip_quota", attemptsByIp: 0, attemptsByEmail: 0 };
}
