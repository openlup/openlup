import { z } from "zod";
import { createPostgresStockAvailability } from "./postgresStockAvailability.js";
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
const policyRule = "Supply exactly revision and renewalProtectionDays. Revision must be a nonblank string and renewalProtectionDays an integer from 1 through 3660.";
const hasRevision = (value: RenewalStockProtectionPolicy) => value.revision.trim().length > 0;

/** @experimental Discovery metadata for the installed renewal stock protection policy. */
export function describeRenewalStockProtectionSetting() {
  return {
    key,
    domain: "inventory",
    kind: "installed",
    goal: "Set the renewal stock protection horizon used to calculate stock available to new purchases.",
    searchTerms: "stock lookahead, inventory buffer, renewal allocation, available to promise",
    schemaVersion: 1,
    schema: policySchema(),
    previewSchema: previewEffectSchema(),
    rules: [{
      code,
      path: [],
      description: policyRule,
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
    runtime: { level: "preview", reason: "Runtime changes require a shared write path and proof that rollback restores a prior value and an absent setting." },
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

const previewEffectSchema = () => z.strictObject({
  existingReservations: z.literal("unchanged"),
  newPurchaseAvailability: z.enum(["equal-or-lower", "equal-or-higher", "unchanged", "undetermined"]),
  skus: z.array(z.strictObject({
    sku: z.string(),
    source: z.enum(["provider", "local", "missing"]),
    stale: z.boolean(),
    currentAvailableForNewPurchases: z.number().nullable(),
    proposedAvailableForNewPurchases: z.number().nullable().optional(),
  })),
});

const remediationSchema = z.strictObject({ retry: z.boolean(), action: z.string(), command: z.string() });
const validationResult = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("valid"), value: policySchema() }),
  z.strictObject({
    state: z.literal("invalid"),
    code: z.literal(code), rule: z.string(), hint: z.string(), remediation: remediationSchema,
  }),
]);

export const renewalStockProtectionPreviewResult = z.strictObject({
  schemaVersion: z.literal(1),
  key: z.literal(key),
  asOf: z.iso.datetime(),
  current: policySchema(),
  proposed: z.json(),
  difference: z.strictObject({ renewalProtectionDays: z.int() }).nullable(),
  validation: validationResult,
  effect: previewEffectSchema(),
  uncertainty: z.string(),
});

type Validation = z.infer<typeof validationResult>;
type PreviewResult = z.infer<typeof renewalStockProtectionPreviewResult>;

const invalidPolicy: Validation = {
  state: "invalid", code, rule: policyRule,
  hint: "Check the value schema and examples for inventory_renewal_protection.",
  remediation: {
    retry: true,
    action: "Correct the proposed value and repeat the preview.",
    command: "node --experimental-strip-types host/settings.ts show inventory_renewal_protection --json",
  },
};

async function validateInPostgres(db: Executor, proposed: PreviewResult["proposed"]): Promise<Validation> {
  try {
    const { rows } = await db.query("SELECT public.inventory_renewal_protection_validate($1::jsonb) AS value", [JSON.stringify(proposed)]);
    return { state: "valid", value: policySchema().parse(rows[0]?.value) };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)) throw error;
    if (error.code === "22023" || error.code === "22P05") return invalidPolicy;
    throw error;
  }
}

/** @experimental A host-owned pool and stock source for read-only preview. */
export interface RenewalStockProtectionPreviewConnection {
  db: { connect(): Promise<Executor & { release(error?: boolean): void }> };
  sourceKey: string;
}

/** @experimental Preview installed and proposed renewal stock protection at the same observation instant. */
export async function previewRenewalStockProtection(
  settingKey: typeof key,
  proposed: PreviewResult["proposed"],
  context: RenewalStockProtectionPreviewConnection & { asOf: string; skus: readonly string[] },
): Promise<PreviewResult> {
  const client = await context.db.connect();
  let releaseWithError = true;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const current = await readRenewalStockProtectionPolicy(client);
    const stock = createPostgresStockAvailability(client, { sourceKey: context.sourceKey, now: () => context.asOf });
    const rows = await stock.readInstalled(context.skus);
    // A PostgreSQL refusal aborts the transaction. Perform validation after the snapshot reads.
    const validation = await validateInPostgres(client, proposed);
    const days = validation.state === "valid"
      ? validation.value.renewalProtectionDays - current.renewalProtectionDays
      : null;
    return renewalStockProtectionPreviewResult.parse({
      schemaVersion: 1, key: settingKey, asOf: context.asOf, current, proposed,
      difference: days === null ? null : { renewalProtectionDays: days },
      validation,
      effect: {
        existingReservations: "unchanged",
        newPurchaseAvailability: days === null ? "undetermined"
          : days > 0 ? "equal-or-lower" : days < 0 ? "equal-or-higher" : "unchanged",
        skus: [...rows.values()].map(row => ({
          sku: row.sku, source: row.source, stale: row.stale,
          currentAvailableForNewPurchases: row.source === "missing" ? null : row.availableForNewPurchases,
          proposedAvailableForNewPurchases: null,
        })),
      },
      uncertainty: "Availability under the proposed horizon is not computed yet. It will be reported in effect.skus[].proposedAvailableForNewPurchases. Recorded stock and demand can change.",
    });
  } finally {
    try {
      await client.query("ROLLBACK");
      releaseWithError = false;
    } finally {
      client.release(releaseWithError);
    }
  }
}
