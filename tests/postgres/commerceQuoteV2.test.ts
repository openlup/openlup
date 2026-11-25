import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from "vitest";
import { canonicalCatalogDraftJson, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV3,
  createPostgresCatalogPublicationCommands, installCatalogDefinitions, withCatalogPublicationRules, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog";
import { bindCommerceMoneyLimitsV2Reader, createDbBackedCommerceQuotePortV2, installCommerceMoneyLimitsV2, readPublishedSkuTaxAssignments } from "@openlup/platform/commerce/server";
import type { CommerceQuoteV2Request, DbBackedCommerceQuotePortV2Deps, QuoteOutcome } from "@openlup/platform/commerce/server";
import { createPostgresNativeCheckoutPersistence, type NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { createPostgresDestinationPortV2 } from "@openlup/platform/commerce/server/destinations";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresPrivacyStore } from "@openlup/platform/identity";
import { readSettlementProfile } from "@openlup/platform/market-packs";
import { commerceQuoteV2Schema, createDbBackedCommerceQuotePort as createIncumbentQuotePort, quoteDigest } from "@openlup/platform/pricing";
import { applyTaxCoverageRevision, evaluationDigest, localRateTable, verifyTaxQuoteResult } from "@openlup/platform/tax";
import type { TaxCalculationTransactionLane, TaxCoverageRevision } from "@openlup/platform/tax";
import type { TaxQuoteInputV1, TaxQuoteRequestV1, TaxQuoteResultV1 } from "@openlup/platform/tax/contracts";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { beginSql, claim, completeSql, contaminate, exclusiveKind, fixture as storageFixture, mutate, rejected, seal, terminalCases } from "./commerceQuoteV2StorageFixture.js";
import { destinationContext, destinationHash, reachDestinationCutoff, snapshotCommand, snapshotPreimage, testServicePin } from "./destinationDocumentFixture.js";

type Deps = DbBackedCommerceQuotePortV2Deps;
type Bindings = Omit<Deps, "readLimits"> & { runtime: JourneyInstallation["runtime"] };
type Facts = Awaited<ReturnType<Deps["readPlan"]>>;
type Binding = Parameters<Deps["destination"]["read"]>[3];
type Contact = Parameters<Deps["destination"]["snapshot"]>[1]["original"]["contact"];
type Failure = Extract<TaxQuoteResultV1, { kind: "refused" | "unavailable" }>;
type Timing = "lookup" | "dependencies" | "claim" | "claimAck" | "adapter" | "seal" | "sealAck" | "recoveryRead";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("native-quotes"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const currency = "XXX";
const providerDigest = "b".repeat(64);
const jurisdiction = "district-a";
const market = "market-a";
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();
const recipePath = new URL("../../packages/core/docs/guide/how-to/build/quote-prices.md", import.meta.url);
const recipeCode = readFileSync(recipePath, "utf8").split("## Compose native quotes on the server")[1]!.split("```js\n")[1]!.split("```")[0]!;
const recipe = await import(/* @vite-ignore */ "data:text/javascript," + encodeURIComponent(
  recipeCode.replace("@openlup/platform/commerce/server", import.meta.resolve("@openlup/platform/commerce/server")),
)) as {
  bindNativeQuotes(bindings: Bindings): ReturnType<typeof createDbBackedCommerceQuotePortV2>;
  withPublishedTaxClasses(runtime: PgQueryExecutor, readFacts: (...args: Parameters<Deps["readPlan"]>) =>
    Promise<{ facts: Facts; skuIdsByCode: ReadonlyMap<string, string> }>): Deps["readPlan"];
};

function exact(actual: unknown, expected: object) {
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Reflect.ownKeys(actual as object).filter(key => key !== "stack").sort()).toStrictEqual(Reflect.ownKeys(expected).sort());
  expect((actual as { message?: unknown }).message).toBeUndefined();
  expect(actual).toStrictEqual(expected);
}
const refusal = (code: string, field: string, remedy: string) => ({ kind: "refused", code, field, remedy });
const contactRefusal = refusal("destination_contact_incomplete", "/destination/contact",
  "Collect the recipient name and phone, then issue a new destination snapshot.");
const stale = refusal("destination_version_changed", "/destination/snapshotRef", "Select the destination again and obtain a fresh quote.");
const expired = refusal("tax_calculation_expired", "/taxEvidence/expiresAt", stale.remedy);
const pending = refusal("tax_claim_pending", "/claim", "Read the original evaluation outcome.");
const history = refusal("tax_reference_conflict", "/coverage", "Recover the verified original history through its owner.");

function quote(result: QuoteOutcome) {
  if (result.kind !== "quoted") throw new Error(JSON.stringify(result));
  expect(commerceQuoteV2Schema.safeParse(result.quote).success).toBe(true);
  return result.quote;
}

async function editOwner(table: "tax_calculations" | "tax_coverage_revisions", columns: string, args: unknown[]) {
  const trigger = table === "tax_calculations" ? "tax_calculation_guard" : "tax_coverage_revision_immutable";
  const conn = await store.owner.connect();
  try {
    await conn.query("BEGIN");
    await conn.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
    await conn.query(`UPDATE public.${table} SET ${columns}`, args);
    await conn.query(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`);
    await conn.query("COMMIT");
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  } finally { conn.release(); }
}

function hostPlan(basis: "inclusive" | "exclusive", shipping: number | null, units: number[], adjust = false): Facts["planInput"] {
  const lines = units.map((unitBasisMinor, index) => ({
    lineKey: "line-" + index, sku: "item-" + index, sourceOrdinal: index + 1, quantity: 1, mode: "one_time" as const,
    amountKind: basis === "inclusive" ? "gross" as const : "net" as const, unitBasisMinor,
    taxClassKey: "class-" + index, assignmentRef: "assignment-" + index,
  }));
  const baseline = { amountBasis: basis, deliverySelectionRef: testServicePin.deliverySelectionRef, feeLines: [],
    delivery: shipping === null ? [] : [{ bucketKey: "shipping", kind: "shipping" as const, taxClassKey: "ship-class",
      assignmentRef: "ship-assignment", carrierRef: testServicePin.carrierRef, serviceRef: testServicePin.serviceRef,
      cost: { ref: "carriage-a", currency, amountMinor: shipping }, separatelyStated: true, amountMinor: shipping }],
  };
  return { currency, listBasis: basis, engine: "promotion-engine.v1", lines, baseline,
    price: { priceListRef: "list-a", priceEvidenceRef: "price-a", priceContextDigest: providerDigest, classMapRevision: "classes-a" },
    ...(adjust ? { selected: { ...baseline, adjustments: [{ amountOffMinor: 1, adjustmentRef: "cent-off",
      evidenceRef: "offer-a", appliesTo: "order_total", target: { lineKeys: lines.map(line => line.lineKey) } }] } } : {}),
  };
}

async function installed(options: { basis?: "inclusive" | "exclusive"; shipping?: number | null; units?: number[];
  adjust?: boolean; purpose?: CommerceQuoteV2Request["purpose"]; coverage?: "absent" | "empty"; requiredEmpty?: boolean;
  vector?: 1660 | 1720 | 1745; range?: number; contact?: Contact; tolerance?: number; rate?: number; cutoff?: "short" | "long";
  adapterLifetime?: number; coverageDecision?: "out_of_scope" | "exempt" } = {}) {
  const native = await destinationContext(store.owner);
  const ctx = { ...native, owner: { ...native.owner, principalKind: "customer" as const } };
  const { installationRef, principalRef } = ctx.owner;
  const owner = { clientId: ctx.clientId, scopeRef: ctx.scopeRef, installationRef, principalRef };
  const accountRef = "tax-" + randomUUID();
  const scope = { adapter: "local", adapterVersion: "1", accountRef, mode: "test" as const };
  const declarationFrom = at(-120_000);
  const taxDate = at(-10_000);
  const effective = { from: declarationFrom };
  const declarations: TaxQuoteInputV1["coverage"]["declarations"][number][] = [{
    jurisdiction, taxKind: "sale", actorRef: "operator-a", recordedAt: declarationFrom, effective,
    ...(options.coverageDecision === "out_of_scope" ? { status: "not_registered_acknowledged", acknowledgementRef: "approved-a" } : { status: "registered" }),
  }];
  if (options.vector === 1745) declarations.push({ ...declarations[0], taxKind: "fee" });
  let coverage: TaxCoverageRevision | undefined;
  if (options.basis === "exclusive" && options.coverage !== "absent") {
    const installed = await applyTaxCoverageRevision(store.owner, { expectedHead: null, document: {
      installationRef, accountRef, actorRef: "operator-a",
      coverage: { schemaVersion: 1, accountRef, revision: "revision-a", declarations: options.coverage === "empty" ? [] : declarations },
    } });
    if (!("coverageDigest" in installed)) throw new Error(JSON.stringify(installed));
    coverage = installed;
  }
  const rail = { installationRef, channelKey: "online", methodKey: "card", providerKey: "processor-a",
    accountRef: "payments-" + randomUUID(), mode: "test" as const, currency };
  const terms = { schemaVersion: 2 as const, active: true, profileRef: "standard", minMinor: 0, maxMinor: 3_000_000_000, ...rail };
  expect(await installCommerceMoneyLimitsV2(store.owner, { value: terms, expectedRevision: null })).toHaveProperty("kind", "installed");
  const basis = options.basis ?? "inclusive";
  const shipping = options.shipping === undefined ? (options.vector ? 100 : null) : options.shipping;
  const units = options.units ?? (options.vector ? [1000, 500] : [3, 3]);
  const range = { minMinor: 0, maxMinor: 3_000_000_000 };
  const start = { planInput: hostPlan(basis, shipping, units, options.adjust),
    rail, service: { ...testServicePin }, catalogueEvidenceRef: "catalogue-a", taxDate, quoteCutoff: at(20 * 60_000),
    bounds: { rail: { ...range, maxMinor: options.range ?? range.maxMinor }, wire: range, order: range, intent: range, attempt: range, capture: range } };
  const now = {
    ...start, contact: options.contact ?? { recipientName: "Sample Recipient", contactPhone: "001000000000", contactEmail: "protected@example.invalid" },
    timing: undefined as Timing | undefined, pauseUntil: "", taxFailure: undefined as Failure | undefined,
    throwTax: false, onAdapter: undefined as (() => Promise<void>) | undefined, lateCoverage: undefined as TaxCoverageRevision | undefined,
    alterReply: undefined as ((output: TaxQuoteResultV1) => TaxQuoteResultV1) | undefined, fallbackRate: options.rate ?? 2300,
    qualified: true, claimFailure: undefined as Error | undefined,
  };
  const request: CommerceQuoteV2Request = { key: randomUUID(), purpose: options.purpose ?? "final",
    mode: "one_time", lines: units.map((_minor, index) => ({ sku: "item-" + index, quantity: 1 })), deliverySelector: "delivery-a", paymentSelector: "payment-a" };
  const taxInputs: TaxQuoteRequestV1[] = [];
  const commands: Array<{ operation: string; identity: { evaluationKey: string }; pin?: { composition: unknown } }> = [];
  const bindings = new Map<string, Binding>();
  const fresh = { plans: 0, snapshots: 0, coverage: 0 };
  const realLane = createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: store.runtimeUrl }, { pool: store.runtime });
  const pause = async (target: Timing) => {
    if (now.timing !== target) return;
    await store.owner.query("SELECT pg_sleep_until($1::timestamptz)", [now.pauseUntil]);
    const remaining = Date.parse(now.pauseUntil) - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 5));
  };
  const lane: TaxCalculationTransactionLane = { async run(work) {
    let operation = "";
    const result = await realLane.run(db => work({ async query(sql, args) {
      if (args) {
        const input = JSON.parse(String(args[0])) as typeof commands[number];
        operation = input.operation;
        commands.push(input);
        if (operation === "claim") await pause("claim");
        if (operation === "complete") await pause("seal");
      }
      return db.query(sql, args);
    } }));
    if (operation === "lookup") await pause("lookup");
    if (operation === "claim") {
      await pause("claimAck");
      if (now.claimFailure) throw now.claimFailure;
    }
    if (operation === "complete") await pause("sealAck");
    return result;
  } };
  const owned = createPostgresDestinationPortV2(store.runtime);
  const privacy = (enabled: boolean) => composeNativePrivacy({
    unitOfWork: { run: work => realLane.run(work) }, store: createPostgresPrivacyStore(),
  }, { installed: true, issuanceEnabled: enabled });
  const registry = privacy(true).registry;
  const adapter = localRateTable({ scope, now: at, market, currency, calculationLifetimeMs: options.adapterLifetime ?? 300_000, validityWindowMs: 2000,
    rounding: "half_up_largest_remainder", registrations: declarations.map(({ taxKind }) =>
      ({ state: options.coverageDecision === "out_of_scope" ? "inactive" : "active", effective, evidenceRef: "registration-a", jurisdiction, taxKind })),
    rules: [
      ...["class-0", "class-1", "ship-class"].map((taxClass, index) => ({
        jurisdiction, taxClass, taxKind: "sale", effective, ruleRef: "rule-a", legalBasisRef: "rules-a",
        ...(options.coverageDecision === "exempt" ? { kind: "exempt" as const, reason: "exempt-a" } :
          { kind: "rate" as const, ratePercent: (options.vector === 1660 ? ["0", "10", "10"] : ["8", "8", "0"])[index]! }),
      })),
      { jurisdiction, taxClass: "fee-class", taxKind: "fee", effective, kind: "fee", ruleRef: "fee-rule",
        legalBasisRef: "rules-a", amountMinor: 25, refundRule: { ref: "refund-a", revision: "refund-revision" } } ],
  });
  const deps: Bindings = { runtime: store.runtime, lane, privacyRegistry: registry,
    destination: {
      async snapshot(...args) {
        fresh.snapshots++;
        const result = await owned.snapshot(...args);
        if ("binding" in result) bindings.set(args[1].requestKey, result.binding);
        return result;
      },
      read: new Proxy(owned.read, {
        async apply(read, _receiver, args) {
          const result = await Reflect.apply(read, owned, args);
          await pause("recoveryRead");
          return result;
        },
      }),
    },
    async snapshotCommand(_owner, input) {
      const { command } = snapshotCommand(ctx, "snapshot-" + input.key);
      const withContact = { ...command, original: { ...command.original, contact: now.contact },
        validated: { ...command.validated, contact: now.contact } };
      return { ...withContact, requestDigest: destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, withContact))) };
    },
    async readPlan() {
      fresh.plans++;
      await pause("dependencies");
      return { planInput: now.planInput, rail: now.rail, service: now.service, catalogueEvidenceRef: now.catalogueEvidenceRef,
        taxDate: now.taxDate, quoteCutoff: now.quoteCutoff, bounds: now.bounds };
    },
    clockToleranceMs: options.tolerance ?? 0,
    async readFiscal() {
      const { country, category, vatRateBps, legalBasis } = readSettlementProfile({}, {
        defaultCurrency: currency, regionCode: "XA",
        fiscalProfile: { included: true, country: "XA", category: "standard", vatRateBps: now.fallbackRate, legalBasis: "rules-a" },
      }).fiscalProfile;
      return { facts: { country, category, vatRateBps, legalBasis }, coordinates: { installationRef, marketRef: market, packId: "pack-a", packVersion: "1" } };
    },
    exclusive: { recovery: providerDigest, scope, isDefinitive: () => now.qualified,
      async readCoverage(_installation, _account) {
        fresh.coverage++;
        if (now.lateCoverage) return now.lateCoverage;
        if (!coverage) return null;
        const { rows } = await store.runtime.query<{ coverage: TaxCoverageRevision["coverage"]; coverage_digest: string }>(
          "SELECT coverage, coverage_digest FROM public.tax_coverage_read_v1($1,$2) ORDER BY sequence_no DESC LIMIT 1", [installationRef, accountRef]);
        return rows.length ? { ...coverage, coverage: rows[0].coverage, coverageDigest: rows[0].coverage_digest } : null;
      },
      async readTaxFacts(_context, plan) {
        const cell = { jurisdiction, taxKind: "sale", level: "district", sourcing: "destination" } as const;
        const required: TaxQuoteInputV1["required"] = options.requiredEmpty ? [] : [
          ...plan.lines.map(line => ({ ...cell, target: { kind: "line" as const, key: line.lineKey } })),
          ...plan.winner.delivery.map(bucket => ({ ...cell, target: { kind: "delivery" as const, key: bucket.bucketKey } })),
          ...(options.vector === 1745 ? [{ ...cell, taxKind: "fee", target: { kind: "fee" as const, key: "fee-a",
            deliveryKey: "shipping", taxClass: "fee-class", assignmentRef: "fee-assignment" } }] : []),
        ];
        return { market, shipFromRef: "origin-a", policyRevision: "policy-1", required };
      },
      adapter: { ...adapter, async quote(input) {
        taxInputs.push(structuredClone(input));
        await now.onAdapter?.();
        if (now.taxFailure) return now.taxFailure;
        const output = await adapter.quote(input);
        if (now.throwTax) {
          expect(output.kind).toMatch(/^(?:final|estimate)$/u);
          throw new Error("Scripted lost acknowledgment");
        }
        await pause("adapter");
        return now.alterReply?.(output) ?? output;
      } },
    },
  };
  if (options.cutoff === "short") now.quoteCutoff = at(2200);
  return { ctx, owner, request, bind: () => recipe.bindNativeQuotes(deps), deps, now, commands, taxInputs, bindings, fresh, privacy, coverage, terms };
}

type Installed = Awaited<ReturnType<typeof installed>>;
const row = async (fixture: Installed, key = fixture.request.key) => (await store.owner.query(
  "SELECT calculation_id, generation, state, outcome_text, pin, contradiction FROM public.tax_calculations WHERE identity->>'evaluationKey'=$1",
  [key])).rows[0];
const takeover = (fixture: Installed) => editOwner("tax_calculations",
  "lease_until=clock_timestamp()-interval '1 second' WHERE identity->>'evaluationKey'=$1", [fixture.request.key]);
const noDispatch = { kind: "unavailable", code: "tax_adapter_unavailable", effect: "unknown" } as const;

const detach = (source: string, url: URL) => "data:text/javascript," + encodeURIComponent(
  source.replace(/(from ["'])([^"']+)/gu, (_match, prefix: string, specifier: string) =>
    prefix + (specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))),
);

async function detachedQuotePort(f: Installed, implementation: string) {
  const entry = new URL(import.meta.resolve("@openlup/platform/commerce/server"));
  const lazyImport = 'import("./dbBackedCommerceQuotePortV2.js")';
  const source = readFileSync(entry, "utf8");
  expect(source).toContain(lazyImport);
  const detached = detach(source.replace(lazyImport, `import(${JSON.stringify(implementation)})`), entry);
  const { createDbBackedCommerceQuotePortV2: factory } = await import(
    /* @vite-ignore */ detached,
  ) as { createDbBackedCommerceQuotePortV2: typeof createDbBackedCommerceQuotePortV2 };
  return factory({ ...f.deps, readLimits: rail => bindCommerceMoneyLimitsV2Reader(f.deps.runtime, rail)() });
}

async function mutant(f: Installed, before: string, after: string) {
  const module = new URL("dbBackedCommerceQuotePortV2.js", import.meta.resolve("@openlup/platform/commerce/server"));
  const installed = readFileSync(module, "utf8");
  expect(installed).toContain(before);
  return detachedQuotePort(f, detach(installed.replace(before, after), module));
}

it.each(["final", "estimate"] as const)("executes the installed single-rate one-cent %s recipe", async purpose => {
  const f = await installed({ adjust: true, purpose, cutoff: "long" });
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  expect(q).toMatchObject({ status: purpose, netTotal: 4, taxTotal: 1, payableMinor: 5, amountBasis: "inclusive" });
  expect(q.lines[0].discountAllocations[0]).toMatchObject({ basisReductionMinor: 1, netReductionMinor: 0, taxReductionMinor: 1 });
  expect(q.lines[1].discountAllocations).toEqual([]);
  expect(f.taxInputs).toHaveLength(0);
  const stored = await row(f);
  const [, frame] = JSON.parse(stored.outcome_text);
  expect(frame.evidence).toMatchObject({ calculationId: stored.calculation_id, coverage: { kind: "not_applicable" }, posting: "no_provider_posting" });
  expect(frame.evidence.policyRevision).toBe(evaluationDigest("fiscal-profile", [frame.evidence.facts, frame.evidence.coordinates]));
  expect(q.taxEvidence.expiresAt).toBe(f.now.quoteCutoff);
  expect(q.taxEvidence.calculationId).toBe(stored.calculation_id);
  expect(JSON.stringify(stored)).not.toContain("protected@example.invalid");
  expect(JSON.stringify(stored)).not.toContain("Sample Recipient");
  expect(JSON.stringify(stored)).not.toContain("line1");
  expect(await f.bind().createQuote(f.owner, f.request)).toStrictEqual({ kind: "quoted", quote: q, freshness: "current" });
  const equalKey = { ...f.request, key: randomUUID() };
  quote(await f.bind().createQuote(f.owner, equalKey));
  expect(JSON.parse((await row(f, equalKey.key)).outcome_text)[1].evidence.policyRevision).toBe(frame.evidence.policyRevision);
  const newKey = { ...f.request, key: randomUUID() };
  f.now.fallbackRate = 0;
  const changed = quote(await f.bind().createQuote(f.owner, newKey));
  expect(changed.payableMinor).toBe(q.payableMinor);
  expect(changed.moneyDigest).not.toBe(q.moneyDigest);
  expect(changed.quoteDigest).not.toBe(q.quoteDigest);
  expect(JSON.parse((await row(f, newKey.key)).outcome_text)[1].evidence.policyRevision).not.toBe(frame.evidence.policyRevision);
});

it.each([[1660, 60, 0], [1720, 120, 0], [1745, 120, 25]] as const)(
  "seals the %s exclusive vector against joined positions and fees", async (vector, taxTotal, feeTotal) => {
    const f = await installed({ basis: "exclusive", vector, purpose: feeTotal ? "estimate" : "final" });
    f.now.onAdapter = async () => {
      const db = await store.owner.connect();
      try {
        await db.query("BEGIN");
        await db.query("LOCK TABLE public.identity_privacy_erasures IN ACCESS EXCLUSIVE MODE NOWAIT");
        await db.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE NOWAIT", [f.owner.clientId]);
      } finally { await db.query("ROLLBACK"); db.release(); }
    };
    const q = quote(await f.bind().createQuote(f.owner, f.request));
    expect(q).toMatchObject({ netTotal: 1600, taxTotal, feeTotal, payableMinor: vector, amountBasis: "exclusive" });
    expect(q.deliveryBuckets[0]).toMatchObject({ separatelyStated: true, cost: { ref: "carriage-a", amountMinor: 100 } });
    expect(q.deliveryBuckets[0].parts).toHaveLength(1);
    expect(q.feeLines).toHaveLength(Number(feeTotal > 0));
    expect(f.taxInputs).toHaveLength(1);
    const [, terminal] = JSON.parse((await row(f)).outcome_text);
    expect(terminal.disposition).toBe("required");
    expect(q.taxEvidence.expiresAt).toBe(terminal.evidence.adapterEvidence.expiresAt);
  },
);

it.each([
  ["name", { contactPhone: "001000009900" }, 10],
  ["phone", { recipientName: "Unreturned Buyer" }, 10],
  ["name on free shipping", { contactPhone: "001000009900" }, 0],
  ["phone on free shipping", { recipientName: "Unreturned Buyer" }, 0],
  ["trimmed name", { recipientName: "\u00a0", contactPhone: "001000009900" }, 0],
] as const)("refuses missing %s before the first claim or tax call", async (_label, contact, shipping) => {
  const f = await installed({ basis: shipping === 0 ? "inclusive" : "exclusive", shipping, contact });
  exact(await f.bind().createQuote(f.owner, f.request), contactRefusal);
  expect(f.commands.map(command => command.operation)).toEqual(["lookup"]);
  expect(f.taxInputs).toEqual([]);
  expect(await row(f)).toBeUndefined();
  expect(f.fresh.snapshots).toBe(1);
  f.now.contact = { recipientName: "Unreturned Buyer", contactPhone: "001000009900" };
  const fresh = { ...f.request, key: randomUUID() };
  const q = quote(await f.bind().createQuote(f.owner, fresh));
  const publicAndPrivate = JSON.stringify([q, await row(f, fresh.key)]);
  expect(publicAndPrivate).not.toMatch(/Unreturned Buyer|001000009900|contactPhone|recipientName|line1/u);
});

it("allows a handling-only plan without contact and checks corrupt document evidence before contact", async () => {
  const f = await installed({ shipping: 10, contact: {}, units: [10] });
  const delivery = f.now.planInput.baseline.delivery.map(bucket => ({ ...bucket, kind: "handling" as const }));
  const initial = f.deps.destination.snapshot;
  f.deps.destination.snapshot = async (...args) => {
    const issued = await initial(...args);
    if ("binding" in issued) await store.owner.query(
      "UPDATE public.commerce_destination_v2_documents SET document_digest=$2 WHERE snapshot_ref=$1", [issued.binding.snapshotRef, "1".repeat(64)]);
    return issued;
  };
  exact(await f.bind().createQuote(f.owner, f.request),
    refusal("destination_digest_mismatch", "/destination/destinationDigest", "Replay the original document and its digest."));
  expect(f.commands.map(command => command.operation)).toEqual(["lookup"]);
  expect(f.taxInputs).toHaveLength(0);
  f.deps.destination.snapshot = initial;
  f.now.planInput = { ...f.now.planInput, baseline: { ...f.now.planInput.baseline, delivery } };
  const q = quote(await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }));
  expect(q.deliveryBuckets[0].kind).toBe("handling");
  expect(q.payableMinor).toBe(20);
});

it("stitches inclusive shipping components by original merchandise ordinal", async () => {
  const f = await installed({ shipping: 11, units: [20, 30], adjust: true });
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  expect(q.deliveryBuckets[0].parts.map(part => [part.sourceOrdinal, part.preDiscountMinor])).toEqual([[1, 4], [2, 7]]);
  expect(q.payableMinor).toBe(60);
  expect(f.taxInputs).toHaveLength(0);
});

it.each([[100, 100], [101, 100], [2_147_483_647, 2_147_483_647], [2_147_483_648, 2_147_483_647]])(
  "checks the verified payable %s against ceiling %s", async (payable, ceiling) => {
    const f = await installed({ units: [Math.min(payable, 2_147_483_647)], range: ceiling,
      shipping: payable > 2_147_483_647 ? 1 : null });
    const result = await f.bind().createQuote(f.owner, f.request);
    if (payable === ceiling) expect(quote(result).payableMinor).toBe(payable);
    else {
      exact(result, { ...refusal("money_amount_out_of_range", "/payableMinor", "Choose a supported amount and obtain a fresh quote."),
        amountAdvice: { currency, minMinor: 1, maxMinor: ceiling } });
      expect((await row(f)).state).toBe("pending");
    }
  },
);

it("checks installed activity, effective interval, B1-only tolerance, and the fallback rate", async () => {
  const f = await installed({ tolerance: 7800, rate: 10_001 });
  exact(await f.bind().createQuote(f.owner, f.request), refusal("tax_invalid_input", "/pin/composition/fiscal", "Supply the documented input."));
  expect(f.commands.map(command => command.operation)).toEqual(["lookup"]);
  f.now.fallbackRate = 10_000;
  f.now.quoteCutoff = at(28 * 60 * 60_000);
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  const { pin } = await row(f);
  expect(Date.parse(pin.composition.evidenceExpiresAt) - Date.parse(q.taxEvidence.expiresAt)).toBe(7800);
  expect(await installCommerceMoneyLimitsV2(store.owner, { value: { ...f.terms, active: false }, expectedRevision: 1 })).toHaveProperty("revision", 2);
  exact(await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }),
    refusal("money_limits_unavailable", "/paymentLimits", "Install or select a qualified payment limits tuple."));
  expect(await f.bind().createQuote(f.owner, f.request)).toMatchObject({ kind: "quoted", quote: q });
});

it.each(["absent", "empty", "required"] as const)("unifies %s installed coverage before claim", async what => {
  const f = await installed({ basis: "exclusive", ...(what === "required" ? { requiredEmpty: true } : { coverage: what }) });
  exact(await f.bind().createQuote(f.owner, f.request),
    refusal("tax_coverage_undeclared", "/coverage/declarations", "Have the coverage owner supply the required effective declarations under /coverage/declarations, then obtain a fresh quote."));
  expect(f.commands.map(command => command.operation)).toEqual(["lookup"]);
  expect(f.taxInputs).toHaveLength(0);
});

it("recovers the exact original bytes and key after live inputs change", async () => {
  const f = await installed({ basis: "exclusive", vector: 1745 });
  f.now.throwTax = true;
  await expect(f.bind().createQuote(f.owner, f.request)).rejects.toMatchObject({ code: "commerce_quote_v2_unavailable" });
  const original = await row(f);
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  expect(f.taxInputs).toHaveLength(1);
  await takeover(f);
  f.now.throwTax = false;
  f.now.planInput = hostPlan("inclusive", null, [1234, 4321]);
  f.now.rail = { ...f.now.rail, methodKey: "other" };
  f.now.service = { ...f.now.service, serviceRef: "other" };
  f.now.contact = {};
  f.now.catalogueEvidenceRef = "catalogue-b";
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  expect(q.payableMinor).toBe(1745);
  expect(canonicalCatalogDraftJson(f.taxInputs[1])).toBe(canonicalCatalogDraftJson(f.taxInputs[0]));
  expect(f.fresh).toEqual({ snapshots: 1, plans: 1, coverage: 1 });
  expect(await row(f)).toMatchObject({ calculation_id: original.calculation_id, generation: 2, state: "terminal" });
  expect(await f.bind().createQuote(f.owner, f.request)).toMatchObject({ kind: "quoted", quote: q });
  expect(f.taxInputs).toHaveLength(2);
});

it("forwards the stale snapshot before corrupt pinned history and only seals a fresh key after repair", async () => {
  const f = await installed({ basis: "exclusive", shipping: 10 });
  f.now.taxFailure = noDispatch;
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  await takeover(f);
  await editOwner("tax_coverage_revisions", "coverage_digest=$1 WHERE account_ref=$2", ["1".repeat(64), f.coverage!.accountRef]);
  f.now.taxFailure = undefined;
  exact(await f.bind().createQuote(f.owner, f.request), history);
  const old = f.bindings.get("snapshot-" + f.request.key)!;
  await reachDestinationCutoff(store.owner, old);
  f.taxInputs.length = 0;
  f.commands.length = 0;
  exact(await f.bind().createQuote(f.owner, f.request), stale);
  expect(f.taxInputs).toHaveLength(0);
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
  expect(await row(f)).toMatchObject({ state: "pending", generation: 1, outcome_text: null });
  // Temporarily disabled early stale-snapshot projection in the disposable database.
  await mutate(store, "public.tax_calculation_transition_v1(jsonb,boolean)",
    "IF owned->>'outcome' = 'refused' THEN",
    "IF owned->>'outcome' = 'refused' AND owned->>'code' <> 'destination_version_changed' THEN",
    async () => exact(await f.bind().createQuote(f.owner, f.request), history));
  expect(f.taxInputs).toHaveLength(0);
  await editOwner("tax_coverage_revisions", "coverage_digest=$1 WHERE account_ref=$2", [f.coverage!.coverageDigest, f.coverage!.accountRef]);
  const newRequest = { ...f.request, key: randomUUID() };
  const fresh = quote(await f.bind().createQuote(f.owner, newRequest));
  expect(fresh.destination.snapshotRef).not.toBe(old.snapshotRef);
  expect(f.taxInputs).toHaveLength(1);
  expect((await row(f, newRequest.key)).state).toBe("terminal");
  exact(await f.bind().createQuote(f.owner, f.request), stale);
  expect(f.taxInputs).toHaveLength(1);
  expect(await row(f)).toMatchObject({ state: "pending", outcome_text: null });
});

it.each([
  ["tax_scope_mismatch", "/calculation/livemode", "Have the tax adapter owner reconcile the calculation account, mode and sourcing with the authorized tax binding, then obtain a fresh quote."],
  ["tax_breakdown_incomplete", "/line_items/0/data/0/metadata", "Have the tax adapter owner resolve the incomplete calculation breakdown, then obtain a fresh quote."],
  ["tax_reference_conflict", "/inputDigest", "Have the tax adapter owner resolve the conflicting request or response binding, then obtain a fresh quote."],
  ["tax_calculation_unusable", "/evidence/coverage", "Have the tax coverage owner supply coverage supported by effective observations, then obtain a fresh quote."],
] as const)("persists %s and proves the owner repair and original-key replay", async (code, source, remedy) => {
  const f = await installed({ basis: "exclusive", vector: 1660 });
  f.now.taxFailure = { kind: "refused", code, field: source, remedy: "Discard this provider diagnostic and protected text." };
  const expected = refusal(code, "/taxEvidence", remedy);
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  expect(JSON.stringify(await row(f))).not.toContain("protected text");
  f.now.taxFailure = undefined;
  quote(await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }));
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  expect(f.taxInputs).toHaveLength(2);
});

it("forwards a local verifier refusal by value without sealing", async () => {
  const f = await installed({ basis: "exclusive", vector: 1745 });
  let broken: TaxQuoteResultV1 | undefined;
  f.now.alterReply = output => {
    if (output.kind !== "final") throw new Error("Expected final verified control");
    return broken = { ...output, evidenceDigest: "0".repeat(64) };
  };
  const result = await f.bind().createQuote(f.owner, f.request);
  const expected = verifyTaxQuoteResult(f.taxInputs[0], broken!);
  expect(expected).toBeDefined();
  exact(result, expected!);
  expect((await row(f)).state).toBe("pending");
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
});

it("preserves the owned contradiction marker and drops the adapter vector", async () => {
  const f = await installed({ basis: "exclusive" });
  f.now.taxFailure = { kind: "refused", code: "tax_coverage_inconsistent", field: "/observations/123",
    remedy: "discard", coverage: { digest: "3".repeat(64), vector: [] } };
  const expected = refusal("tax_coverage_inconsistent", "/observations", "Have the coverage owner reconcile registration, treatment and assessment for /observations, then obtain a fresh quote.");
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  const stored = await row(f);
  expect(stored).toMatchObject({ contradiction: true, state: "terminal" });
  expect(stored.outcome_text).not.toMatch(/discard|vector|observations\/123/u);
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  expect(await row(f)).toStrictEqual(stored);
});

it.each(["dependencies", "claim", "claimAck", "adapter", "seal", "sealAck", "lookup", "recoveryRead"] as const)(
  "fences independently delayed %s", async stage => {
    const f = await installed({ basis: "exclusive", cutoff: "short" });
    f.now.pauseUntil = f.now.quoteCutoff;
    if (stage === "lookup") quote(await f.bind().createQuote(f.owner, f.request));
    if (stage === "recoveryRead") {
      f.now.taxFailure = noDispatch;
      exact(await f.bind().createQuote(f.owner, f.request), pending);
      await takeover(f);
      f.now.taxFailure = undefined;
    }
    f.now.timing = stage;
    const result = await f.bind().createQuote(f.owner, f.request);
    if (stage === "sealAck" || stage === "lookup") {
      expect(result).toMatchObject({ kind: "quoted", freshness: "historical" });
      expect((await row(f)).state).toBe("terminal");
    } else {
      exact(result, expired);
      expect((await row(f))?.outcome_text ?? null).toBeNull();
    }
    expect(f.taxInputs).toHaveLength(["seal", "sealAck", "lookup", "adapter", "recoveryRead"].includes(stage) ? 1 : 0);
  }, 12_000,
);

it("does not dispatch after an ambiguous claim commit", async () => {
  const f = await installed({ basis: "exclusive" });
  f.now.claimFailure = new Error("Scripted lost commit acknowledgment");
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim", "lookup"]);
  expect(f.taxInputs).toHaveLength(0);
  expect((await row(f)).state).toBe("pending");
});

it("uses the native privacy registry even with issuance rolled back", async () => {
  const f = await installed();
  const rollback = f.privacy(false);
  expect(rollback.destination.destinationAddressV2.available).toBe(false);
  expect(rollback.registry.contributors.map(contributor => contributor.id)).toContain("tax-calculations");
  expect(createDbBackedCommerceQuotePortV2({ ...f.deps, privacyRegistry: rollback.registry, readLimits: async () => ({ present: false }) })).toHaveProperty("createQuote");
  const fake = { contributors: rollback.registry.contributors.filter(contributor => contributor.id !== "tax-calculations"), missingContributors: [] };
  const failure = vi.fn(() => recipe.bindNativeQuotes({ ...f.deps, privacyRegistry: fake }));
  let error: unknown;
  try { failure(); } catch (value) { error = value; }
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(["code", "message", "remedy"]);
  expect(error).toMatchObject({ message: "OPENLUP_E_COMMERCE_QUOTE_V2_PRIVACY", code: "OPENLUP_E_COMMERCE_QUOTE_V2_PRIVACY" });
  expect(f.commands).toEqual([]);
});

it("keeps the original storage arms readable through the evaluation owner", async () => {
  const data = await storageFixture(store);
  const { pin } = data.begin("fiscal_profile", false);
  expect(pin.composition).toBeUndefined();
  expect(await store.runtime.query("SELECT has_table_privilege(current_user, 'public.tax_calculations', 'INSERT,UPDATE,DELETE') AS direct")
    .then(result => result.rows[0].direct)).toBe(false);
});

it("preserves the default quote response bytes on the unchanged incumbent entry", async () => {
  const now = "2026-06-05T10:00:00.000Z";
  const taxProfile = { included: true as const, country: "XA", category: "standard", vatRateBps: 2300, legalBasis: "rules-a" };
  const port = createIncumbentQuotePort({
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ skuId: "sku-a", skuCode: "item-a", variantId: "variant-a",
      productSlug: "item-a", netWeightG: 100, isAddon: false, sellability: { oneTime: true, subscription: true },
      documentRevision: { id: null, digest: null } }] },
    isStrictD1Quote: false, taxProfile, supportedTaxProfiles: [taxProfile], regionCode: "XA", currency, now: () => now,
    pricingResolverPort: { async resolvePrice({ variantId, mode }) {
      return { variantId, mode, amountKind: "gross", unitPriceMinor: 123, matchedMinQty: 1,
        priceListId: "list-a", priceEntryId: "entry-a", resolvedAt: now };
    } },
    hasPromotionCodePort: false, lineContext: () => ({}),
    quoteContext: request => () => ({ mode: request.mode, cadenceDays: null, usageCoverageDays: null, promoCodes: [], subjectId: null }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }),
  });
  const incumbent = await port.createQuote({ mode: "one_time", lines: [{ sku: "item-a", quantity: 1 }], promoCodes: [] });
  expect(quoteDigest("catalog.owner-quote.v0", JSON.parse(JSON.stringify(incumbent))))
    .toBe("ad10a6200f158b3f4232b686b0329a4c914010c124a770368f3aca2b172afae1");
});

const projectedSource = [
  "", "/input/coverage/declarations", "/input/required", "/now", "/market", "/input/money/amountBasis",
  "/input/coverage/accountRef", "/registrations/0/account",
  "/input/lines/12/taxClass", "/input/delivery/34/taxClass", "/input/required/56/target/taxClass",
  "/input/required/12", "/input/policyRevision", "/input/classMapRevision", "/input/shipFromRef/subdivisionCode",
  "/input/destination/address/subdivisionCode", "/calculation/tax_breakdown/0/tax_rate_details",
  "/calculation/shipping_cost/tax_breakdown/0/jurisdiction", "/line_items/0/tax_breakdown/0/jurisdiction",
  "/coverage/declarations", "/observations/25", "/calculation/customer_details/address",
  "/input/money/sources/0", "/calculation/amount_total", "/key", "/evidence/coverage", "/input/taxDate",
  "/input/money/sources/3", "/input/money/delivery", "/input/delivery/0", "/input/money/delivery/0",
  "/input/money/adjustments", "/calculation/tax_breakdown/0/tax_rate_details",
  "/calculation/shipping_cost/tax_breakdown/0/tax_rate_details", "/line_items/0/tax_breakdown/0/tax_rate_details", "/",
] as const;
const exclusiveCases = terminalCases.filter(row => row[0] === true);
expect(projectedSource).toHaveLength(exclusiveCases.length);

it.each(exclusiveCases.map(([, , code, field, remedy], index) => [code, projectedSource[index]!, field, remedy] as const))(
  "projects adapter %s %s to its exact storage tuple", async (code, source, field, remedy) => {
    const f = await installed({ basis: "exclusive" });
    f.now.taxFailure = { kind: "refused", code: code === "tax_adapter_response_invalid" ? "tax_calculation_closed" : code,
      field: source, remedy: "discarded owner response", jurisdiction: "discarded jurisdiction" };
    const expected = refusal(code, field, remedy);
    exact(await f.bind().createQuote(f.owner, f.request), expected);
    exact(await f.bind().createQuote(f.owner, f.request), expected);
    expect(f.taxInputs).toHaveLength(1);
    expect((await row(f)).outcome_text).not.toContain("discarded");
  },
);

it.each(["tax_adapter_unavailable", "tax_coverage_evidence_unavailable"] as const)("seals and replays effect-free %s", async code => {
  const f = await installed({ basis: "exclusive" });
  f.now.taxFailure = { kind: "unavailable", code, effect: "none", coverage: { digest: "3".repeat(64), vector: [] } };
  const expected = { kind: "unavailable", code, field: "/taxEvidence", effect: "none", remedy: "Request a new quote when the tax service is available." };
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  expect((await row(f)).outcome_text).not.toContain("vector");
  expect(f.taxInputs).toHaveLength(1);
});

it("keeps unqualified refusals fenced even when they carry coverage data", async () => {
  const f = await installed({ basis: "exclusive" });
  f.now.qualified = false;
  f.now.taxFailure = { kind: "refused", code: "tax_coverage_inconsistent", field: "/observations",
    remedy: "discard", coverage: { digest: "3".repeat(64), vector: [] } };
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  expect(await row(f)).toMatchObject({ state: "pending", outcome_text: null, contradiction: false });
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
});

function exactInfrastructureError(error: unknown, field: string, cause: unknown) {
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(["cause", "code", "field", "message", "remedy"]);
  expect(error).toMatchObject({ message: "commerce_quote_v2_unavailable", code: "commerce_quote_v2_unavailable", field,
    remedy: "Check the native app binding, driver setup, database connection and TLS, operation-role privileges, and installed migrations. Then retry the same operation." });
  const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
  expect(descriptor?.enumerable).toBe(false);
  expect(descriptor?.value).toBe(cause);
}

const publishedClassMissing = refusal("tax_class_missing", "/plan/skus",
  "Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote.");
const selectionFix = "Supply the documented published SKU selection and its catalogue head digest, then repeat the read.";
const catalogueRefusals = [
  refusal("tax_invalid_input", "/plan/skus", selectionFix),
  refusal("tax_invalid_input", "/plan/expectedHeadDigest", selectionFix),
  refusal("catalog_tax_assignment_evidence_invalid", "/plan/skus", "Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read."),
  refusal("catalog_tax_assignment_head_changed", "/plan/expectedHeadDigest", "Read the published selection again and request a fresh quote."),
  refusal("catalog_tax_assignment_unpublished", "/plan/skus", "Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote."),
  publishedClassMissing,
];
const pairA = { skuId: "10000000-0000-4000-8000-000000000001", sku: "sku-a" };
const pairB = { skuId: "10000000-0000-4000-8000-000000000002", sku: "sku-b" };
const assignmentRevision = "a".repeat(64);
const replyAssignment = (pair: typeof pairA) => ({ ...pair, classState: "assigned", taxClassKey: "class-0",
  assignmentRef: `catalog-assignment:${assignmentRevision}:${pairB.skuId}:2147483647:${pair.skuId}` });
const unavailableReply = (result: unknown): PgQueryExecutor => ({ query: async () => ({ rows: [{ result }] }) });
const installedServer = await import(/* @vite-ignore */ "data:text/javascript," + encodeURIComponent(
  `export { readPublishedSkuTaxAssignments, createDbBackedCommerceQuotePortV2 } from ${JSON.stringify(import.meta.resolve("@openlup/platform/commerce/server"))}`,
)) as {
  readPublishedSkuTaxAssignments: typeof readPublishedSkuTaxAssignments;
  createDbBackedCommerceQuotePortV2: typeof createDbBackedCommerceQuotePortV2;
};
const moduleHelper = installedServer.readPublishedSkuTaxAssignments;

function noExclusiveWork(f: Installed) {
  expect(f.fresh.coverage).toBe(0);
  expect(f.commands.map(({ operation }) => operation)).toStrictEqual(["lookup"]);
  expect(f.taxInputs).toStrictEqual([]);
}

it("snapshots the closed helper request before I/O and validates its domain in refusal order", async () => {
  expectTypeOf<Parameters<typeof readPublishedSkuTaxAssignments>[0]>().toEqualTypeOf<Pick<PgQueryExecutor, "query">>();
  const input = { expectedHeadDigest: assignmentRevision, skus: [{ ...pairB }, { ...pairA }] };
  const query = vi.fn(async (_sql: string, args?: unknown[]) => {
    expect(JSON.parse(String(args?.[0]))).toStrictEqual({ expectedHeadDigest: assignmentRevision, skus: [pairA, pairB] });
    input.expectedHeadDigest = providerDigest;
    input.skus[0]!.sku = "replaced";
    input.skus.pop();
    return { rows: [{ result: { kind: "published", revision: assignmentRevision, assignments: [replyAssignment(pairA), replyAssignment(pairB)] } }] };
  });
  const assigned = await moduleHelper({ query }, input);
  expect(assigned.assignments).toStrictEqual([replyAssignment(pairA), replyAssignment(pairB)]);
  const unexpected = { expectedHeadDigest: {}, skus: {}, unknown: true };
  for (const [invalid, expected] of [[unexpected, catalogueRefusals[0]], [{ skus: {} }, catalogueRefusals[1]],
    [{ expectedHeadDigest: null, skus: [{ ...pairA, taxClassKey: "provided" }] }, catalogueRefusals[0]]] as const) {
    const { code, field, remedy } = expected!;
    await expect(moduleHelper({ query }, invalid as never)).rejects.toMatchObject({ code, field, remedy });
  }
  expect(query).toHaveBeenCalledTimes(1);
});

it("reads only exact reply tuples and complete request-bound batches before interpreting class absence", async () => {
  const f = await installed({ basis: "exclusive" });
  const assigned = replyAssignment(pairA), other = replyAssignment(pairB);
  const none = { ...pairA, classState: "none", taxClassKey: null, assignmentRef: null };
  const published = { kind: "published", revision: assignmentRevision };
  const request = { expectedHeadDigest: assignmentRevision, skus: [pairA, pairB] };
  expect(await moduleHelper(unavailableReply({ ...published, assignments: [assigned, other] }), request)).toStrictEqual({ ...published, assignments: [assigned, other] });
  expect(await moduleHelper(unavailableReply({ ...published, assignments: [assigned, other] }), { ...request, expectedHeadDigest: null })).toMatchObject(published);
  const validRefusals = [...catalogueRefusals, { ...published, assignments: [none, other] }];
  const broken = [
    { ...published, assignments: [assigned] }, { ...published, assignments: [assigned, other, other] },
    { ...published, assignments: [other, assigned] }, { ...published, assignments: [assigned, assigned] },
    { ...published, assignments: [none, { ...other, sku: pairA.sku }] }, { ...published, assignments: [assigned, { ...other, skuId: randomUUID() }] },
    { ...published, assignments: [assigned, { ...other, classState: undefined }] },
    { ...published, assignments: [assigned, { ...other, classState: "unknown" }] },
    { ...published, assignments: [assigned, { ...other, extra: true }] },
    { ...published, assignments: [assigned, { ...other, taxClassKey: "𐀀".repeat(61) }] },
    { ...published, assignments: [assigned, { ...other, assignmentRef: {} }] },
    { ...published, assignments: [assigned, { ...other, assignmentRef: other.assignmentRef.replace(":2147483647:", ":2147483648:") }] },
    { ...published, assignments: [none, { ...other, assignmentRef: other.assignmentRef.replace(assignmentRevision, providerDigest) }] },
    { ...published, assignments: [{ ...none, assignmentRef: assigned.assignmentRef }, other] },
    { ...published, revision: null, assignments: [assigned, other] },
    { ...published, revision: providerDigest, assignments: [assigned, other] },
    { ...publishedClassMissing, field: "/input/lines" }, { ...publishedClassMissing, remedy: "changed" },
    { ...publishedClassMissing, extra: true },
  ];
  for (const [index, payload] of validRefusals.entries()) {
    f.commands.length = 0;
    f.deps.readPlan = async () => { await moduleHelper(unavailableReply(payload), request); throw new Error("Expected a catalogue refusal"); };
    exact(await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }), catalogueRefusals[index] ?? publishedClassMissing);
    noExclusiveWork(f);
  }
  for (const payload of broken) {
    f.commands.length = 0;
    let cause: unknown;
    f.deps.readPlan = async () => {
      await moduleHelper(unavailableReply(payload), request).catch((error: unknown) => { cause = error; throw error; });
      throw new Error("Expected an unreadable catalogue reply");
    };
    const error: unknown = await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }).catch((failure: unknown) => failure);
    expect(cause).toBeInstanceOf(Error);
    exactInfrastructureError(error, "/plan", cause);
    noExclusiveWork(f);
  }
});

it("recognizes the original private refusal only when it propagates through readPlan", async () => {
  const f = await installed();
  const cause: unknown = await moduleHelper(unavailableReply(publishedClassMissing), { expectedHeadDigest: null, skus: [pairA] }).catch((failure: unknown) => failure);
  if (!(cause instanceof Error)) throw new Error("Expected a private refusal");
  expect(Object.getPrototypeOf(cause)).not.toBe(Error.prototype);
  expect(Object.getPrototypeOf(Object.getPrototypeOf(cause))).toBe(Error.prototype);
  expect(Reflect.ownKeys(cause).filter(key => key !== "stack").sort()).toStrictEqual(["code", "field", "message", "remedy"]);
  expect(cause.message).toBe("tax_class_missing");
  expect({ ...cause }).toStrictEqual({ code: publishedClassMissing.code, field: publishedClassMissing.field, remedy: publishedClassMissing.remedy });
  const lookalike = Object.assign(new Error(cause.message), cause);
  const wrapped = new Error(cause.message, { cause });
  const readPlan = f.deps.readPlan, snapshot = f.deps.snapshotCommand;
  for (const other of [lookalike, wrapped, cause]) {
    f.deps.readPlan = async () => { throw other; };
    const res = f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() });
    if (other === cause) exact(await res, publishedClassMissing);
    else exactInfrastructureError(await res.catch((failure: unknown) => failure), "/plan", other);
  }
  f.deps.readPlan = readPlan;
  f.deps.snapshotCommand = async () => { throw cause; };
  const call = (port = f.bind()) => port.createQuote(f.owner, { ...f.request, key: randomUUID() }).catch((failure: unknown) => failure);
  exactInfrastructureError(await call(), "/destination/snapshot", cause);
  f.deps.snapshotCommand = snapshot;
  exactInfrastructureError(await call(installedServer.createDbBackedCommerceQuotePortV2({ ...f.deps, readLimits: async () => { throw cause; } })), "/read", cause);
});

it("keeps the published assignment helper outside the pricing import graph", async () => {
  const result = await build({ entryPoints: ["packages/platform/src/pricing/**/*.ts"], outdir: "pricing-proof",
    bundle: true, platform: "node", packages: "external", metafile: true, write: false });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs).toContain("packages/platform/src/pricing/index.ts");
  expect(inputs.some(path => path.endsWith("/publishedSkuTaxAssignments.ts"))).toBe(false);
});

it("rejects object substitutions for merchandise assignments at the runtime claim and seal entries", async () => {
  const fixture = await storageFixture(store);
  for (const [planKey, inputKey] of [["taxClassKey", "taxClass"], ["assignmentRef", "assignmentRef"]] as const) {
    const input = fixture.begin(exclusiveKind, true);
    for (const [root, key] of [[[
      "pin", "composition", "planInput", "lines", 0,
    ], planKey], [["pin", "request", "input", "lines", 0], inputKey]] as const) {
      const malformed = contaminate(input, [...root], { path: [key], object: false }, "value");
      expect(await rejected(store.runtime, beginSql, malformed)).toMatchObject({ code: "22023", message: "tax_invalid_input" });
    }
    const grant = await claim(input, store.runtime);
    const completion = seal(fixture, input, grant);
    const malformed = contaminate(completion, ["seal", "outcome", "quote", "lines", 0], { path: [planKey], object: false }, "value");
    expect(await rejected(store.runtime, completeSql, malformed)).toMatchObject({ code: "22023", message: "tax_invalid_input" });
  }
});

async function publicationWriter(classes: readonly (string | null)[]) {
  const typeKey = "example:article";
  const rules = Buffer.from(`
    const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : 1)));
    module.exports = {
      validateContent: () => [], validateProduct: () => [],
      identifyDocument: ({ id, productSlug, revisionNo, name }) => ({ schemaId: "example:document.v1", documentRef: id, productSlug, revisionNo, name }),
      inspectDocument(text) { return { ...this.identifyDocument(JSON.parse(text)), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
      matchesDocument: (document, text) => wire(document) === text,
      deriveSkuFacts: () => ({}), classifySkuChange: () => "compatible",
    };
  `);
  const pack = withCatalogPublicationRules({ id: "example:quotes", namespace: "example", version: 1, openlupRange: "1.x",
    capabilities: {}, taxClasses: classes.flatMap(key => key === null ? [] : [{ key }]),
    types: classes.map((taxClass, index) => ({ key: typeKey, version: index + 1,
      ...(taxClass === null ? {} : { taxClass }), units: [{ code: "openlup:g", dimension: "mass", integral: false }],
      netContentUnits: ["openlup:g"], dimensions: [{ key: "finish", kind: "choice", values: ["matte"] }],
      axes: [{ key: "finish", attributeKey: "finish" }], attributes: [{ key: "finish", scope: "variant",
        valueType: { kind: "enum", values: [{ id: "matte" }] }, required: false, cardinality: { min: 0, max: 1 },
        filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
    })) }, () => rules);
  await installCatalogDefinitions(store.owner, pack);
  const actorId = randomUUID();
  await store.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [actorId, `${actorId}@example.invalid`]);
  await store.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [actorId]);
  const api = createPostgresCatalogPublicationCommands({ registry: createCatalogProductTypeRegistry(pack.types),
    authorizeHuman: async (_context: null) => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
    catalogPublicationOwner: { async run<T>(work: (db: PgQueryExecutor) => Promise<T>) {
      const db = await store.owner.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const value = await work(db);
        await db.query("COMMIT");
        return value;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    } },
  });
  const who = (await api.authorize(null))!;
  return async (version: number) => {
    const productId = randomUUID(), skuId = randomUUID(), draftId = randomUUID(), documentId = randomUUID();
    const slug = `article-${version}`, sku = `item-${version}`, prefix = String(590123412340 + version);
    const barcode = prefix + String((10 - [...prefix].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10) % 10);
    const document = { schemaVersion: 1, id: "example:document", productSlug: slug, revisionNo: 1, name: "Example article" };
    const canonicalText = canonicalCatalogDraftJson(document);
    const ref = { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1", sourceRef: "example:source",
      documentRef: document.id, digest: destinationHash(canonicalText) };
    const facts = { skuCode: sku, title: "Example article", minQuantity: 1, isAddon: false, facts: {} };
    const identifier = { scheme: "gs1:gtin", issuer: "example", value: barcode, packagingLevel: "unit" as const };
    const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, slug, type: { key: typeKey, version },
      dimensions: ["finish"], primarySkuId: skuId, documentRevision: ref, sharedContent: { schemaVersion: 1, catalogAction: "create", document,
        presentation: {}, publicationSkus: [facts], requestedModes: [{ skuCode: sku, modes: [] }], offerMemberships: [] } },
      skus: [{ id: skuId, productId, code: sku, options: { finish: { kind: "choice", value: "matte" } }, identifiers: [identifier],
        netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } }],
      publication: { kind: "release", evidence: {}, operations: [
        { op: "create_product", productId, productSlug: slug, name: document.name },
        { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1, documentRef: ref.documentRef,
          sourceRef: ref.sourceRef, canonicalText, digest: ref.digest, provenance: { source: "current_draft" } },
        { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
        { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId, ...facts },
        { op: "create_identifier", skuCode: sku, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
        { op: "set_primary_sku", productSlug: slug, skuCode: sku },
        { op: "set_product_presentation", productSlug: slug, presentation: {} },
      ] },
    };
    let head: { publicationId: string; revision: number; documentDigest: string } | null = null;
    const publish = async () => {
      const expectedHead = head, draftRevision = (expectedHead?.revision ?? 0) + 1;
      if (expectedHead) {
        const presentation = { routePath: { en: `/${slug}-${draftRevision}` } };
        payload.product.sharedContent.catalogAction = "revise";
        payload.product.sharedContent.presentation = presentation;
        payload.publication.operations = [{ op: "set_product_presentation", productSlug: slug, presentation }];
      }
      const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: 3, action: expectedHead ? "revise" : "create",
        draftId, commandKey: randomUUID(), expectedRevision: draftRevision - 1, payload });
      const draft = await createPostgresCatalogDraftStoreV3(store.owner).apply({ canonicalCommand, fingerprint: destinationHash(canonicalCommand), actorId });
      if (!("record" in draft)) throw new Error(JSON.stringify(draft));
      const candidate = await api.prepareCandidate({ draftId, draftRevision, expectedHead }, who);
      if (!("candidateRef" in candidate) || !candidate.preparation?.postStateDigest) throw new Error(JSON.stringify(candidate));
      const fields = { productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
      expect(await api.execute({ ...fields, action: "approve", reason: null, postStateDigest: candidate.preparation.postStateDigest, commandKey: randomUUID() }, who))
        .toMatchObject({ outcome: "committed" });
      const result = await api.execute({ ...fields, action: "publish", expectedHead, changes: [], commandKey: randomUUID() }, who);
      if (!("receipt" in result) || !("head" in result.receipt)) throw new Error(JSON.stringify(result));
      head = result.receipt.head;
      return head;
    };
    await publish();
    return { sku, skuId, productId, publish };
  };
}

type PublishedSelection = Awaited<ReturnType<Awaited<ReturnType<typeof publicationWriter>>>>;
function guideSelection(f: Installed, selected: readonly PublishedSelection[]) {
  const original = f.deps.readPlan;
  const skuIdsByCode = new Map(selected.map(({ sku, skuId }) => [sku, skuId]));
  const query = vi.fn((text: string, values?: unknown[]) => store.runtime.query(text, values));
  f.now.planInput = { ...f.now.planInput, lines: f.now.planInput.lines.map((line, index) => ({ ...line, sku: selected[index]!.sku })) };
  const request = { ...f.request, lines: f.request.lines.map((line, index) => ({ ...line, sku: selected[index]!.sku })) };
  f.deps.readPlan = recipe.withPublishedTaxClasses({ query }, async (...args) => ({ facts: await original(...args), skuIdsByCode }));
  return { request, query, original };
}

async function expectedTaxLine(selection: PublishedSelection, taxClassKey: string) {
  const { rows: [data] } = await store.owner.query<{ head: string; publication: string; revision: number; sku: string }>(`
    SELECT public.catalog_publication_read_head()->>'headDigest' AS head, h.publication_id AS publication, h.revision,
      p.canonical_state::jsonb #>> '{skus,0,revisionId}' AS sku
    FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id WHERE h.product_id=$1`, [selection.productId]);
  if (!data) throw new Error("Missing fixture publication");
  return { sku: selection.sku, taxClassKey, assignmentRef: `catalog-assignment:${data.head}:${data.publication}:${data.revision}:${data.sku}` };
}

it("executes the published tax recipe, pins repeated merchandise and replays across publication changes", async () => {
  const create = await publicationWriter(["class-0", "class-1", null]);
  const first = await create(1), second = await create(2), classless = await create(3);
  const f = await installed({ basis: "exclusive", units: [120, 150, 170], shipping: 100, cutoff: "long" });
  const { request, query } = guideSelection(f, [first, second, first]);
  const a = await expectedTaxLine(first, "class-0"), b = await expectedTaxLine(second, "class-1");
  f.now.onAdapter = async () => { expect((await row(f)).state).toBe("pending"); await first.publish(); };
  const original = quote(await f.bind().createQuote(f.owner, request));
  expect(query).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[0]))).toMatchObject({ expectedHeadDigest: null, skus: expect.arrayContaining([
    { sku: first.sku, skuId: first.skuId }, { sku: second.sku, skuId: second.skuId },
  ]) });
  expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[0])).skus).toHaveLength(2);
  const stored = await row(f);
  const pin = stored.pin;
  expect(pin.composition.catalogueEvidenceRef).toBe(f.now.catalogueEvidenceRef);
  expect(pin.composition.planInput.lines).toMatchObject([a, b, a]);
  expect(pin.request.input.lines).toMatchObject([a, b, a].map(({ taxClassKey, ...line }) => ({ ...line, taxClass: taxClassKey })));
  expect(pin.request.input.delivery).toMatchObject([{ taxClass: "ship-class", assignmentRef: "ship-assignment" }]);
  expect(pin.request.input.classMapRevision).toBe(f.now.planInput.price.classMapRevision);
  expect(JSON.parse(stored.outcome_text)[1].outcome.quote.lines).toMatchObject([a, b, a]);
  expect(original.lines).toMatchObject([a, b, a]);
  await first.publish();
  f.now.onAdapter = undefined;
  const replay = quote(await f.bind().createQuote(f.owner, request));
  expect(replay).toStrictEqual(original);
  expect((await row(f)).outcome_text).toBe(stored.outcome_text);
  expect(query).toHaveBeenCalledTimes(1);
  const newA = await expectedTaxLine(first, "class-0"), newB = await expectedTaxLine(second, "class-1");
  const fresh = quote(await f.bind().createQuote(f.owner, { ...request, key: randomUUID() }));
  expect(fresh.lines).toMatchObject([newA, newB, newA]);
  expect(newA.assignmentRef).not.toBe(a.assignmentRef);
  expect(newA.assignmentRef.split(":").at(-1)).toBe(a.assignmentRef.split(":").at(-1));
  expect(query).toHaveBeenCalledTimes(2);
  const draftIO = vi.fn((text: string, values?: unknown[]) => store.runtime.query(text, values));
  await expect(createPostgresNativeCheckoutPersistence({ query: draftIO }).createOrderDraft({
    idempotencyKey: randomUUID(), quoteSnapshot: original as unknown as NativeCheckoutDraftRequest["quoteSnapshot"],
  })).rejects.toBeInstanceOf(Error);
  expect(draftIO).not.toHaveBeenCalled();

  const noClass = await installed({ basis: "exclusive", units: [100] });
  const excluded = guideSelection(noClass, [classless]);
  exact(await noClass.bind().createQuote(noClass.owner, excluded.request), publishedClassMissing);
  expect(excluded.query).toHaveBeenCalledTimes(1);
  noExclusiveWork(noClass);
  const adapter = await installed({ basis: "exclusive", units: [100] });
  const withClass = guideSelection(adapter, [first]);
  adapter.now.taxFailure = { kind: "refused", code: "tax_class_missing", field: "/input/lines/0/taxClass", remedy: "Fixture adapter refusal" };
  exact(await adapter.bind().createQuote(adapter.owner, withClass.request), refusal("tax_class_missing", "/input/lines",
    "Have the coverage owner supply the required tax class mapping for /input/lines, then obtain a fresh quote."));
});

it("quotes a published fiscal selection with an empty tax class table and no projection calls", async () => {
  const original = store;
  store = await resources.installation("published-fiscal-quotes");
  try {
    const create = await publicationWriter([null]);
    const selected = await create(1);
    expect((await store.owner.query("SELECT key FROM public.catalog_tax_classes")).rows).toStrictEqual([]);
    const f = await installed({ units: [100] });
    const { request, query } = guideSelection(f, [selected]);
    expect(quote(await f.bind().createQuote(f.owner, request)).taxEvidence.kind).toBe("fiscal_profile");
    expect(query).not.toHaveBeenCalled();
    expect(f.taxInputs).toStrictEqual([]);
  } finally { store = original; }
});

it("preserves complete incumbent and fresh fiscal quote bytes across the native forward", async () => {
  const original = store;
  store = await resources.installation("published-quote-compatibility");
  try {
    const create = await publicationWriter([null]);
    const selected = await create(1);
    const f = await installed({ units: [100], adjust: true });
    const { request, original: readPlan, query } = guideSelection(f, [selected]);
    f.deps.readPlan = readPlan;
    const time = new Date().toISOString(), statements: string[] = [];
    const taxProfile = { included: true as const, country: "XA", category: "standard", vatRateBps: 2300, legalBasis: "rules-a" };
    const legacy = createIncumbentQuotePort({
      quoteCatalogReadPort: { async listQuoteCatalogItems() {
        const sql = `SELECT p.canonical_state::jsonb #>> '{product,slug}' AS slug,
            p.canonical_state::jsonb #>> '{product,document,id}' AS document,
            p.canonical_state::jsonb #>> '{product,document,digest}' AS digest,
            public.catalog_publication_read_sku_revision(h.product_id,p.canonical_state::jsonb #> '{skus,0}')->>'code' AS code
          FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id WHERE h.product_id=$1`;
        statements.push(sql);
        const { rows: [published] } = await store.owner.query<{ slug: string; document: string; digest: string; code: string }>(sql, [selected.productId]);
        if (!published) throw new Error("Missing legacy fixture publication");
        return [{ skuId: selected.skuId, skuCode: published.code, variantId: selected.skuId, productSlug: published.slug,
          netWeightG: 100, isAddon: false, sellability: { oneTime: true, subscription: true },
          documentRevision: { id: published.document, digest: published.digest } }];
      } },
      isStrictD1Quote: false, taxProfile, supportedTaxProfiles: [taxProfile], regionCode: "XA", currency, now: () => time,
      pricingResolverPort: { async resolvePrice({ variantId, mode }) {
        return { variantId, mode, amountKind: "gross", unitPriceMinor: 100, matchedMinQty: 1,
          priceListId: "list-a", priceEntryId: "entry-a", resolvedAt: time };
      } },
      hasPromotionCodePort: false, lineContext: () => ({}),
      quoteContext: input => () => ({ mode: input.mode, cadenceDays: input.mode === "subscription" ? 28 : null,
        usageCoverageDays: null, promoCodes: [], subjectId: null }),
      resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
      applyPromotionCodesV2: async input => ({ discounts: input.discounts, codeRejections: [], codeRejectionDetails: [] }),
    });
    const forward = readFileSync("db/platform/migrations/20261129060000_catalog_publication_tax_assignments.sql", "utf8");
    const run = async () => {
      const incumbent = await Promise.all((["one_time", "subscription"] as const).map(mode => legacy.createQuote({
        mode, lines: [{ sku: selected.sku, quantity: 1 }], promoCodes: [], ...(mode === "subscription" ? { cadenceDays: 28 } : {}),
      })));
      const marker = "const { pin, calculationId, generation, claimToken, dispatchDeadlineMs, cutoffDeadlineMs } = claim;";
      const fixed = `let sequence = 0;
        const randomUUID = () => "c0000000-0000-4000-8000-" + String(++sequence).padStart(12, "0");
        ${marker}`;
      const port = await mutant(f, marker, fixed);
      f.commands.length = 0;
      const fiscal = quote(await port.createQuote(f.owner, request));
      expect(f.commands.map(({ operation }) => operation)).toStrictEqual(["lookup", "claim", "complete"]);
      expect(fiscal.lines[0]!.discountAllocations).toHaveLength(1);
      const { rows: [stored] } = await store.owner.query<{ pin: string; outcome_text: string }>(
        "SELECT pin::text,outcome_text FROM public.tax_calculations WHERE identity->>'evaluationKey'=$1", [request.key]);
      if (!stored) throw new Error("Fiscal quote was not retained");
      return { incumbent: incumbent.map(value => JSON.stringify(value)), fiscal: JSON.stringify(fiscal), ...stored };
    };
    await store.owner.query("DROP FUNCTION public.catalog_publication_tax_assignments(jsonb), public.catalog_publication_read_head_manifests()");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(time));
    try {
      await mutate(store, "public.tax_calculation_transition_v1(jsonb,boolean)", "VALUES (gen_random_uuid(),'pending',locator_key,identity",
        "VALUES ('f0000000-0000-4000-8000-000000000001','pending',locator_key,identity", async () => {
          const before = await run();
          const db = await store.owner.connect();
          try {
            await db.query("BEGIN; SET LOCAL session_replication_role=replica");
            await db.query("DELETE FROM public.tax_calculations WHERE identity->>'evaluationKey'=$1", [request.key]);
            await db.query("COMMIT");
          } finally { await db.query("ROLLBACK"); db.release(); }
          await store.owner.query(forward);
          expect(await run()).toStrictEqual(before);
        });
    } finally { vi.useRealTimers(); }
    expect(query).not.toHaveBeenCalled();
    expect(statements).toHaveLength(4);
    expect(new Set(statements).size).toBe(1);
    expect(statements.every(sql => !sql.includes("catalog_publication_tax_assignments"))).toBe(true);
  } finally { store = original; }
});

it("uses the single infrastructure checklist with the original non-enumerable cause", async () => {
  const f = await installed();
  const cause = new Error("Scripted binding failure");
  f.deps.readPlan = async () => { throw cause; };
  const error: unknown = await f.bind().createQuote(f.owner, f.request).catch((failure: unknown) => failure);
  exactInfrastructureError(error, "/plan", cause);
});

it("classifies a failed quote module load before entering the evaluation lane", async () => {
  const f = await installed();
  const run = vi.spyOn(f.deps.lane, "run");
  const implementation = "data:text/javascript," + encodeURIComponent('throw new Error("Scripted quote module failure");');
  // The module loader retains the original evaluation error for this URL.
  const cause: unknown = await import(/* @vite-ignore */ implementation).catch((failure: unknown) => failure);
  expect(cause).toBeInstanceOf(Error);
  const port = await detachedQuotePort(f, implementation);
  const error: unknown = await port.createQuote(f.owner, f.request).catch((failure: unknown) => failure);
  expect(run).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
  exactInfrastructureError(error, "/", cause);
});

it("admits the original invocation at its UTF-16 and UTF-8 limits before live reads", async () => {
  const f = await installed();
  const long = { ...f.request, key: "😀".repeat(128), deliverySelector: "😀".repeat(60) };
  // The destination owner has a separate receipt key domain.
  const snapshotCommandFor = f.deps.snapshotCommand;
  f.deps.snapshotCommand = (owner, request) => snapshotCommandFor(owner, { ...request, key: randomUUID() });
  quote(await f.bind().createQuote(f.owner, long));
  const live = { ...f.fresh };
  exact(await f.bind().createQuote(f.owner, { ...long, key: long.key + "a" }),
    refusal("tax_invalid_input", "/identity/evaluationKey", "Supply the documented input."));
  exact(await f.bind().createQuote(f.owner, { ...long, deliverySelector: long.deliverySelector + "a" }),
    refusal("tax_invalid_input", "/invocation/deliverySelector", "Supply the documented input."));
  expect(f.fresh).toEqual(live);
});

it("discriminates the contact, interval, integrity and deadline checks in a disposable build", async () => {
  const contact = await installed({ shipping: 0, contact: {} });
  exact(await contact.bind().createQuote(contact.owner, contact.request), contactRefusal);
  // Temporarily disabled the contact guard in the disposable build.
  const withoutContact = await mutant(contact,
    'if (plan.winner.delivery.some(row => row.kind === "shipping") && (!contact.recipientName?.trim() || !contact.contactPhone?.trim()))',
    'if (false)');
  quote(await withoutContact.createQuote(contact.owner, contact.request));

  const limits = await installed({ units: [101], range: 100 });
  const advice = { ...refusal("money_amount_out_of_range", "/payableMinor", "Choose a supported amount and obtain a fresh quote."),
    amountAdvice: { currency, minMinor: 1, maxMinor: 100 } };
  exact(await limits.bind().createQuote(limits.owner, limits.request), advice);
  // Temporarily disabled the verified interval check in the disposable build.
  const withoutInterval = await mutant(limits, "if (payable < effective.minMinor || payable > effective.maxMinor)", "if (false)");
  await expect(withoutInterval.createQuote(limits.owner, { ...limits.request, key: randomUUID() }))
    .rejects.toMatchObject({ code: "commerce_quote_v2_unavailable", field: "/payableMinor" });

  const corrupt = await installed({ basis: "exclusive", vector: 1660, range: 1659 });
  corrupt.now.alterReply = result => result.kind === "final" ? { ...result, evidenceDigest: "1".repeat(64) } : result;
  expect(await corrupt.bind().createQuote(corrupt.owner, corrupt.request)).toMatchObject({ kind: "refused", field: "/evidenceDigest" });
  // Temporarily disabled the success evidence check before advice in the disposable build.
  const withoutVerification = await mutant(corrupt, "if (error)\n            return error;", "if (false)\n            return error;");
  expect(await withoutVerification.createQuote(corrupt.owner, { ...corrupt.request, key: randomUUID() }))
    .toMatchObject({ kind: "refused", amountAdvice: { minMinor: 1, maxMinor: 1659, currency } });

  const late = await installed({ basis: "exclusive", cutoff: "short" });
  late.now.taxFailure = noDispatch;
  exact(await late.bind().createQuote(late.owner, late.request), pending);
  await takeover(late);
  late.now.pauseUntil = late.now.quoteCutoff;
  late.now.timing = "recoveryRead";
  // Temporarily disabled the deadline recheck after the recovery read in the disposable build.
  const withoutDeadline = await mutant(late, "const dispatch = snapshot(request);\n        if (!(performance.now() < dispatchDeadlineMs))",
    "const dispatch = snapshot(request);\n        if (false)");
  exact(await withoutDeadline.createQuote(late.owner, late.request), pending);
  expect(late.taxInputs).toHaveLength(2);
}, 12_000);

it("rejects borrowed scope before looking at the original quote or dispatching", async () => {
  const f = await installed({ basis: "exclusive" });
  quote(await f.bind().createQuote(f.owner, f.request));
  const borrowed = { ...f.owner, principalRef: randomUUID() };
  exact(await f.bind().createQuote(borrowed, f.request),
    refusal("tax_scope_mismatch", "/destination/snapshotRef", "Re-obtain evidence in the authorized scope."));
  expect(f.taxInputs).toHaveLength(1);
  expect(f.fresh.snapshots).toBe(1);
});

it("checks the shorter verified adapter cutoff before giving amount advice", async () => {
  const f = await installed({ basis: "exclusive", vector: 1660, range: 1659, adapterLifetime: 500 });
  f.now.timing = "adapter";
  f.now.pauseUntil = at(1800);
  exact(await f.bind().createQuote(f.owner, f.request), expired);
  expect(f.taxInputs).toHaveLength(1);
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
  expect(await row(f)).toMatchObject({ state: "pending", outcome_text: null });
});

it.each([["out_of_scope", "skip"], ["exempt", "required"]] as const)(
  "derives %s posting from verified coverage",
  async (coverageDecision, disposition) => {
    const f = await installed({ basis: "exclusive", coverageDecision });
    const q = quote(await f.bind().createQuote(f.owner, f.request));
    expect(q.taxTotal).toBe(0);
    const [, terminal] = JSON.parse((await row(f)).outcome_text);
    expect(terminal.disposition).toBe(disposition);
  },
);

it("keeps a mismatched recovery qualification pending without dispatching", async () => {
  const f = await installed({ basis: "exclusive" });
  f.now.taxFailure = noDispatch;
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  await takeover(f);
  f.deps.exclusive!.recovery = "a".repeat(64);
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  expect(f.taxInputs).toHaveLength(1);
  expect(await row(f)).toMatchObject({ state: "pending", generation: 1, outcome_text: null });
});
