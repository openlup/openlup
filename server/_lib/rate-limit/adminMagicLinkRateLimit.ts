import { createHash } from "node:crypto";

const RPC_NAME = "public_record_admin_magic_link_attempt" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 5;
const DEFAULT_MAX_PER_EMAIL = 3;

export type AdminMagicLinkRateLimitReason =
  | "ip_quota"
  | "email_quota"
  | "rpc_error";

export interface AdminMagicLinkRateLimitResult {
  allowed: boolean;
  reason?: AdminMagicLinkRateLimitReason;
  attemptsByIp: number;
  attemptsByEmail: number;
}

export interface AdminMagicLinkRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export interface AdminMagicLinkRateLimitArgs {
  client: AdminMagicLinkRateLimitClient;
  ip: string;
  email: string;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
}

export function hashAdminMagicLinkRateLimitKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function checkAndRecordAdminMagicLinkAttempt(
  args: AdminMagicLinkRateLimitArgs,
): Promise<AdminMagicLinkRateLimitResult> {
  const ipHash = hashAdminMagicLinkRateLimitKey(args.ip);
  const emailHash = hashAdminMagicLinkRateLimitKey(args.email);

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
      "admin_magic_link_rate_limit_rpc_threw",
      JSON.stringify({ error: thrown instanceof Error ? thrown.message : "unknown" }),
    );
    return rpcErrorResult();
  }

  if (error || data === null || data === undefined) {
    console.warn(
      "admin_magic_link_rate_limit_rpc_failed",
      JSON.stringify({ error: error?.message ?? "no_data" }),
    );
    return rpcErrorResult();
  }

  const row = pickRow(data);
  if (!row) {
    console.warn("admin_magic_link_rate_limit_rpc_empty", JSON.stringify({}));
    return rpcErrorResult();
  }

  return {
    allowed: Boolean(row.allowed),
    reason: pickReason(row.reason),
    attemptsByIp: pickNumber(row.attempts_by_ip),
    attemptsByEmail: pickNumber(row.attempts_by_email),
  };
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

function pickReason(value: unknown): AdminMagicLinkRateLimitReason | undefined {
  return value === "ip_quota" || value === "email_quota" ? value : undefined;
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

function rpcErrorResult(): AdminMagicLinkRateLimitResult {
  return { allowed: false, reason: "rpc_error", attemptsByIp: 0, attemptsByEmail: 0 };
}
