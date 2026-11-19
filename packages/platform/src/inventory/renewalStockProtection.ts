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
    runtime: { level: "preview", reason: "Preview is available. Apply changes with the installer at deployment." },
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

type PreviewRefusal = {
  schemaVersion: 1;
  refusal: Omit<Extract<Validation, { state: "invalid" }>, "state" | "code"> & { code: string; path: readonly string[] };
};
type RefusePreview = (code: string, detail?: { path: readonly string[]; hint: string }) => PreviewRefusal;

function sqlState(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function validateInPostgres(db: Executor, proposed: PreviewResult["proposed"], refuse: RefusePreview): Promise<Validation> {
  let installerAdmits: boolean;
  try {
    validateRenewalStockProtection(proposed);
    installerAdmits = true;
  } catch {
    installerAdmits = false;
  }
  try {
    const { rows } = await db.query("SELECT public.inventory_renewal_protection_validate($1::jsonb) AS value", [JSON.stringify(proposed)]);
    const value = policySchema().parse(rows[0]?.value);
    if (installerAdmits) return { state: "valid", value };
  } catch (error) {
    const state = sqlState(error);
    if (state !== "22023" && state !== "22P05") throw error;
  }
  const { rule, hint, remediation } = refuse(code).refusal;
  return { state: "invalid", code, rule, hint, remediation };
}

/** @experimental A host-owned pool and stock source for read-only preview. */
export interface RenewalStockProtectionPreviewConnection {
  db: { connect(): Promise<Executor & { release(error?: boolean): void }> };
  sourceKey: string;
}

const accessRefusals: Readonly<Record<string, string>> = {
  "read the installed policy": "commerce_setting_preview_policy_read_denied",
  "read stock availability": "commerce_setting_preview_stock_read_denied",
  "check the proposed policy": "commerce_setting_preview_validation_denied",
};

/** @experimental Preview installed and proposed renewal stock protection at the same observation instant. */
export async function previewRenewalStockProtection(
  settingKey: typeof key,
  proposed: PreviewResult["proposed"],
  context: RenewalStockProtectionPreviewConnection & { asOf: string; skus: readonly string[]; refuse: RefusePreview },
): Promise<PreviewResult | PreviewRefusal> {
  let operation = "read the proposed policy";
  try {
    const snapshot = structuredClone(proposed);
    operation = "open a store connection";
    const client = await context.db.connect();
    let discard = true;
    try {
      operation = "start a read-only preview";
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      operation = "read the installed policy";
      const current = await readRenewalStockProtectionPolicy(client);
      operation = "read stock availability";
      const stock = createPostgresStockAvailability(client, { sourceKey: context.sourceKey, now: () => context.asOf });
      const rows = await stock.readInstalled(context.skus);
      // A SQL refusal aborts the transaction, so validate after the snapshot reads.
      operation = "check the proposed policy";
      const validation = await validateInPostgres(client, snapshot, context.refuse);
      const days = validation.state === "valid"
        ? validation.value.renewalProtectionDays - current.renewalProtectionDays
        : null;
      const result = renewalStockProtectionPreviewResult.parse({
        schemaVersion: 1, key: settingKey, asOf: context.asOf, current, proposed: snapshot,
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
      return { ...result, proposed: snapshot };
    } finally {
      try {
        await client.query("ROLLBACK");
        discard = false;
      } finally {
        if (discard) operation = "finish the preview";
        client.release(discard);
      }
    }
  } catch (error) {
    const state = sqlState(error);
    const denied = accessRefusals[operation];
    if (state === "42501" && denied) return context.refuse(denied);
    if (state === "42883" && operation === "check the proposed policy") {
      return context.refuse("commerce_setting_preview_validation_missing");
    }
    return context.refuse("commerce_setting_preview_unexpected", {
      path: [], hint: `Could not ${operation}.`,
    });
  }
}
