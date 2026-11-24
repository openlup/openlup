import { z } from "zod";

const key = "payment_decline_notice_timing";
const code = "payment_decline_notice_timing_policy_invalid";

/** @experimental Default delay (in minutes) before a recoverable one-time decline notice becomes available. */
export const DEFAULT_PAYMENT_DECLINE_NOTICE_DELAY_MINUTES = 3;

/** @experimental Default lifetime (in hours) for a payment decline recovery link. */
export const DEFAULT_PAYMENT_DECLINE_LINK_LIFETIME_HOURS = 24;

/** @experimental Installed policy configuring delay and recovery link lifetime for payment decline notices. */
export interface PaymentDeclineNoticeTimingPolicy {
  revision: string;
  delayMinutes: number;
  linkLifetimeHours: number;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: PaymentDeclineNoticeTimingPolicy = {
  revision: "default",
  delayMinutes: DEFAULT_PAYMENT_DECLINE_NOTICE_DELAY_MINUTES,
  linkLifetimeHours: DEFAULT_PAYMENT_DECLINE_LINK_LIFETIME_HOURS,
};

const policySchema = z.strictObject({
  revision: z.string(),
  delayMinutes: z.int().min(0).max(1440),
  linkLifetimeHours: z.int().min(1).max(168),
});

/** @experimental Validate a `payment_decline_notice_timing` policy document using SQL-equivalent rules. */
export function validatePaymentDeclineNoticeTiming(value: unknown): PaymentDeclineNoticeTimingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "delayMinutes,linkLifetimeHours,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({
    revision: fields.revision,
    delayMinutes: fields.delayMinutes,
    linkLifetimeHours: fields.linkLifetimeHours,
  });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return parsed.data;
}

/** @experimental Install the payment decline notice timing policy on a host-owned write-capable connection. */
export async function installPaymentDeclineNoticeTimingPolicy(
  db: Executor,
  policy: PaymentDeclineNoticeTimingPolicy,
): Promise<void> {
  const validated = validatePaymentDeclineNoticeTiming(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `payment_decline_notice_timing` override, returning `undefined` when absent. */
export async function readPaymentDeclineNoticeTimingOverride(
  db: Executor,
): Promise<PaymentDeclineNoticeTimingPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validatePaymentDeclineNoticeTiming(value);
}

/** @experimental Read the installed `payment_decline_notice_timing` policy or the 3-minute / 24-hour absence fallback. */
export async function readPaymentDeclineNoticeTimingPolicy(
  db: Executor,
): Promise<PaymentDeclineNoticeTimingPolicy> {
  return await readPaymentDeclineNoticeTimingOverride(db) ?? { ...fallback };
}
