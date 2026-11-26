import { z } from "zod";

const key = "subscription_reschedule_timezone";
const code = "subscription_reschedule_timezone_policy_invalid";

/** @experimental Default IANA time zone for subscription reschedule calendar-day boundaries. */
export const DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE = "UTC";

/** @experimental Installed policy configuring the IANA time zone for subscription reschedule calendar-day boundaries. */
export interface SubscriptionRescheduleTimeZonePolicy {
  revision: string;
  timeZone: string;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: SubscriptionRescheduleTimeZonePolicy = {
  revision: "default",
  timeZone: DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE,
};

const supportedIanaTimeZones = new Set<string>([
  DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE,
  ...Intl.supportedValuesOf("timeZone"),
]);

const policySchema = z.strictObject({
  revision: z.string(),
  timeZone: z.string(),
});

/** @experimental Validate a `subscription_reschedule_timezone` policy document using SQL-equivalent rules. */
export function validateSubscriptionRescheduleTimeZone(value: unknown): SubscriptionRescheduleTimeZonePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "revision,timeZone") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, timeZone: fields.timeZone });
  if (!parsed.success
    || parsed.data.revision.trim().length === 0
    || !supportedIanaTimeZones.has(parsed.data.timeZone)) {
    throw new Error(code);
  }
  return parsed.data;
}

/** @experimental Install the subscription reschedule time zone policy on a host-owned write-capable connection. */
export async function installSubscriptionRescheduleTimeZonePolicy(
  db: Executor,
  policy: SubscriptionRescheduleTimeZonePolicy,
): Promise<void> {
  const validated = validateSubscriptionRescheduleTimeZone(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `subscription_reschedule_timezone` override, returning `undefined` when absent. */
export async function readSubscriptionRescheduleTimeZoneOverride(
  db: Executor,
): Promise<SubscriptionRescheduleTimeZonePolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateSubscriptionRescheduleTimeZone(value);
}

/** @experimental Read the installed `subscription_reschedule_timezone` policy or the UTC absence fallback. */
export async function readSubscriptionRescheduleTimeZonePolicy(
  db: Executor,
): Promise<SubscriptionRescheduleTimeZonePolicy> {
  return await readSubscriptionRescheduleTimeZoneOverride(db) ?? { ...fallback };
}
