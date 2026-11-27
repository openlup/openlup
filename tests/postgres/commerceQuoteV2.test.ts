import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { calculateCatalogueMoneyV2, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { bindCommerceMoneyLimitsV2Reader, createDbBackedCommerceQuotePortV2, installCommerceMoneyLimitsV2 } from "@openlup/platform/commerce/server";
import type { CommerceQuoteV2Request, DbBackedCommerceQuotePortV2Deps, QuoteOutcome } from "@openlup/platform/commerce/server";
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
import { fixture as storageFixture, mutate, terminalCases } from "./commerceQuoteV2StorageFixture.js";
import { destinationContext, destinationHash, reachDestinationCutoff, snapshotCommand, snapshotPreimage, testServicePin } from "./destinationDocumentFixture.js";

type Deps = DbBackedCommerceQuotePortV2Deps;
type Bindings = Omit<Deps, "readLimits"> & { runtime: JourneyInstallation["runtime"] };
type Facts = Awaited<ReturnType<Deps["readPlan"]>>;
type Binding = Parameters<Deps["destination"]["read"]>[3];
type Contact = Parameters<Deps["destination"]["snapshot"]>[1]["original"]["contact"];
type Failure = Extract<TaxQuoteResultV1, { kind: "refused" | "unavailable" }>;
type Timing = "dependencies" | "claim" | "claimAck" | "adapter" | "seal" | "recoveryRead";
type TerminalAck = "lookup" | "sealAck";

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
)) as { bindNativeQuotes(bindings: Bindings): ReturnType<typeof createDbBackedCommerceQuotePortV2> };

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
    onTerminalAck: undefined as ((stage: TerminalAck, validUntil: string) => void) | undefined,
    throwTax: false, onAdapter: undefined as (() => Promise<void>) | undefined, lateCoverage: undefined as TaxCoverageRevision | undefined,
    alterReply: undefined as ((output: TaxQuoteResultV1) => TaxQuoteResultV1) | undefined, fallbackRate: options.rate ?? 2300,
    qualified: true, claimFailure: undefined as Error | undefined, sealFailure: undefined as Error | undefined, deferSeal: false,
  };
  const request: CommerceQuoteV2Request = { key: randomUUID(), purpose: options.purpose ?? "final",
    mode: "one_time", lines: units.map((_minor, index) => ({ sku: "item-" + index, quantity: 1 })), deliverySelector: "delivery-a", paymentSelector: "payment-a" };
  const taxInputs: TaxQuoteRequestV1[] = [];
  const taxReplies: TaxQuoteResultV1[] = [];
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
    let terminalExpiry: string | undefined;
    const result = await realLane.run(db => work({ async query(sql, args) {
      if (args) {
        const input = JSON.parse(String(args[0])) as typeof commands[number];
        operation = input.operation;
        commands.push(input);
        if (operation === "claim") await pause("claim");
        if (operation === "complete") {
          if (now.deferSeal) return { rows: [{ result: { kind: "pending" } }] };
          await pause("seal");
        }
      }
      const reply = await db.query(sql, args);
      if (now.onTerminalAck && args) {
        const terminal = reply.rows[0]?.result as { kind: string; validUntil?: string } | undefined;
        if (terminal?.kind === "terminal") terminalExpiry = terminal.validUntil;
      }
      return reply;
    } }));
    if (terminalExpiry && (operation === "lookup" || operation === "complete")) {
      now.onTerminalAck?.(operation === "lookup" ? "lookup" : "sealAck", terminalExpiry);
    }
    if (operation === "claim") {
      await pause("claimAck");
      if (now.claimFailure) throw now.claimFailure;
    }
    if (operation === "complete" && now.sealFailure) throw now.sealFailure;
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
        taxReplies.push(structuredClone(output));
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
  return { ctx, owner, request, bind: () => recipe.bindNativeQuotes(deps), deps, now, commands, taxInputs, taxReplies, bindings, fresh, privacy, coverage, terms };
}

