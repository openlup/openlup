import { z } from "zod";
import { installedPolicy } from "./installedPolicy.js";
import type { RenewalStockProtectionPolicy } from "./contracts/renewalStockProtection.js";

const key = "inventory_renewal_protection";
const code = "inventory_renewal_protection_policy_invalid";
const fallback: RenewalStockProtectionPolicy = { revision: "default", renewalProtectionDays: 14 };
const policySchema = () => z.strictObject({
  revision: z.string(),
  renewalProtectionDays: z.int().min(1).max(3660),
});
const schema = policySchema();
const hasRevision = (value: RenewalStockProtectionPolicy) => value.revision.trim().length > 0;

/** @experimental Discovery metadata for the installed renewal stock protection policy. */
export function describeRenewalStockProtectionSetting() {
  return {
    key,
    domain: "inventory",
    kind: "installed",
    goal: "Set the renewal stock protection horizon used to calculate stock available to new purchases.",
    schemaVersion: 1,
    schema: policySchema(),
    rules: [{
      code,
      path: [],
      description: "Supply exactly revision and renewalProtectionDays. Revision must be a nonblank string and renewalProtectionDays an integer from 1 through 3660.",
      check: hasRevision,
    }],
    examples: [
      { value: { revision: "store-1", renewalProtectionDays: 21 } },
      { value: { revision: " ", renewalProtectionDays: 21 }, code },
      { value: { revision: "store-1", renewalProtectionDays: 0 }, code },
    ],
    fallback: { ...fallback },
    defaultBasis: { kind: "reference-code" },
    whyThisDefault: "Two weeks cover a typical replenishment cycle and preserve the established stock priority.",
    effect: {
      appliesTo: "Future available-to-promise calculations and new purchase allocations.",
      frozenOn: ["Existing reservations keep their quantities and expiry times."],
      impact: "operations",
    },
    runtime: { level: "read-only", reason: "The editor reads the installed horizon. Apply changes with the installer at deployment." },
    change: { operation: "installRenewalStockProtectionPolicy" },
  } as const;
}

export function validateRenewalStockProtection(value: unknown): RenewalStockProtectionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "renewalProtectionDays,revision") throw new Error(code);
  // The old validator checked own keys, then read only the two policy fields.
  const fields = value as Record<string, unknown>;
  const parsed = schema.safeParse({ revision: fields.revision, renewalProtectionDays: fields.renewalProtectionDays });
  if (!parsed.success || !hasRevision(parsed.data)) throw new Error(code);
  return parsed.data;
}
interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const store = (db: Executor) => installedPolicy(db, key, validateRenewalStockProtection, fallback, code);

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
