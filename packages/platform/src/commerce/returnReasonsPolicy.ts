import { z } from "zod";

const key = "commerce_return_reasons";
const code = "commerce_return_reasons_policy_invalid";
const reasonCodePattern = /^[a-z][a-z0-9_]{1,63}$/;

/** @experimental Default allowed return reason codes when no `commerce_return_reasons` setting row is installed. */
export const DEFAULT_COMMERCE_RETURN_REASONS: readonly string[] = Object.freeze([
  "damaged",
  "wrong_item",
  "not_as_described",
  "pet_refused",
  "changed_mind",
  "other",
]);

/** @experimental Installed policy configuring the allowed return reason codes for new return requests. */
export interface CommerceReturnReasonsPolicy {
  revision: string;
  reasons: string[];
}

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const policySchema = z.strictObject({
  revision: z.string(),
  reasons: z.array(z.string().regex(reasonCodePattern)).min(1).max(64),
});

/** @experimental Validate a `commerce_return_reasons` policy document using SQL-equivalent rules. */
export function validateCommerceReturnReasons(value: unknown): CommerceReturnReasonsPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "reasons,revision") {
    throw new Error(code);
  }
  const fields = value as Record<string, unknown>;
  const parsed = policySchema.safeParse({ revision: fields.revision, reasons: fields.reasons });
  if (!parsed.success || parsed.data.revision.trim().length === 0) throw new Error(code);
  if (new Set(parsed.data.reasons).size !== parsed.data.reasons.length) throw new Error(code);
  return { revision: parsed.data.revision, reasons: [...parsed.data.reasons] };
}

/** @experimental Install the commerce return reasons policy on a host-owned write-capable connection. */
export async function installCommerceReturnReasonsPolicy(
  db: Executor,
  policy: CommerceReturnReasonsPolicy,
): Promise<void> {
  const validated = validateCommerceReturnReasons(policy);
  await db.query(
    `INSERT INTO public.commerce_settings(key,value_text)
      VALUES($1, public.commerce_return_reasons_validate($2::jsonb)::text)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, JSON.stringify(validated)],
  );
}

/** @experimental Read an explicit `commerce_return_reasons` override, returning `undefined` when absent. */
export async function readCommerceReturnReasonsOverride(
  db: Executor,
): Promise<CommerceReturnReasonsPolicy | undefined> {
  const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
  if (!rows.length) return undefined;
  let value: unknown;
  try {
    if (typeof rows[0]?.value_text !== "string") throw new Error(code);
    value = JSON.parse(rows[0].value_text);
  } catch {
    throw new Error(code);
  }
  return validateCommerceReturnReasons(value);
}

/** @experimental Read the installed `commerce_return_reasons` policy or the default absence fallback. */
export async function readCommerceReturnReasonsPolicy(
  db: Executor,
): Promise<CommerceReturnReasonsPolicy> {
  return await readCommerceReturnReasonsOverride(db) ?? {
    revision: "default",
    reasons: [...DEFAULT_COMMERCE_RETURN_REASONS],
  };
}