type Installed = Awaited<ReturnType<typeof installed>>;
const row = async (fixture: Installed, key = fixture.request.key) => (await store.owner.query(
  `SELECT calculation_id, generation, state, outcome_text, pin, contradiction, adapter_money_text, adapter_result_digest
    FROM public.tax_calculations WHERE identity->>'evaluationKey'=$1`,
  [key])).rows[0];
const readMoney = async (calculationId: string) => (await store.runtime.query(
  "SELECT public.tax_calculation_read_adapter_money_v1($1) AS result", [calculationId])).rows[0].result;
const moneyHold = (calculationId: string) => ({ calculationId, status: "hold", adapterMoneyText: null, sealDigest: null });
function originalMoney(f: Installed) {
  const reply = f.taxReplies.at(-1);
  if (!reply || !("money" in reply)) throw new Error("Expected an adapter success");
  const adapterMoneyText = canonicalCatalogDraftJson(reply.money);
  const sealDigest = evaluationDigest("adapter-result-seal", [reply.kind, destinationHash(adapterMoneyText), reply.evidenceDigest]);
  return { adapterMoneyText, sealDigest };
}
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
  expect(stored).toMatchObject({ adapter_money_text: null, adapter_result_digest: null });
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
    const stored = await row(f);
    const [, terminal] = JSON.parse(stored.outcome_text);
    expect(terminal.disposition).toBe("required");
    expect(q.taxEvidence.expiresAt).toBe(terminal.evidence.adapterEvidence.expiresAt);
    const money = originalMoney(f);
    expect(Buffer.from(stored.adapter_money_text)).toEqual(Buffer.from(money.adapterMoneyText));
    expect(stored.adapter_result_digest).toBe(money.sealDigest);
    const retained = stored.pin.request;
    const issued = f.taxInputs[0]!;
    const reconstructed = { ...retained, input: { ...retained.input,
      destination: { ...retained.input.destination, address: issued.input.destination.address } } };
    expect(reconstructed).toStrictEqual(issued);
    expect(evaluationDigest("evaluation-request", reconstructed)).toBe(stored.pin.requestDigest);
    expect({ kind: terminal.outcome.kind, money: JSON.parse(stored.adapter_money_text),
      evidence: terminal.evidence.adapterEvidence, evidenceDigest: terminal.evidence.adapterDigest }).toEqual(f.taxReplies[0]);
    expect(await readMoney(stored.calculation_id)).toStrictEqual(q.status === "final"
      ? { calculationId: stored.calculation_id, status: "final", ...money } : moneyHold(stored.calculation_id));
    expect(await f.bind().createQuote(f.owner, f.request)).toStrictEqual({ kind: "quoted", quote: q, freshness: "current" });
    const { rows } = await store.runtime.query("SELECT public.tax_calculation_export_v1($1) AS result", [f.owner.clientId]);
    expect(JSON.stringify(rows)).not.toContain("adapterMoneyText");
    expect(JSON.stringify(rows)).not.toContain("adapter_result_digest");
  },
);

it("seals distinct adapter breakdowns even when the payable amount is equal", async () => {
  const original = await installed({ basis: "exclusive", vector: 1660 });
  const changed = await installed({ basis: "exclusive", vector: 1660, units: [890, 600] });
  const a = quote(await original.bind().createQuote(original.owner, original.request));
  const b = quote(await changed.bind().createQuote(changed.owner, changed.request));
  expect(a.payableMinor).toBe(1660);
  expect(b.payableMinor).toBe(a.payableMinor);
  expect(a.taxTotal).not.toBe(b.taxTotal);
  expect((await row(original)).adapter_result_digest).not.toBe((await row(changed)).adapter_result_digest);
  expect((await row(original)).adapter_money_text).toBe(originalMoney(original).adapterMoneyText);
  expect((await row(changed)).adapter_money_text).toBe(originalMoney(changed).adapterMoneyText);
});

