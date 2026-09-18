import {
  extractClientIp,
  hashRateLimitKey,
} from "./publicSignupRateLimit.js";

const RPC_NAME = "commerce_record_stock_notify_attempt" as const;

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_PER_IP = 20;
const DEFAULT_MAX_PER_EMAIL_SKU = 3;

export type StockNotifyRateLimitReason = "ip_quota" | "email_sku_quota" | "limiter_unavailable";

export interface StockNotifyRateLimitResult {
  allowed: boolean;
  reason?: StockNotifyRateLimitReason;
  attemptsByIp: number;
  attemptsByEmailSku: number;
}

export interface StockNotifyRateLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface StockNotifyRateLimitArgs {
  client: StockNotifyRateLimitClient;
  ip: string;
  email: string;
  sku: string;
  windowMinutes?: number;
  maxPerIp?: number;
  maxPerEmailSku?: number;
}

export interface StockNotifyRateLimitPort {
  check(input: { headers: Record<string, string | string[] | undefined>; email: string; sku: string }): Promise<StockNotifyRateLimitResult>;
}

export function createSupabaseStockNotifyRateLimitPort(client: StockNotifyRateLimitClient): StockNotifyRateLimitPort {
  return {
    check(input) {
      return checkAndRecordStockNotifyAttempt({
        client,
        ip: extractClientIp(input.headers),
        email: input.email,
        sku: input.sku,
      });
    },
  };
}

export async function checkAndRecordStockNotifyAttempt(
  args: StockNotifyRateLimitArgs,
): Promise<StockNotifyRateLimitResult> {
  const { data, error } = await args.client.rpc(RPC_NAME, {
    p_ip_hash: hashRateLimitKey(args.ip),
    p_email_hash: hashRateLimitKey(args.email),
    p_sku_hash: hashRateLimitKey(args.sku),
    p_window_minutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    p_max_per_ip: args.maxPerIp ?? DEFAULT_MAX_PER_IP,
    p_max_per_email_sku: args.maxPerEmailSku ?? DEFAULT_MAX_PER_EMAIL_SKU,
  });

  if (error || data === null || data === undefined) {
    console.warn(
      "stock_notify_rate_limit_rpc_failed",
      JSON.stringify({ error: error?.message ?? "no_data" }),
    );
    return failClosedUnavailableResult();
  }

  const row = pickRow(data);
  if (!row) {
    console.warn("stock_notify_rate_limit_rpc_empty");
    return failClosedUnavailableResult();
  }

  return {
    allowed: Boolean(row.allowed),
    reason: pickReason(row.reason),
    attemptsByIp: pickNumber(row.attempts_by_ip),
    attemptsByEmailSku: pickNumber(row.attempts_by_email_sku),
  };
}

export function formatStockNotifyRateLimitMessage(reason: StockNotifyRateLimitReason | undefined): string {
  if (reason === "email_sku_quota") {
    return "Ten adres email zgłoszono dla tego produktu zbyt wiele razy. Spróbuj ponownie za godzinę.";
  }
  return "Zbyt wiele prób z tego adresu. Spróbuj ponownie za godzinę.";
}

interface RpcRow {
  allowed?: unknown;
  reason?: unknown;
  attempts_by_ip?: unknown;
  attempts_by_email_sku?: unknown;
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

function pickReason(value: unknown): StockNotifyRateLimitReason | undefined {
  return value === "ip_quota" || value === "email_sku_quota" || value === "limiter_unavailable"
    ? value
    : undefined;
}

function pickNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function failClosedUnavailableResult(): StockNotifyRateLimitResult {
  return {
    allowed: false,
    reason: "limiter_unavailable",
    attemptsByIp: 0,
    attemptsByEmailSku: 0,
  };
}
