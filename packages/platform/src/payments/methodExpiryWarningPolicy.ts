import { z } from "zod";

const key = "payment_method_expiry_warning_days";
const code = "payment_method_expiry_warning_days_policy_invalid";

/** @experimental Default warning window (in days) before payment method expiry flags `method_expiring`. */
export const DEFAULT_PAYMENT_METHOD_EXPIRY_WARNING_DAYS = 30;

/** @experimental Installed policy configuring when expiring subscription payment methods trigger `method_expiring`. */
export interface PaymentMethodExpiryWarningDaysPolicy {
  revision: string;
  warningDays: number;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: PaymentMethodExpiryWarningDaysPolicy = {
  revision: "default",
  warningDays: DEFAULT_PAYMENT_METHOD_EXPIRY_WARNING_DAYS,
};

const policySchema = z.strictObject({
  revision: z.string(),
  warningDays: z.int().min(1).max(365),
});

/** @experimental Validate a `payment_method_expiry_warning_days` policy document using SQL-equivalent rules. */
export function validatePaymentMethodExpiryWarningDays(value: unknown): PaymentMethodExpiryWarningDaysPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "revision,warningDays") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, warningDays: fields.warningDays });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return parsed.data;
}

/** @experimental Install the payment method expiry warning policy on a host-owned write-capable connection. */
export async function installPaymentMethodExpiryWarningDaysPolicy(
  db: Executor,
  policy: PaymentMethodExpiryWarningDaysPolicy,
): Promise<void> {
  const validated = validatePaymentMethodExpiryWarningDays(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `payment_method_expiry_warning_days` override, returning `undefined` when absent. */
export async function readPaymentMethodExpiryWarningDaysOverride(
  db: Executor,
): Promise<PaymentMethodExpiryWarningDaysPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validatePaymentMethodExpiryWarningDays(value);
}

/** @experimental Read the installed `payment_method_expiry_warning_days` policy or the 30-day absence fallback. */
export async function readPaymentMethodExpiryWarningDaysPolicy(
  db: Executor,
): Promise<PaymentMethodExpiryWarningDaysPolicy> {
  return await readPaymentMethodExpiryWarningDaysOverride(db) ?? { ...fallback };
}