it.each([false, true])("refuses a foreign adjustment from the original claim before completion (recovered=%s)", async recover => {
  const f = await installed({ basis: "exclusive", vector: 1660, adjust: true });
  if (recover) {
    f.now.throwTax = true;
    await expect(f.bind().createQuote(f.owner, f.request)).rejects.toMatchObject({ code: "commerce_quote_v2_unavailable" });
    f.now.throwTax = false;
    await takeover(f);
    f.now.planInput = hostPlan("inclusive", null, [400, 400]);
  }
  f.now.alterReply = reply => JSON.parse(JSON.stringify(reply).replaceAll('"cent-off"', '"foreign@example.invalid"'));
  const refused = await f.bind().createQuote(f.owner, f.request);
  expect(refused).toMatchObject({ kind: "refused", code: "tax_breakdown_incomplete", field: expect.stringMatching(/^\/money\//u) });
  expect(f.commands.filter(command => command.operation === "complete")).toEqual([]);
  expect(f.fresh.plans).toBe(1);
  const stored = await row(f);
  expect(stored).toMatchObject({ state: "pending", generation: recover ? 2 : 1, adapter_money_text: null, adapter_result_digest: null });
  expect(stored.pin.request.input.money.adjustments[0].adjustmentRef).toBe("cent-off");
  expect(await readMoney(stored.calculation_id)).toStrictEqual(moneyHold(stored.calculation_id));
  if (recover) expect(f.taxInputs[1]).toStrictEqual(f.taxInputs[0]);
});

it("refuses a balanced redistribution across the issued merchandise lines before completion", async () => {
  const f = await installed({ basis: "exclusive", vector: 1660, adjust: true, coverageDecision: "out_of_scope" });
  f.now.alterReply = reply => {
    if (!("money" in reply)) throw new Error("Expected an adapter success");
    const issued = f.taxInputs[0]!.input.money;
    expect(reply.money.components[0]!.allocations).toHaveLength(1);
    expect(reply.money.components[1]!.allocations).toHaveLength(0);
    const moved = { ...issued, adjustments: issued.adjustments.map(adjustment => ({
      ...adjustment, target: { lineKeys: ["line-1"] },
    })) };
    const plan = planCatalogueMoneyV2(moved);
    const money = calculateCatalogueMoneyV2(moved, { kind: "provider", payableMinor: reply.money.payableMinor,
      components: plan.components.map(({ ref, preDiscountMinor, allocations }) => ({
        ref, states: [{ afterSequence: 0, amountMinor: preDiscountMinor, taxPositions: [] },
          ...allocations.map(({ sequence, afterMinor }) => ({ afterSequence: sequence, amountMinor: afterMinor, taxPositions: [] }))],
      })),
    });
    expect(money.components[0]!.allocations).toHaveLength(0);
    expect(money.components[1]!.allocations).toHaveLength(1);
    expect(money.payableMinor).toBe(reply.money.payableMinor);
    return { ...reply, money };
  };
  expect(await f.bind().createQuote(f.owner, f.request)).toMatchObject({ kind: "refused", code: "tax_breakdown_incomplete",
    field: expect.stringMatching(/^\/money\//u) });
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
  expect(await row(f)).toMatchObject({ state: "pending", adapter_money_text: null, adapter_result_digest: null });
});

function changeAssessmentId(reply: TaxQuoteResultV1, replacement: string): TaxQuoteResultV1 {
  if (!("money" in reply)) throw new Error("Expected an adapter success");
  const id = reply.evidence.positions.tax[0]!.positionRef;
  const changed = JSON.parse(JSON.stringify(reply).replaceAll(JSON.stringify(id), JSON.stringify(replacement))) as typeof reply;
  const { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, coverage, positions } = changed.evidence;
  const tax = positions.tax.map(({ resolutionDigest: _resolution, providerLineRef: _provider, ...assessment }) => assessment);
  const fiscalDigest = evaluationDigest("fiscal", { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision,
    coverage: coverage.vector, tax, fees: positions.fees });
  const evidence = { ...changed.evidence, fiscalDigest };
  return { ...changed, evidence, evidenceDigest: evaluationDigest("evidence", evidence) } as typeof reply;
}

it("reports the full adapter-money refusal table at its native call sites", async () => {
  const supplementRemedy = "Supply the original verified adapter money through the native tax completion adapter.";
  const purchase = { basis: "exclusive", vector: 1660, adjust: true } as const;
  const prepare = async () => {
    const fixture = await installed(purchase);
    fixture.now.deferSeal = true;
    await fixture.bind().createQuote(fixture.owner, fixture.request);
    const wire = JSON.parse(JSON.stringify(fixture.commands.find(command => command.operation === "complete")));
    const { adapterMoneyResult: money, ...seal } = wire.seal;
    return { fixture, wire, money, seal, base: { ...wire, seal } };
  };
  const pending = await prepare();
  const { wire, money, seal, base } = pending;
  const supplement = (value: unknown) => ({ ...base, seal: { ...seal, adapterMoneyResult: value } });
  const call = (value: object) => store.runtime.query("SELECT public.tax_calculation_complete_v1($1::jsonb) AS result", [value])
    .then(({ rows }) => rows[0].result);
  const replay = await prepare();
  expect(await call(replay.wire)).toMatchObject({ kind: "terminal", outcome: { kind: "final" } });
  const erasure = await prepare();
  const actor = { principalId: randomUUID() };
  await store.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",
    [actor.principalId, actor.principalId + "@example.invalid"]);
  await store.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [actor.principalId]);
  expect(await erasure.fixture.privacy(true).operations.erase(actor, { subject: { kind: "contact", contactId: erasure.fixture.ctx.clientId },
    idempotencyKey: randomUUID() })).toMatchObject({ outcome: "ERASED" });
  const collision = await prepare();
  const { scope: { adapter, accountRef, mode }, calculationRef: providerRef } = collision.wire.seal.evidence.adapterEvidence;
  const providerKey = evaluationDigest("provider-calculation", {
    installationRef: collision.wire.identity.installationRef, adapter, accountRef, mode, providerRef,
  });
  await store.owner.query("INSERT INTO public.tax_calculations(calculation_id,state,provider_digest) VALUES($1,'erased',$2)",
    [randomUUID(), providerKey]);

  const read = async (id: string | null, isolation: "READ COMMITTED" | "REPEATABLE READ") => {
    const session = await store.runtime.connect();
    try {
      await session.query("BEGIN ISOLATION LEVEL " + isolation);
      await session.query("SET LOCAL ROLE service_role");
      return await session.query("SELECT public.tax_calculation_read_adapter_money_v1($1::uuid)", [id]);
    } finally { await session.query("ROLLBACK"); session.release(); }
  };
  const { calculationId } = replay.wire;
  const invalidFrame = () => store.owner.query(`INSERT INTO public.tax_calculations
    SELECT (jsonb_populate_record(NULL::public.tax_calculations, to_jsonb(r) || '{"adapter_money_text":"{}"}'::jsonb)).*
    FROM public.tax_calculations r WHERE calculation_id=$1`, [calculationId]);
  const clear = () => store.owner.query("UPDATE public.tax_calculations SET adapter_money_text=NULL,adapter_result_digest=NULL WHERE calculation_id=$1",
    [calculationId]);
  const writerRefusal = async () => {
    const f = await installed(purchase);
    let planted: TaxQuoteResultV1 | undefined;
    f.now.alterReply = reply => (planted = changeAssessmentId(reply, "foreign@example.invalid"));
    const reply = await f.bind().createQuote(f.owner, f.request);
    expect(verifyTaxQuoteResult(f.taxInputs[0]!, planted!)).toBeUndefined();
    expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim"]);
    expect(await row(f)).toMatchObject({ state: "pending", adapter_money_text: null, adapter_result_digest: null });
    return reply;
  };
  const observe = async (run: () => Promise<unknown>) => {
    try {
      const result = await run();
      const reply = result as { kind?: string; outcome?: unknown };
      const refused = (reply.kind === "terminal" ? reply.outcome : reply) as { kind?: string; code?: string; field?: string; remedy?: string };
      expect(refused.kind).toBe("refused");
      return [refused.code, undefined, refused.field, refused.remedy];
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      return [error.message, error.code, error.detail, error.hint];
    }
  };
  const badSupplement = ["tax_invalid_input", "22023", "/seal/adapterMoneyResult", supplementRemedy];
  const replayConflict = ["tax_reference_conflict", "22023", "/taxEvidence", "Replay the original invocation and evidence."];
  const wrongMoney = structuredClone(money);
  wrongMoney.components[0].final.taxMinor++;
  const duplicateMoney = structuredClone(money);
  const positions = duplicateMoney.components[0].final.taxPositions;
  positions.push({ ...positions[0], taxMinor: 0 });
  const changedMoney = structuredClone(replay.money);
  changedMoney.components[0].initial.taxPositions[0].positionRef += "-other";
  const cases = [
    ["missing fresh money", () => call(base), badSupplement],
    ["JSON null money", () => call(supplement(null)), badSupplement],
    ["supplement on an indeterminate outcome", () => call({ ...wire, seal: { ...wire.seal, evidence: null, disposition: "indeterminate",
      outcome: { kind: "indeterminate" }, contradiction: true } }), badSupplement],
    ["failed full money validation", () => call(supplement(wrongMoney)), badSupplement],
    ["duplicate tax position in one state", () => call(supplement(duplicateMoney)), badSupplement],
    ["writer assessment-token refusal", writerRefusal, ["tax_invalid_input", undefined, "/seal/adapterMoneyResult", supplementRemedy]],
    ["changed terminal submission", () => call({ ...replay.wire, seal: { ...replay.wire.seal, contradiction: true } }), replayConflict],
    ["populated replay missing money", () => call(replay.base), replayConflict],
    ["populated replay with different canonical money", () => call({ ...replay.base, seal: { ...replay.seal, adapterMoneyResult: changedMoney } }),
      replayConflict],
    ["stale claim grant", () => call({ ...wire, claimToken: randomUUID() }),
      ["tax_claim_stale", "55000", "/claim", "Read the original evaluation outcome."]],
    ["erasure fence", () => call(erasure.wire),
      ["destination_evidence_erased", "55000", "/destination/snapshotRef", "Review the privacy disposition through authorized support."]],
    ["completion cutoff", () => call({ ...wire, seal: { ...wire.seal, validUntil: at(-1000) } }),
      ["tax_calculation_expired", "55000", "/taxEvidence/expiresAt", "Select the destination again and obtain a fresh quote."]],
    ["scoped provider reference collision", () => call(collision.wire),
      ["tax_provider_reference_conflict", undefined, "/taxEvidence", "Reconcile the original calculation with the tax adapter owner before further work."]],
    ["invalid pair at guarded insert", invalidFrame, ["tax_evaluation_frame_invalid", "23514", "/taxEvidence", undefined]],
    ["standalone clear of a terminal pair", clear,
      ["tax_evaluation_integrity_invalid", "55000", "/taxEvidence", "Recover the original evaluation from its authoritative owner."]],
    ["NULL service read ID", () => read(null, "READ COMMITTED"),
      ["tax_invalid_input", "22023", "/calculationId", "Supply the documented input."]],
    ["unsupported service read isolation", () => read(calculationId, "REPEATABLE READ"),
      ["destination_isolation_unsupported", "22023", "/transaction", "Use READ COMMITTED."]],
  ] as const;
  for (const [label, run, expected] of cases) expect(await observe(run), label).toStrictEqual(expected);
  expect(await row(pending.fixture)).toMatchObject({ state: "pending", contradiction: false });
  expect(await row(collision.fixture)).toMatchObject({ state: "terminal", adapter_money_text: null, adapter_result_digest: null });
});

it("commits only the winning claim generation when both grants carry valid money", async () => {
  const f = await installed({ basis: "exclusive", vector: 1660, adjust: true });
  f.now.deferSeal = true;
  await f.bind().createQuote(f.owner, f.request);
  const stale = f.commands.find(command => command.operation === "complete");
  expect(stale).toBeDefined();
  const original = await row(f);
  await takeover(f);
  f.now.deferSeal = false;
  f.now.alterReply = reply => changeAssessmentId(reply, "alternate-position");
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  const stored = await row(f);
  expect(stored).toMatchObject({ state: "terminal", generation: 2, calculation_id: original.calculation_id });
  expect(stored.adapter_money_text).toContain('"alternate-position"');
  expect(stored.adapter_result_digest).not.toBe(originalMoney(f).sealDigest);
  await expect(store.runtime.query("SELECT public.tax_calculation_complete_v1($1::jsonb)", [stale])).rejects.toMatchObject({
    code: "55000", message: "tax_claim_stale", detail: "/claim",
  });
  expect(await row(f)).toStrictEqual(stored);
  expect(q.taxEvidence.calculationId).toBe(stored.calculation_id);
});

it("validates the private wire in order, rolls back the pair and replays without a write", async () => {
  const f = await installed({ basis: "exclusive", vector: 1745, adjust: true });
  f.now.deferSeal = true;
  await f.bind().createQuote(f.owner, f.request);
  const wire = JSON.parse(JSON.stringify(f.commands.find(command => command.operation === "complete")));
  const { adapterMoneyResult: money, ...baseSeal } = wire.seal;
  const base = { ...wire, seal: baseSeal };
  const supplement = (value: unknown) => ({ ...wire, seal: { ...baseSeal, adapterMoneyResult: value } });
  const sql = "SELECT public.tax_calculation_complete_v1($1::jsonb) AS result";
  const call = (value: object) => store.runtime.query(sql, [value]).then(result => result.rows[0].result);
  const badSupplement = { code: "22023", message: "tax_invalid_input", detail: "/seal/adapterMoneyResult" };
  const state = await row(f);
  expect(state).toMatchObject({ state: "pending", adapter_money_text: null, adapter_result_digest: null });

  await expect(call(base)).rejects.toMatchObject(badSupplement);
  for (const value of [null, [], { ...money, payableMinor: "1745" }, { ...money, extra: true }])
    await expect(call(supplement(value))).rejects.toMatchObject(badSupplement);
  for (const edit of [
    (value: typeof money) => { value.components[0].final.taxMinor++; },
    (value: typeof money) => { value.components[0].allocations[0].sequence++; },
    (value: typeof money) => { value.components[0].initial.taxPositions[0].positionRef = "foreign-position"; },
    (value: typeof money) => { value.fees[0].feeKey = "foreign-fee"; },
  ]) {
    const value = structuredClone(money);
    edit(value);
    await expect(call(supplement(value))).rejects.toMatchObject(badSupplement);
  }
  await expect(call({ ...supplement(null), claimToken: randomUUID() })).rejects.toMatchObject({ code: "55000", detail: "/claim" });
  await expect(call({ ...wire, seal: { ...baseSeal, adapterMoneyResult: null, validUntil: at(-1000) } }))
    .rejects.toMatchObject({ code: "55000", message: "tax_calculation_expired", detail: "/taxEvidence/expiresAt" });
  await expect(call({ ...wire, seal: { ...baseSeal, adapterMoneyResult: money, evidence: null, disposition: "indeterminate",
    outcome: { kind: "indeterminate" }, contradiction: true } })).rejects.toMatchObject(badSupplement);
  await expect(store.runtime.query(sql, ['{"seal":{"adapterMoneyResult":"\\u0000"}}'])).rejects.toMatchObject({ code: "22P05" });
  await mutate(store, "public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb)",
    "'resultDigest',public.tax_calculation_hash_v1", "'resultDigest',repeat('g',64),'ignoredDigest',public.tax_calculation_hash_v1",
    async () => { await expect(call(wire)).rejects.toMatchObject(badSupplement); });
  expect(await row(f)).toStrictEqual(state);

  const fiscal = await installed();
  fiscal.now.deferSeal = true;
  await fiscal.bind().createQuote(fiscal.owner, fiscal.request);
  const fiscalWire = JSON.parse(JSON.stringify(fiscal.commands.find(command => command.operation === "complete")));
  await expect(call({ ...supplement(null), calculationId: fiscalWire.calculationId, claimToken: fiscalWire.claimToken }))
    .rejects.toMatchObject({ code: "55000", message: "tax_claim_stale", detail: "/claim" });
  await expect(call({ ...fiscalWire, seal: { ...fiscalWire.seal, adapterMoneyResult: money } })).rejects.toMatchObject(badSupplement);
  expect(await row(fiscal)).toMatchObject({ state: "pending", adapter_money_text: null, adapter_result_digest: null });
  expect(await call(fiscalWire)).toMatchObject({ kind: "terminal", outcome: { kind: "final" } });
  expect(await row(fiscal)).toMatchObject({ state: "terminal", adapter_money_text: null, adapter_result_digest: null });

  const db = await store.runtime.connect();
  try {
    await db.query("BEGIN");
    expect((await db.query(sql, [wire])).rows[0].result.kind).toBe("terminal");
    expect(await row(f)).toStrictEqual(state);
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await row(f)).toStrictEqual(state);

  const limit = 1_048_576 - Buffer.byteLength(canonicalCatalogDraftJson({ ...base, padding: "" }));
  const padding = "é".repeat(Math.floor(limit / 2)) + "x".repeat(limit % 2);
  expect(Buffer.byteLength(JSON.stringify({ ...wire, padding }))).toBeGreaterThan(1_048_576);
  await expect(call({ ...supplement(null), padding: padding + "x" })).rejects.toMatchObject({ code: "22023", detail: "/" });
  const [terminal, concurrent] = await Promise.all([call({ ...wire, padding }), call(wire)]);
  expect(concurrent).toStrictEqual(terminal);
  const version = async () => (await store.owner.query("SELECT xmin::text FROM public.tax_calculations WHERE calculation_id=$1",
    [wire.calculationId])).rows[0];
  const written = await version();
  expect(await call(wire)).toStrictEqual(terminal);
  const altered = structuredClone(money);
  altered.components[0].initial.taxPositions[0].positionRef += "-other";
  for (const candidate of [base, supplement(altered), { ...supplement(null), seal: { ...supplement(null).seal, contradiction: true } }])
    await expect(call(candidate)).rejects.toMatchObject({ code: "22023", message: "tax_reference_conflict", detail: "/taxEvidence" });
  await expect(call(supplement(null))).rejects.toMatchObject(badSupplement);
  expect(await version()).toStrictEqual(written);
});

it("recovers a committed money seal after the completion acknowledgement is lost", async () => {
  const f = await installed({ basis: "exclusive", vector: 1660, adjust: true });
  f.now.sealFailure = new Error("Scripted lost commit acknowledgment");
  const q = quote(await f.bind().createQuote(f.owner, f.request));
  const stored = await row(f);
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "claim", "complete", "lookup"]);
  expect(await readMoney(q.taxEvidence.calculationId)).toStrictEqual({
    calculationId: q.taxEvidence.calculationId, status: "final", ...originalMoney(f),
  });
  expect(await f.bind().createQuote(f.owner, f.request)).toStrictEqual({ kind: "quoted", quote: q, freshness: "current" });
  expect(f.taxInputs).toHaveLength(1);
  expect(await row(f)).toStrictEqual(stored);
});

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
  let change = "document_digest=repeat('1',64)";
  f.deps.destination.snapshot = async (...args) => {
    const issued = await initial(...args);
    if ("binding" in issued) await store.owner.query(
      `UPDATE public.commerce_destination_v2_documents SET ${change} WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
    return issued;
  };
  exact(await f.bind().createQuote(f.owner, f.request),
    refusal("destination_digest_mismatch", "/destination/destinationDigest", "Replay the original document and its digest."));
  change = "purpose=NULL,evidence_expires_at=issued_at";
  exact(await f.bind().createQuote(f.owner, { ...f.request, key: randomUUID() }),
    refusal("commerce_destination_owner_mismatch", "/destination/snapshotRef", "Re-obtain evidence through the authenticated owner."));
  expect(f.commands.map(command => command.operation)).toEqual(["lookup", "lookup"]);
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
  expect(stored).toMatchObject({ contradiction: true, state: "terminal", adapter_money_text: null, adapter_result_digest: null });
  expect(stored.outcome_text).not.toMatch(/discard|vector|observations\/123/u);
  exact(await f.bind().createQuote(f.owner, f.request), expected);
  expect(await row(f)).toStrictEqual(stored);
});

it.each(["dependencies", "claim", "claimAck", "adapter", "seal", "recoveryRead"] as const)(
  "fences independently delayed %s", async stage => {
    const f = await installed({ basis: "exclusive", cutoff: "short" });
    f.now.pauseUntil = f.now.quoteCutoff;
    if (stage === "recoveryRead") {
      f.now.taxFailure = noDispatch;
      exact(await f.bind().createQuote(f.owner, f.request), pending);
      await takeover(f);
      f.now.taxFailure = undefined;
    }
    f.now.timing = stage;
    const result = await f.bind().createQuote(f.owner, f.request);
    exact(result, expired);
    expect((await row(f))?.outcome_text ?? null).toBeNull();
    expect(f.taxInputs).toHaveLength(["seal", "adapter", "recoveryRead"].includes(stage) ? 1 : 0);
  }, 12_000,
);

it.each(["sealAck", "lookup"] as const)("fences independently delayed %s", async stage => {
  const f = await installed({ basis: "exclusive" });
  const port = f.bind();
  const original = stage === "lookup" ? await port.createQuote(f.owner, f.request) : undefined;
  if (original) expect(original).toMatchObject({ kind: "quoted", freshness: "current" });
  const acknowledge = vi.fn((_stage: TerminalAck, validUntil: string) => {
    vi.setSystemTime(new Date(validUntil));
  });
  f.now.onTerminalAck = acknowledge;
  let result: QuoteOutcome;
  try { result = await port.createQuote(f.owner, f.request); }
  finally { vi.useRealTimers(); }
  expect(result).toMatchObject({ kind: "quoted", freshness: "historical" });
  const historical = quote(result);
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(stage, historical.taxEvidence.expiresAt);
  if (original) expect(historical).toStrictEqual(quote(original));
  expect((await row(f)).state).toBe("terminal");
  expect(f.taxInputs).toHaveLength(1);
});

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
  const stored = await row(f);
  expect(stored.outcome_text).not.toContain("vector");
  expect(stored).toMatchObject({ adapter_money_text: null, adapter_result_digest: null });
  expect(f.taxInputs).toHaveLength(1);
});

it("keeps unqualified refusals fenced even when they carry coverage data", async () => {
  const f = await installed({ basis: "exclusive" });
  f.now.qualified = false;
  f.now.taxFailure = { kind: "refused", code: "tax_coverage_inconsistent", field: "/observations",
    remedy: "discard", coverage: { digest: "3".repeat(64), vector: [] } };
  exact(await f.bind().createQuote(f.owner, f.request), pending);
  expect(await row(f)).toMatchObject({ state: "pending", outcome_text: null, contradiction: false,
    adapter_money_text: null, adapter_result_digest: null });
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
    const stored = await row(f);
    const [, terminal] = JSON.parse(stored.outcome_text);
    expect(terminal.disposition).toBe(disposition);
    expect(stored).toMatchObject({ adapter_money_text: originalMoney(f).adapterMoneyText, adapter_result_digest: originalMoney(f).sealDigest });
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
