import { createHash, randomUUID } from "node:crypto";
import { canonicalCatalogDraftJson, catalogAcceptanceV2Schema } from "@openlup/platform/catalog";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { expect } from "vitest";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { PLATFORM_MIGRATION_MANIFEST, readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry, REVIEWED_FORWARD_PATH } from "../../scripts/reviewed-platform-forward.js";
import { createInventoryRunner, installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import type { QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { activation, allocate, defaultRule, utc } from "./nativeRenewalOccurrence.fixture.js";
import { call, seedRenewalStock, type Db } from "./subscriptionNativeFixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";

type OccurrenceCatalogue = Extract<PlatformMigrationManifest, { schemaVersion: 3 }>;
const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (current?.schemaVersion !== 3) throw new Error("Expected the three native migration plans");
export const occurrenceCatalogue = current;
export const read = "subscriptions__read_renewal_occurrence";
export const lock = "subscriptions__lock_renewal_occurrence";
export const writer = "subscriptions__create_renewal_v3_root";
export const writerParameters = "uuid,uuid,uuid,uuid,integer,text,text,text,integer";
const registry = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
export function occurrenceForwardPath(signature: string) {
  const slots = registry.nativeStoreForwardClass?.slots.filter(slot => slot.createdFunctions.some(fn => fn.signature === signature));
  if (slots?.length !== 1) throw new Error(`Expected one registered forward for ${signature}`);
  return slots[0]!.path;
}
export const writerPath = occurrenceForwardPath(`public.${writer}(${writerParameters})`);
export const plans = (manifest: OccurrenceCatalogue) => [manifest, manifest.qualified, manifest.qualifiedAdmin] as const;

export function sliceOccurrencePlan(manifest: OccurrenceCatalogue, path: string, include: boolean) {
  const copy = structuredClone(manifest);
  for (const plan of plans(copy)) {
    const index = plan.forward.findIndex(({ file }) => file === path);
    if (index < 0) throw new Error(`Missing renewal occurrence migration ${path}`);
    plan.forward = plan.forward.slice(0, index + Number(include));
  }
  return copy;
}
export const writerPlan = (manifest = occurrenceCatalogue) => sliceOccurrencePlan(manifest, writerPath, true);

export function measuredOccurrencePlan(plan: OccurrenceCatalogue, profile: AccountProfile, inventory: string) {
  if (!inventory) throw new Error("The sliced installation did not produce an object inventory");
  const measured = structuredClone(plan);
  switch (profile) {
    case "legacy": measured.objectInventorySha256 = inventory; break;
    case "bootstrap": measured.qualified.objectInventorySha256.bootstrapMigrator.withRestore = inventory; break;
    case "separate": measured.qualified.objectInventorySha256.separateMigrator.withRestore = inventory; break;
    case "admin-managed": measured.qualifiedAdmin.objectInventorySha256.installerManaged = inventory; break;
    case "admin-operator": measured.qualifiedAdmin.objectInventorySha256.operatorProvisioned = inventory; break;
  }
  return measured;
}
async function verifyMeasuredPrefix(root: string, plan: OccurrenceCatalogue, profile: AccountProfile, inventory: string,
  runner: AccountMutationsStore["runner"]) {
  writeFileSync(join(root, PLATFORM_MIGRATION_MANIFEST), JSON.stringify(measuredOccurrencePlan(plan, profile, inventory)));
  expect((await runner.status()).pending).toEqual([]);
}
type Profile = AccountProfile | "legacy-with-service";
export const installMeasuredAccountPrefix = (plan: OccurrenceCatalogue, variant: Profile, label: string) =>
  withPlatformCatalog(plan, async root => {
    const legacyServiceRole = variant === "legacy-with-service";
    const profile = legacyServiceRole ? "legacy" : variant;
    const store = await installAccountMutations(profile, true, label, root, root, { legacyServiceRole });
    try {
      await verifyMeasuredPrefix(root, plan, profile, store.inventory, store.runner);
      return store;
    } catch (error) { await store.close(); throw error; }
  });
export const applyMeasuredStarterPrefix = (plan: OccurrenceCatalogue, pool: Pool, installation: QualifiedPostgresInstallation, pending?: string[]) =>
  withPlatformCatalog(plan, async root => {
    let inventory = "";
    const runner = createInventoryRunner(pool.options.connectionString!, pool, installation, value => { inventory = value; }, root);
    if (pending) expect((await runner.status()).pending).toEqual(pending);
    try { await runner.apply(); }
    catch (error) {
      if (!inventory || !(error instanceof Error) || error.message !==
        "platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch") throw error;
    }
    await verifyMeasuredPrefix(root, plan, "bootstrap", inventory, runner);
  });
export const installOccurrenceStore = (profile: Profile, side = "source") =>
  installMeasuredAccountPrefix(writerPlan(), profile, `renewal-occurrence-${side}`);

export async function capturePristine(store: AccountMutationsStore) {
  const restricted = store.installation.generation === "qualified-admin";
  if (restricted) await store.migrator.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
  try { return await capture(store.migrator, store.inventory, "renewal-occurrence-pristine"); }
  finally { if (restricted) await store.migrator.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m"); }
}

export const occurrence = "subscription_cycle_occurrences";
export const operations = "subscription_renewal_operations";
export const generations = "subscription_cycle_generations";
export const original = "2004-03-01T12:00:00.123456Z";
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function paidRootFixture(db: Db, due = original) {
  const f = await activation(db, 7);
  const { cycle_number: cycleNumber, authorized } = (await db.query(`SELECT count(*)::int+1 AS cycle_number,
    to_char($2::timestamptz AT TIME ZONE 'UTC',${utc}) AS authorized
    FROM public.subscription_cycles WHERE subscription_id=$1 AND status='paid'`, [f.subscriptionId, f.paidAt])).rows[0];
  expect(cycleNumber).toBe(2);
  const { source: stockSourceKey, basket: lines } = await seedRenewalStock(db, 10, 2);
  const settlementChannelKey = "fixture-channel", authorizationRef = "fixture-mandate", currency = "XXX";
  await db.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [f.subscriptionId, due]);
  await insert(db, "subscription_renewal_terms", { subscription_id: f.subscriptionId, next_cycle_number: cycleNumber,
    currency_code: currency, stock_source_key: stockSourceKey, settlement_channel_key: settlementChannelKey,
    unattended_charge_authorized_at: authorized, authorization_ref: authorizationRef });
  return { ...f, cycleNumber: Number(cycleNumber), authorized: String(authorized), stockSourceKey, settlementChannelKey, authorizationRef, currency, lines };
}
const allocationState = (db: Db, cycleKey: string) => db.query(`SELECT is_current,operation_id,commercial_generation_id,
  cancellation_receipt_id,cancellation_effective_at,to_char(original_anchor_at AT TIME ZONE 'UTC',${utc}) AS anchor,
  to_char(effective_due_at AT TIME ZONE 'UTC',${utc}) AS due FROM public.${occurrence} WHERE cycle_key=$1`, [cycleKey]);
async function committedAllocation(owner: Pool, f: Awaited<ReturnType<typeof paidRootFixture>>, rail: string) {
  const allocation = await transaction(owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect((await db.query(`SELECT cycle_key FROM public.${occurrence} WHERE subscription_id=$1`, [f.subscriptionId])).rows).toEqual([]);
    const result = await allocate(db, f, rail, { ...defaultRule, leadSeconds: 0 });
    expect(result.outcome).toBe("created");
    expect((await allocationState(owner, result.cycleKey)).rows).toEqual([]);
    return { cycleKey: String(result.cycleKey), originalAnchorAt: String(result.originalAnchorAt) };
  });
  expect((await allocationState(owner, allocation.cycleKey)).rows).toEqual([{ is_current: true, operation_id: null, commercial_generation_id: null,
    cancellation_receipt_id: null, cancellation_effective_at: null, anchor: allocation.originalAnchorAt, due: allocation.originalAnchorAt }]);
  return allocation;
}

export async function rootFixture(owner: Pool, rail = "v3", due = original,
  prepare?: (db: Pool, f: Awaited<ReturnType<typeof paidRootFixture>>) => Promise<unknown>) {
  const f = await paidRootFixture(owner, due);
  await prepare?.(owner, f);
  const { cycleKey, originalAnchorAt } = await committedAllocation(owner, f, rail);
  const operationId = randomUUID();
  const cycle = { status: "correlated", logicalCycleNumber: 2, nativeRenewalCounter: f.cycleNumber,
    activationCycleId: f.cycleId, evidenceRef: "fixture:paid-activation" };
  const digest = sha256(cycleKey), priceEvidenceRef = `price.v1:${digest}`;
  const lines = f.lines.map(({ lineOrdinal, sku, quantity, unitAmountMinor }) => ({
    lineKey: `line:${lineOrdinal}`, sourceOrdinal: lineOrdinal, sku, quantity, unitBasisMinor: unitAmountMinor,
    taxClassKey: "merchandise", assignmentRef: "fixture:merchandise-class:1",
  }));
  const roster = await Promise.all(lines.map(async line => {
    const { rows: [sku] } = await owner.query<{ id: string; product_id: string }>(
      "SELECT id, product_id FROM public.catalog_skus WHERE sku=$1", [line.sku]);
    if (!sku) throw new Error("The synthetic catalogue roster requires a seeded SKU");
    const publicationHead = { publicationId: randomUUID(), revision: 1, documentDigest: digest };
    return { line, productId: sku.product_id, accepted: {
      schemaVersion: 2 as const, skuId: sku.id, skuCode: line.sku, skuRevisionId: randomUUID(), publicationHead,
      typeRef: { key: "fixture:article", version: 1 }, definitionDigest: digest, optionDigest: digest,
      netContent: { dimension: "count" as const, unscaled: "1", scale: 0, unit: "openlup:piece" },
    } };
  }));
  const catalogAcceptance = catalogAcceptanceV2Schema.parse({
    schemaVersion: 2, lines: roster.map(({ accepted }) => accepted),
    admission: {
      quoteRef: `fixture:accepted-quote:${cycleKey}`, quoteDigest: digest, moneyVersion: "v0",
      priceEvidenceRef, policyEvidenceRef: `policy.v1:${digest}`,
      consultedHeads: roster.map(({ productId, accepted }) => ({ productId, ...accepted.publicationHead }))
        .sort((a, b) => a.productId < b.productId ? -1 : 1),
      lineBindings: roster.map(({ line, accepted }) => ({
        source: "retained", mode: "subscription", role: "core", lineKey: line.lineKey, sourceOrdinal: line.sourceOrdinal,
        skuId: accepted.skuId, skuCode: accepted.skuCode, skuRevisionId: accepted.skuRevisionId, quantity: line.quantity,
      })),
    },
  });
  const agreement = {
    frozenRevision: "native.purchase-renewal.v3", contractVersion: "platform.subscription.renewal.v3",
    clientId: f.clientId, subscriptionId: f.subscriptionId, cycleKey, originalAnchorAt,
    operationId, commercialGenerationId: operationId, cadence: { schemaVersion: 1, kind: "fixed_days", days: 7 }, cycleNumber: f.cycleNumber,
    cycle, templateSnapshot: { version: 1, templateId: "fixture-template", cadenceDays: 7 },
    catalogAcceptance, lines,
    terms: { version: "native.renewal-terms.v3", currency: f.currency, amountBasis: "gross_fixed",
      priceListRef: "fixture:list:1", priceEvidenceRef, priceContextDigest: digest, classMapRevision: "fixture:classes:1" },
    discountTerms: { kind: "none", evidenceRef: priceEvidenceRef },
    acquisitionEvidenceRef: cycle.evidenceRef,
    shippingTerms: { version: "shipping-threshold.v1", currency: f.currency, flatMinor: 15, freeThresholdMinor: 500,
      assignmentRef: "fixture:shipping-class:1", taxClassKey: "shipping" },
    handlingTerms: { currency: f.currency, flatMinor: 5, separatelyStated: true, assignmentRef: "fixture:handling-class:1", taxClassKey: "handling" },
    destinationSelectionPolicy: { kind: "current_validated", policyRevision: "fixture:destination-policy:1",
      deliverySelectionRef: "fixture:delivery:1", providerRef: "fixture:delivery-provider", carrierRef: "fixture:carrier",
      serviceRef: "fixture:service", servicePolicyRevision: "1", adapterRevision: "1" },
    unattendedChargeAuthorizedAt: f.authorized,
    stockSourceKey: f.stockSourceKey, settlementChannelKey: f.settlementChannelKey,
    payerAccountRef: null, authorizationRef: f.authorizationRef,
  };
  return { ...f, cycleKey, originalAnchorAt, agreement, scope: [f.clientId, f.subscriptionId, cycleKey] };
}

export { canonicalCatalogDraftJson as canonical };
export type RootFixture = Awaited<ReturnType<typeof rootFixture>>;
export function args(f: RootFixture, agreement: unknown = f.agreement, lease = 30): (string | number | null)[] {
  const bytes = canonicalCatalogDraftJson(agreement);
  return [...f.scope, f.agreement.operationId, f.cycleNumber, bytes, sha256(bytes), "fixture", lease];
}

export async function incumbentRoot(db: Db, f: RootFixture) {
  const { clientId, subscriptionId, currency, cycleNumber, originalAnchorAt: scheduledAt, lines } = f;
  const snapshot = { contractVersion: "platform.subscription.renewal.v1", clientId, subscriptionId, scheduledAt,
    currency, cycleNumber, lines, totalAmountMinor: lines.reduce((total, line) => total + line.quantity * line.unitAmountMinor, 0) };
  const fingerprint = sha256(canonicalCatalogDraftJson(snapshot));
  const identity = await call(db, "subscription_renewal_identity", [subscriptionId, scheduledAt]);
  const { operationId, claimToken } = await call(db, "subscription_claim_due_renewal", [identity, fingerprint, snapshot, "fixture", 30, scheduledAt]);
  return { operationId, claimToken, snapshot, fingerprint };
}
