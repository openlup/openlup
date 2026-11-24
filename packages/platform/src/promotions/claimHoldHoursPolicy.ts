import { z } from "zod";

const key = "promotion_claim_hold_hours";
const code = "promotion_claim_hold_hours_policy_invalid";

/** @experimental Default hold duration (in hours) for newly reserved promotion claims on promoted order drafts. */
export const DEFAULT_PROMOTION_CLAIM_HOLD_HOURS = 24;

/** @experimental Installed policy configuring the reservation hold window for new promotion claims. */
export interface PromotionClaimHoldHoursPolicy {
  revision: string;
  holdHours: number;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: PromotionClaimHoldHoursPolicy = {
  revision: "default",
  holdHours: DEFAULT_PROMOTION_CLAIM_HOLD_HOURS,
};

const policySchema = z.strictObject({
  revision: z.string(),
  holdHours: z.int().min(1).max(720),
});

/** @experimental Validate a `promotion_claim_hold_hours` policy document using SQL-equivalent rules. */
export function validatePromotionClaimHoldHours(value: unknown): PromotionClaimHoldHoursPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "holdHours,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, holdHours: fields.holdHours });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return parsed.data;
}

/** @experimental Install the promotion claim hold policy on a host-owned write-capable connection. */
export async function installPromotionClaimHoldHoursPolicy(
  db: Executor,
  policy: PromotionClaimHoldHoursPolicy,
): Promise<void> {
  const validated = validatePromotionClaimHoldHours(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `promotion_claim_hold_hours` override, returning `undefined` when absent. */
export async function readPromotionClaimHoldHoursOverride(
  db: Executor,
): Promise<PromotionClaimHoldHoursPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validatePromotionClaimHoldHours(value);
}

/** @experimental Read the installed `promotion_claim_hold_hours` policy or the 24-hour absence fallback. */
export async function readPromotionClaimHoldHoursPolicy(
  db: Executor,
): Promise<PromotionClaimHoldHoursPolicy> {
  return await readPromotionClaimHoldHoursOverride(db) ?? { ...fallback };
}
