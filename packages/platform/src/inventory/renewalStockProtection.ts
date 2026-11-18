import { z } from "zod";
import { installedPolicy } from "./installedPolicy.js";
import type { RenewalStockProtectionPolicy } from "./contracts/renewalStockProtection.js";

/** @experimental Discovery metadata for the installed renewal stock protection policy. */
export const renewalStockProtectionSetting = {
  key: "inventory_renewal_protection",
  domain: "inventory",
  kind: "installed",
  goal: "Set the renewal stock protection horizon used to calculate stock available to new purchases.",
  schemaVersion: 1,
  schema: z.strictObject({
    revision: z.string(),
    renewalProtectionDays: z.int().min(1).max(3660),
  }),
  rules: [{
    code: "inventory_renewal_protection_policy_invalid",
    path: ["revision"],
    description: "The revision must contain a non-whitespace character.",
    check: (value: RenewalStockProtectionPolicy) => value.revision.trim().length > 0,
  }],
  examples: [
    { value: { revision: "store-1", renewalProtectionDays: 21 } },
    { value: { revision: " ", renewalProtectionDays: 21 }, code: "inventory_renewal_protection_policy_invalid" },
    { value: { revision: "store-1", renewalProtectionDays: 0 }, code: "inventory_renewal_protection_policy_invalid" },
  ],
  fallback: { revision: "default", renewalProtectionDays: 14 },
  defaultBasis: { kind: "reference-code" },
  whyThisDefault: "Two weeks cover a typical replenishment cycle and preserve the established stock priority.",
  effect: {
    appliesTo: "Future available-to-promise calculations and new purchase allocations.",
    frozenOn: ["Existing reservations keep their quantities and expiry times."],
    impact: "operations",
  },
  runtime: { level: "read-only", reason: "The starter editor still supplies its configured horizon to the stock read port." },
  change: { operation: "installRenewalStockProtectionPolicy" },
} as const;

const setting = renewalStockProtectionSetting;
const code = setting.rules[0].code;
export function validateRenewalStockProtection(value: unknown): RenewalStockProtectionPolicy {
  // Keep the old exact own-enumerable field boundary for non-JSON TS callers.
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "renewalProtectionDays,revision") throw new Error(code);
  const parsed = setting.schema.safeParse(value);
  if (!parsed.success || !setting.rules.every(rule => rule.check(parsed.data))) throw new Error(code);
  return { revision: parsed.data.revision, renewalProtectionDays: parsed.data.renewalProtectionDays };
}
interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const store = (db: Executor) => installedPolicy(db, setting.key, validateRenewalStockProtection, setting.fallback, code);

/** Explicit install step on a host-owned write-capable connection. Never called by a read. */
export async function installRenewalStockProtectionPolicy(db: Executor, policy: RenewalStockProtectionPolicy): Promise<void> {
  await store(db).install(policy);
}
/** Absence retains the historical 14-day priority. Malformed installed data refuses. */
export async function readRenewalStockProtectionPolicy(db: Executor): Promise<RenewalStockProtectionPolicy> {
  return store(db).read();
}

/** @experimental Read an explicit installed override, preserving absence. */
export async function readRenewalStockProtectionOverride(db: Executor): Promise<RenewalStockProtectionPolicy | undefined> {
  return store(db).readOverride();
}
