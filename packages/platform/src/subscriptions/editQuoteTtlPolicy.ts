import { z } from "zod";

const key = "subscription_edit_quote_ttl_minutes";
const code = "subscription_edit_quote_ttl_minutes_policy_invalid";

/** @experimental Default edit quote TTL (in minutes) for customer self-service and typed subscription edit previews. */
export const DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES = 15;

/** @experimental Installed policy configuring the edit quote TTL in minutes (1..1440). */
export interface SubscriptionEditQuoteTtlMinutesPolicy {
  revision: string;
  ttlMinutes: number;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: SubscriptionEditQuoteTtlMinutesPolicy = {
  revision: "default",
  ttlMinutes: DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES,
};

const ttlMinutesSchema = z.int().min(1).max(1440);

const policySchema = z.strictObject({
  revision: z.string(),
  ttlMinutes: ttlMinutesSchema,
});

/** @experimental Validate and resolve an optional `quoteTtlMinutes` editor option (1..1440, defaulting to 15). */
export function resolveSubscriptionEditQuoteTtlMinutes(quoteTtlMinutes?: number): number {
  if (quoteTtlMinutes === undefined) return DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES;
  const parsed = ttlMinutesSchema.safeParse(quoteTtlMinutes);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

/** @experimental Validate a `subscription_edit_quote_ttl_minutes` policy document using SQL-equivalent rules. */
export function validateSubscriptionEditQuoteTtlMinutes(value: unknown): SubscriptionEditQuoteTtlMinutesPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "revision,ttlMinutes") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, ttlMinutes: fields.ttlMinutes });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return parsed.data;
}

/** @experimental Install the subscription edit quote TTL policy on a host-owned write-capable connection. */
export async function installSubscriptionEditQuoteTtlMinutesPolicy(
  db: Executor,
  policy: SubscriptionEditQuoteTtlMinutesPolicy,
): Promise<void> {
  const validated = validateSubscriptionEditQuoteTtlMinutes(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `subscription_edit_quote_ttl_minutes` override, returning `undefined` when absent. */
export async function readSubscriptionEditQuoteTtlMinutesOverride(
  db: Executor,
): Promise<SubscriptionEditQuoteTtlMinutesPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateSubscriptionEditQuoteTtlMinutes(value);
}

/** @experimental Read the installed `subscription_edit_quote_ttl_minutes` policy or the 15-minute absence fallback. */
export async function readSubscriptionEditQuoteTtlMinutesPolicy(
  db: Executor,
): Promise<SubscriptionEditQuoteTtlMinutesPolicy> {
  return await readSubscriptionEditQuoteTtlMinutesOverride(db) ?? { ...fallback };
}
