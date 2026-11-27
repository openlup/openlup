import { z } from "zod";

const key = "shipping_payment_method_preferences";
const code = "shipping_payment_method_preferences_policy_invalid";
const methodKindPattern = /^[a-z][a-z0-9_]{1,63}$/;

/** @experimental Default allowed payment method preference codes when no `shipping_payment_method_preferences` setting row is installed. */
export const DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES: readonly string[] = Object.freeze([
  "instant",
  "card",
  "transfer",
]);

/** @experimental Installed policy configuring the allowed payment method preference codes for new preference writes. */
export interface ShippingPaymentMethodPreferencesPolicy {
  revision: string;
  methodKinds: string[];
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const policySchema = z.strictObject({
  revision: z.string(),
  methodKinds: z.array(z.string().regex(methodKindPattern)).min(1).max(32),
});

/** @experimental Validate a `shipping_payment_method_preferences` policy document using SQL-equivalent rules. */
export function validateShippingPaymentMethodPreferences(value: unknown): ShippingPaymentMethodPreferencesPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "methodKinds,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, methodKinds: fields.methodKinds });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  if (new Set(parsed.data.methodKinds).size !== parsed.data.methodKinds.length) throw new Error(code);
  return { revision: parsed.data.revision, methodKinds: [...parsed.data.methodKinds] };
}

/** @experimental Install the shipping payment method preferences policy on a host-owned write-capable connection. */
export async function installShippingPaymentMethodPreferencesPolicy(
  db: Executor,
  policy: ShippingPaymentMethodPreferencesPolicy,
): Promise<void> {
  const validated = validateShippingPaymentMethodPreferences(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text)
      VALUES($1, public.shipping_payment_method_preferences_validate($2::jsonb)::text)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `shipping_payment_method_preferences` override, returning `undefined` when absent. */
export async function readShippingPaymentMethodPreferencesOverride(
  db: Executor,
): Promise<ShippingPaymentMethodPreferencesPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateShippingPaymentMethodPreferences(value);
}

/** @experimental Read the installed `shipping_payment_method_preferences` policy or the default absence fallback. */
export async function readShippingPaymentMethodPreferencesPolicy(
  db: Executor,
): Promise<ShippingPaymentMethodPreferencesPolicy> {
  return await readShippingPaymentMethodPreferencesOverride(db) ?? {
    revision: "default",
    methodKinds: [...DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES],
  };
}
