import { z } from "zod";

const key = "account_support_operator_slide_max_days";
const code = "account_support_operator_slide_max_days_policy_invalid";

/** @experimental Default maximum days ahead an operator slide command can schedule the next subscription cycle. */
export const DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS = 60;

/** @experimental Installed policy configuring the upper bound in days for operator `slide_next_cycle` commands. */
export interface AccountSupportOperatorSlideMaxDaysPolicy {
  revision: string;
  maxDays: number;
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const fallback: AccountSupportOperatorSlideMaxDaysPolicy = {
  revision: "default",
  maxDays: DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS,
};

const policySchema = z.strictObject({
  revision: z.string(),
  maxDays: z.int().min(3).max(365),
});

/** @experimental Validate an `account_support_operator_slide_max_days` policy document using SQL-equivalent rules. */
export function validateAccountSupportOperatorSlideMaxDays(value: unknown): AccountSupportOperatorSlideMaxDaysPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "maxDays,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, maxDays: fields.maxDays });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  return parsed.data;
}

/** @experimental Install the operator slide max days policy on a host-owned write-capable connection. */
export async function installAccountSupportOperatorSlideMaxDaysPolicy(
  db: Executor,
  policy: AccountSupportOperatorSlideMaxDaysPolicy,
): Promise<void> {
  const validated = validateAccountSupportOperatorSlideMaxDays(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `account_support_operator_slide_max_days` override, returning `undefined` when absent. */
export async function readAccountSupportOperatorSlideMaxDaysOverride(
  db: Executor,
): Promise<AccountSupportOperatorSlideMaxDaysPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateAccountSupportOperatorSlideMaxDays(value);
}

/** @experimental Read the installed `account_support_operator_slide_max_days` policy or the 60-day absence fallback. */
export async function readAccountSupportOperatorSlideMaxDaysPolicy(
  db: Executor,
): Promise<AccountSupportOperatorSlideMaxDaysPolicy> {
  return await readAccountSupportOperatorSlideMaxDaysOverride(db) ?? { ...fallback };
}
