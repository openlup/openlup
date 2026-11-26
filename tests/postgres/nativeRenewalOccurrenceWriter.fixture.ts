import { createHash, randomUUID } from "node:crypto";
import { catalogAcceptanceV2Schema } from "@openlup/platform/catalog";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect } from "vitest";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { activation, allocate, defaultRule, utc } from "./nativeRenewalOccurrence.fixture.js";
import { call, seedRenewalStock, type Db } from "./subscriptionNativeFixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";

type OccurrenceCatalogue = Extract<PlatformMigrationManifest, { schemaVersion: 3 }>;
const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (current?.schemaVersion !== 3) throw new Error("Expected the three native migration plans");
export const occurrenceCatalogue = current;
export const writerPath = current.forward.find(({ file }) => file.endsWith("_native_renewal_occurrence_writer.sql"))?.file;
if (!writerPath) throw new Error("Missing renewal occurrence writer migration");
const writerPins = { legacy: "ac30b127bf781b831e3824914f0af93a5b794676c2679b3461d756c11c53b26d", bootstrap: "3a86da7673504399856c973891d37354010956b739d15b3d081f038beb7dd709", separate: "41f552f08c6b77dfd9cbebea8f448b59f77c10279cd6a27b4216f64762a7ca4f",
    admin: "dd94e2db90c404bfdeded9507797867dc463c077f7db2fcaae3cbd6aca46a776", operator: "e0ffd16240231615335d4da69d23c5ed2a881687a98a61f90aa45c2cfcd99213" };
export function pinOccurrencePlan(manifest: OccurrenceCatalogue, path: string, inventory: typeof writerPins, include: boolean) {
  const plan = structuredClone(manifest);
  for (const profile of [plan, plan.qualified, plan.qualifiedAdmin]) {
    const index = profile.forward.findIndex(({ file }) => file === path);
    if (index < 0) throw new Error(`Missing renewal occurrence migration ${path}`);
    profile.forward = profile.forward.slice(0, include ? index + 1 : index);
  }
  plan.objectInventorySha256 = inventory.legacy;
  plan.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: inventory.bootstrap },
    separateMigrator: { withRestore: inventory.separate } };
  plan.qualifiedAdmin.objectInventorySha256 = { installerManaged: inventory.admin, operatorProvisioned: inventory.operator };
  return plan;
}

export const writerPlan = (manifest = occurrenceCatalogue) => pinOccurrencePlan(manifest, writerPath!, writerPins, true);

export type Profile = AccountProfile | "legacy-with-service";

type Store = Pick<AccountMutationsStore, "owner" | "migrator" | "runtime" | "installation" | "inventory" | "close">;
export async function installOccurrenceStore(profile: Profile, side = "source"): Promise<Store> {
  const manifest = writerPlan();
  if (profile !== "legacy-with-service") return withPlatformCatalog(manifest, root =>
    installAccountMutations(profile, false, `renewal-occurrence-${side}`, root));
  const container = await runPostgresContainer({ name: `renewal-occurrence-service-${process.pid}`, password: "synthetic-occurrence" });
  const owner = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    for (const entry of [manifest.baseline, ...manifest.forward]) await owner.query(readFileSync(entry.file, "utf8"));
    return { owner, migrator: owner, runtime: owner, installation: { generation: "legacy" },
      inventory: manifest.objectInventorySha256, close: () => closePostgres(container, [owner]) };
  } catch (error) {
    await closePostgres(container, [owner]);
    throw error;
  }
}

export async function capturePristine(store: Store) {
  const restricted = store.installation.generation === "qualified-admin";
  if (restricted) await store.migrator.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
  try {
    return await capture(store.migrator, store.inventory, "renewal-occurrence-pristine");
  } finally {
    if (restricted) await store.migrator.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m");
  }
}

