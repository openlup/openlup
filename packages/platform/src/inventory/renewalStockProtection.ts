import { installedPolicy } from "./installedPolicy.js";
import type { RenewalStockProtectionPolicy } from "./contracts/renewalStockProtection.js";

const code = "inventory_renewal_protection_policy_invalid";
function validate(value: unknown): RenewalStockProtectionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join(",") !== "renewalProtectionDays,revision"
    || typeof policy.revision !== "string" || !policy.revision.trim()
    || typeof policy.renewalProtectionDays !== "number" || !Number.isInteger(policy.renewalProtectionDays)
    || policy.renewalProtectionDays < 1 || policy.renewalProtectionDays > 3660) throw new Error(code);
  return { revision: policy.revision, renewalProtectionDays: policy.renewalProtectionDays };
}
interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const store = (db: Executor) => installedPolicy(db, "inventory_renewal_protection", validate,
  { revision: "default", renewalProtectionDays: 14 }, code);

/** Explicit install step on a host-owned write-capable connection. Never called by a read. */
export async function installRenewalStockProtectionPolicy(db: Executor, policy: RenewalStockProtectionPolicy): Promise<void> {
  await store(db).install(policy);
}
/** Absence retains the historical 14-day priority. Malformed installed data refuses. */
export async function readRenewalStockProtectionPolicy(db: Executor): Promise<RenewalStockProtectionPolicy> {
  return store(db).read();
}
