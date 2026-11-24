import { z } from "zod";

const key = "subscription_retry_schedule";
const code = "subscription_retry_schedule_policy_invalid";

/** @experimental Default 3-rung retry backoff schedule (in hours) after failed subscription renewal charges. */
export const DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS: readonly [number, number, number] = Object.freeze([24, 72, 168]);

/** @experimental Installed policy configuring the 3-rung retry backoff ladder for subscription payment failures. */
export interface SubscriptionRetrySchedulePolicy {
  revision: string;
  backoffHours: [number, number, number];
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback = (): SubscriptionRetrySchedulePolicy => ({
  revision: "default",
  backoffHours: [...DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS] as [number, number, number],
});

const hourSchema = z.int().min(1).max(2_147_483_647);

const policySchema = z.strictObject({
  revision: z.string(),
  backoffHours: z.tuple([hourSchema, hourSchema, hourSchema]),
});

/** @experimental Validate a `subscription_retry_schedule` policy document using SQL-equivalent rules. */
export function validateSubscriptionRetrySchedule(value: unknown): SubscriptionRetrySchedulePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "backoffHours,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, backoffHours: fields.backoffHours });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return { revision: parsed.data.revision, backoffHours: [...parsed.data.backoffHours] as [number, number, number] };
}

/** @experimental Install the subscription retry schedule policy on a host-owned write-capable connection. */
export async function installSubscriptionRetrySchedulePolicy(
  db: Executor,
  policy: SubscriptionRetrySchedulePolicy,
): Promise<void> {
  const validated = validateSubscriptionRetrySchedule(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `subscription_retry_schedule` override, returning `undefined` when absent. */
export async function readSubscriptionRetryScheduleOverride(
  db: Executor,
): Promise<SubscriptionRetrySchedulePolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateSubscriptionRetrySchedule(value);
}

/** @experimental Read the installed `subscription_retry_schedule` policy or the `[24, 72, 168]` absence fallback. */
export async function readSubscriptionRetrySchedulePolicy(
  db: Executor,
): Promise<SubscriptionRetrySchedulePolicy> {
  return await readSubscriptionRetryScheduleOverride(db) ?? fallback();
}