export const read = "subscriptions__read_renewal_occurrence";
export const lock = "subscriptions__lock_renewal_occurrence";
export const writer = "subscriptions__create_renewal_v3_root";
export const writerParameters = "uuid,uuid,uuid,uuid,integer,text,text,text,integer";
export const occurrence = "subscription_cycle_occurrences";
export const operations = "subscription_renewal_operations";
export const generations = "subscription_cycle_generations";
export const original = "2004-03-01T12:00:00.123456Z";
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function paidRootFixture(db: Db, due = original) {
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

export async function committedAllocation(owner: Pool, f: Awaited<ReturnType<typeof paidRootFixture>>, rail = "v3") {
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
  prepare: (db: Pool, f: Awaited<ReturnType<typeof paidRootFixture>>) => Promise<unknown> = async () => {}) {
  const f = await paidRootFixture(owner, due);
  await prepare(owner, f);
  const { cycleKey, originalAnchorAt } = await committedAllocation(owner, f, rail);
  const operation = randomUUID();
  const cycle = { status: "correlated", logicalCycleNumber: 2, nativeRenewalCounter: f.cycleNumber,
    activationCycleId: f.cycleId, evidenceRef: "fixture:paid-activation" };
  const { currency } = f;
  const db = owner;
  const digest = sha256(cycleKey), priceEvidenceRef = `price.v1:${digest}`;
  const lines = f.lines.map(({ lineOrdinal, sku, quantity, unitAmountMinor }) => ({
    lineKey: `line:${lineOrdinal}`, sourceOrdinal: lineOrdinal, sku, quantity, unitBasisMinor: unitAmountMinor,
    taxClassKey: "merchandise", assignmentRef: "fixture:merchandise-class:1",
  }));
  const roster = await Promise.all(lines.map(async line => {
    const { rows: [sku] } = await db.query<{ id: string; product_id: string }>(
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
    operationId: operation, commercialGenerationId: operation, cadence: { schemaVersion: 1, kind: "fixed_days", days: 7 }, cycleNumber: f.cycleNumber,
    cycle, templateSnapshot: { version: 1, templateId: "fixture-template", cadenceDays: 7 },
    catalogAcceptance, lines,
    terms: { version: "native.renewal-terms.v3", currency, amountBasis: "gross_fixed",
      priceListRef: "fixture:list:1", priceEvidenceRef, priceContextDigest: digest, classMapRevision: "fixture:classes:1" },
    discountTerms: { kind: "none", evidenceRef: priceEvidenceRef },
    acquisitionEvidenceRef: cycle.evidenceRef,
    shippingTerms: { version: "shipping-threshold.v1", currency, flatMinor: 15, freeThresholdMinor: 500,
      assignmentRef: "fixture:shipping-class:1", taxClassKey: "shipping" },
    handlingTerms: { currency, flatMinor: 5, separatelyStated: true, assignmentRef: "fixture:handling-class:1", taxClassKey: "handling" },
    destinationSelectionPolicy: { kind: "current_validated", policyRevision: "fixture:destination-policy:1",
      deliverySelectionRef: "fixture:delivery:1", providerRef: "fixture:delivery-provider", carrierRef: "fixture:carrier",
      serviceRef: "fixture:service", servicePolicyRevision: "1", adapterRevision: "1" },
    unattendedChargeAuthorizedAt: f.authorized,
    stockSourceKey: f.stockSourceKey, settlementChannelKey: f.settlementChannelKey,
    payerAccountRef: null, authorizationRef: f.authorizationRef,
  };
  return { ...f, cycleKey, originalAnchorAt, agreement, scope: [f.clientId, f.subscriptionId, cycleKey] };
}

export const canonical = (agreement: unknown) => JSON.stringify(agreement, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
  });

export type RootFixture = Awaited<ReturnType<typeof rootFixture>>;
export function args(f: RootFixture, agreement: unknown = f.agreement, lease = 30): (string | number | null)[] {
  const bytes = canonical(agreement);
  return [...f.scope, f.agreement.operationId, f.cycleNumber, bytes, sha256(bytes), "fixture", lease];
}

export async function incumbentRoot(db: Db, f: RootFixture) {
  const { clientId, subscriptionId, currency, cycleNumber, originalAnchorAt: scheduledAt, lines } = f;
  const snapshot = { contractVersion: "platform.subscription.renewal.v1", clientId, subscriptionId, scheduledAt,
    currency, cycleNumber, lines, totalAmountMinor: lines.reduce((total, line) => total + line.quantity * line.unitAmountMinor, 0) };
  const fingerprint = sha256(canonical(snapshot));
  const identity = await call(db, "subscription_renewal_identity", [subscriptionId, scheduledAt]);
  const { operationId, claimToken } = await call(db, "subscription_claim_due_renewal", [identity, fingerprint, snapshot, "fixture", 30, scheduledAt]);
  return { operationId, claimToken, snapshot, fingerprint };
}
