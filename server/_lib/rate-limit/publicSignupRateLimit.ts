import { createHash } from "node:crypto";

const RPC_NAME = "public_record_signup_attempt" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 5;
const DEFAULT_MAX_PER_EMAIL = 3;

export type PublicSignupEndpoint = "waitlist" | "tester_signup";

export type PublicSignupRateLimitReason = "ip_quota" | "email_quota" | "limiter_unavailable";

export interface PublicSignupRateLimitResult {
  allowed: boolean;
  reason?: PublicSignupRateLimitReason;
  attemptsByIp: number;
  attemptsByEmail: number;
}

export interface PublicSignupRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export interface PublicSignupRateLimitArgs {
  client: PublicSignupRateLimitClient;
  endpoint: PublicSignupEndpoint;
  ip: string;
  email: string;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
}

export function hashRateLimitKey(value: string): string {
  return createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex");
}

export async function checkAndRecordSignupAttempt(
  args: PublicSignupRateLimitArgs,
): Promise<PublicSignupRateLimitResult> {
  const ipHash = hashRateLimitKey(args.ip);
  const emailHash = hashRateLimitKey(args.email);

  const { data, error } = await args.client.rpc(RPC_NAME, {
    p_endpoint: args.endpoint,
    p_ip_hash: ipHash,
    p_email_hash: emailHash,
    p_window_minutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    p_max_per_ip: args.maxPerIp ?? DEFAULT_MAX_PER_IP,
    p_max_per_email: args.maxPerEmail ?? DEFAULT_MAX_PER_EMAIL,
  });

  if (error || data === null || data === undefined) {
    console.warn(
      "public_signup_rate_limit_rpc_failed",
      JSON.stringify({
        endpoint: args.endpoint,
        error: error?.message ?? "no_data",
      }),
    );
    return failClosedUnavailableResult();
  }

  const row = pickRow(data);
  if (!row) {
    console.warn(
      "public_signup_rate_limit_rpc_empty",
      JSON.stringify({ endpoint: args.endpoint }),
    );
    return failClosedUnavailableResult();
  }

  return {
    allowed: Boolean(row.allowed),
    reason: pickReason(row.reason),
    attemptsByIp: pickNumber(row.attempts_by_ip),
    attemptsByEmail: pickNumber(row.attempts_by_email),
  };
}

export interface PublicSignupRateLimitRequestShape {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface MaybeCheckPublicSignupRateLimitArgs {
  client: PublicSignupRateLimitClient;
  endpoint: PublicSignupEndpoint;
  req: PublicSignupRateLimitRequestShape;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
}

/**
 * BFF convenience: only rate-limits POST requests that carry an email body
 * field. Returns null when rate-limit doesn't apply (other methods, no
 * email) so callers can short-circuit cheaply.
 */
export async function maybeCheckPublicSignupRateLimit(
  args: MaybeCheckPublicSignupRateLimitArgs,
): Promise<PublicSignupRateLimitResult | null> {
  const method = (args.req.method ?? "").toUpperCase();
  if (method !== "POST") return null;

  const rawBody = (args.req.body ?? {}) as Record<string, unknown>;
  const emailValue = rawBody.email;
  const email = typeof emailValue === "string" ? emailValue.trim() : "";
  if (!email) return null;

  return checkAndRecordSignupAttempt({
    client: args.client,
    endpoint: args.endpoint,
    ip: extractClientIp(args.req.headers),
    email,
    windowMinutes: args.windowMinutes,
    maxPerIp: args.maxPerIp,
    maxPerEmail: args.maxPerEmail,
  });
}

/**
 * PL-only message text for the BFF envelope. Keep it short and user-facing.
 * The error code stays `RATE_LIMITED` so frontend handlers can branch on
 * envelope shape rather than parsing the message.
 */
export function formatPublicSignupRateLimitMessage(
  reason: PublicSignupRateLimitReason | undefined,
): string {
  if (reason === "email_quota") {
    return "Ten adres email zgłoszono zbyt wiele razy. Spróbuj ponownie za godzinę.";
  }
  return "Zbyt wiele prób z tego adresu. Spróbuj ponownie za godzinę.";
}

export function isPublicSignupLimiterUnavailable(
  result: PublicSignupRateLimitResult,
): boolean {
  return !result.allowed && result.reason === "limiter_unavailable";
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
    const head = data[0];
    return isRecord(head) ? (head as RpcRow) : null;
  }
  return isRecord(data) ? (data as RpcRow) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickReason(value: unknown): PublicSignupRateLimitReason | undefined {
  return value === "ip_quota" || value === "email_quota" || value === "limiter_unavailable"
    ? value
    : undefined;
}

function pickNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pickHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function failClosedUnavailableResult(): PublicSignupRateLimitResult {
  return {
    allowed: false,
    reason: "limiter_unavailable",
    attemptsByIp: 0,
    attemptsByEmail: 0,
  };
}
