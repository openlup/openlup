import { extractClientIp, hashRateLimitKey } from "./publicSignupRateLimit.js";

const RPC_NAME = "public_record_eligibility_lookup_attempt" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 60;
const DEFAULT_MAX_PER_EMAIL = 20;

export type CustomerEligibilityRateLimitReason =
  | "ip_quota"
  | "email_quota"
  | "limiter_unavailable";

export interface CustomerEligibilityRateLimitResult {
  allowed: boolean;
  reason?: CustomerEligibilityRateLimitReason;
  attemptsByIp: number;
  attemptsByEmail: number;
}

export interface CustomerEligibilityRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface CustomerEligibilityRateLimitArgs {
  client: CustomerEligibilityRateLimitClient;
  ip: string;
  email: string;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
}

export interface CustomerEligibilityRateLimitPort {
  check(input: {
    headers: Record<string, string | string[] | undefined>;
    email: string;
  }): Promise<CustomerEligibilityRateLimitResult>;
}

export function createSupabaseCustomerEligibilityRateLimitPort(
  client: CustomerEligibilityRateLimitClient,
): CustomerEligibilityRateLimitPort {
  return {
    check(input) {
      return checkAndRecordEligibilityLookupAttempt({
        client,
        ip: extractClientIp(input.headers),
        email: input.email,
      });
    },
  };
}

/**
 * Fail-closed rate-limit for the eligibility lookup. An RPC error / empty result
 * denies the lookup (so a broken limiter cannot turn the endpoint into an
 * unthrottled enumeration oracle). The FE recognition hook fails soft on a denied
 * lookup, so this never blocks the configurator flow.
 */
export async function checkAndRecordEligibilityLookupAttempt(
  args: CustomerEligibilityRateLimitArgs,
): Promise<CustomerEligibilityRateLimitResult> {
  const { data, error } = await args.client.rpc(RPC_NAME, {
    p_ip_hash: hashRateLimitKey(args.ip),
    p_email_hash: hashRateLimitKey(args.email.trim().toLowerCase()),
    p_window_minutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    p_max_per_ip: args.maxPerIp ?? DEFAULT_MAX_PER_IP,
    p_max_per_email: args.maxPerEmail ?? DEFAULT_MAX_PER_EMAIL,
  });

  if (error || data === null || data === undefined) {
    console.warn(
      "customer_eligibility_rate_limit_rpc_failed",
      JSON.stringify({ error: error?.message ?? "no_data" }),
    );
    return failClosedUnavailableResult();
  }

  const row = pickRow(data);
  if (!row) {
    console.warn("customer_eligibility_rate_limit_rpc_empty");
    return failClosedUnavailableResult();
  }

  return {
    allowed: Boolean(row.allowed),
    reason: (row.reason as CustomerEligibilityRateLimitReason | null) ?? undefined,
    attemptsByIp: Number(row.attempts_by_ip ?? 0),
    attemptsByEmail: Number(row.attempts_by_email ?? 0),
  };
}

function failClosedUnavailableResult(): CustomerEligibilityRateLimitResult {
  return {
    allowed: false,
    reason: "limiter_unavailable",
    attemptsByIp: 0,
    attemptsByEmail: 0,
  };
}

interface EligibilityRateLimitRow {
  allowed?: unknown;
  reason?: unknown;
  attempts_by_ip?: unknown;
  attempts_by_email?: unknown;
}

function pickRow(data: unknown): EligibilityRateLimitRow | null {
  if (Array.isArray(data)) return (data[0] as EligibilityRateLimitRow) ?? null;
  if (data && typeof data === "object") return data as EligibilityRateLimitRow;
  return null;
}
