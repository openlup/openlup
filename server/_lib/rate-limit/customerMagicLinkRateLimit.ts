import { createHash } from "node:crypto";

const RPC_NAME = "public_record_customer_magic_link_attempt" as const;
const GLOBAL_COUNT_RPC_NAME = "public_count_customer_magic_link_attempts_global" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 5;
const DEFAULT_MAX_PER_EMAIL = 3;
const DEFAULT_MAX_GLOBAL = 500;

export type CustomerMagicLinkRateLimitReason =
  | "ip_quota"
  | "email_quota"
  | "global_quota"
  | "rpc_error";

export interface CustomerMagicLinkRateLimitResult {
  allowed: boolean;
  reason?: CustomerMagicLinkRateLimitReason;
  attemptsByIp: number;
  attemptsByEmail: number;
  attemptsGlobal?: number;
}

export interface CustomerMagicLinkRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export interface CustomerMagicLinkRateLimitArgs {
  client: CustomerMagicLinkRateLimitClient;
  ip: string;
  email: string;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
  maxGlobal?: number;
}

export function hashCustomerMagicLinkRateLimitKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function checkAndRecordCustomerMagicLinkAttempt(
  args: CustomerMagicLinkRateLimitArgs,
): Promise<CustomerMagicLinkRateLimitResult> {
  const ipHash = hashCustomerMagicLinkRateLimitKey(args.ip);
  const emailHash = hashCustomerMagicLinkRateLimitKey(args.email);

  let data: unknown;
  let error: { message?: string } | null;
  try {
    ({ data, error } = await args.client.rpc(RPC_NAME, {
      p_ip_hash: ipHash,
      p_email_hash: emailHash,
      p_window_minutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
      p_max_per_ip: args.maxPerIp ?? DEFAULT_MAX_PER_IP,
      p_max_per_email: args.maxPerEmail ?? DEFAULT_MAX_PER_EMAIL,
    }));
  } catch (thrown) {
    console.warn(
      "customer_magic_link_rate_limit_rpc_threw",
      JSON.stringify({ error: thrown instanceof Error ? thrown.message : "unknown" }),
    );
    return rpcErrorResult();
  }

  if (error || data === null || data === undefined) {
    console.warn(
      "customer_magic_link_rate_limit_rpc_failed",
      JSON.stringify({ error: error?.message ?? "no_data" }),
    );
    return rpcErrorResult();
  }

  const row = pickRow(data);
  if (!row) {
    console.warn("customer_magic_link_rate_limit_rpc_empty", JSON.stringify({}));
    return rpcErrorResult();
  }

  const primary = {
    allowed: Boolean(row.allowed),
    reason: pickReason(row.reason),
    attemptsByIp: pickNumber(row.attempts_by_ip),
    attemptsByEmail: pickNumber(row.attempts_by_email),
  };

  if (!primary.allowed) return primary;

  const globalAttempts = await readGlobalAttemptsFailOpen(
    args.client,
    args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
  );
  if (globalAttempts === null) return primary;

  const maxGlobal = args.maxGlobal ?? DEFAULT_MAX_GLOBAL;
  if (globalAttempts > maxGlobal) {
    return {
      ...primary,
      allowed: false,
      reason: "global_quota",
      attemptsGlobal: globalAttempts,
    };
  }

  return { ...primary, attemptsGlobal: globalAttempts };
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
    if (candidate) return candidate.split(",")[0]?.trim() ?? candidate;
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

async function readGlobalAttemptsFailOpen(
  client: CustomerMagicLinkRateLimitClient,
  windowMinutes: number,
): Promise<number | null> {
  try {
    const { data, error } = await client.rpc(GLOBAL_COUNT_RPC_NAME, {
      p_window_minutes: windowMinutes,
    });
    if (error) {
      console.warn(
        "customer_magic_link_global_rate_limit_failed_open",
        JSON.stringify({ error: error.message ?? "unknown" }),
      );
      return null;
    }
    const value = pickGlobalCount(data);
    if (value === null) {
      console.warn("customer_magic_link_global_rate_limit_failed_open", JSON.stringify({ error: "bad_shape" }));
      return null;
    }
    return value;
  } catch (thrown) {
    console.warn(
      "customer_magic_link_global_rate_limit_failed_open",
      JSON.stringify({ error: thrown instanceof Error ? thrown.message : "unknown" }),
    );
    return null;
  }
}

function pickReason(value: unknown): CustomerMagicLinkRateLimitReason | undefined {
  return value === "ip_quota" || value === "email_quota" || value === "global_quota" ? value : undefined;
}

function pickNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pickGlobalCount(data: unknown): number | null {
  if (typeof data === "number" && Number.isFinite(data)) return data;
  if (Array.isArray(data)) return pickGlobalCount(data[0]);
  if (isRecord(data)) {
    const value = data.public_count_customer_magic_link_attempts_global ?? data.count ?? data.attempts_global;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return null;
}

function pickHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

/**
 * Returned when the RPC fails technically (throws, errors, or yields no row) —
 * distinct from a genuine quota denial. The caller fails closed on this reason
 * (returns 503) rather than masking it as a quota hit, so a downed limiter does
 * not silently open an enumeration/brute-force window.
 */
function rpcErrorResult(): CustomerMagicLinkRateLimitResult {
  return { allowed: false, reason: "rpc_error", attemptsByIp: 0, attemptsByEmail: 0 };
}
