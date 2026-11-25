import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { applyTaxCoverageRevision, evaluationDigest, makeTaxQuoteRequest } from "@openlup/platform/tax";
import type { TaxQuoteInputV1 } from "@openlup/platform/tax/contracts";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { destinationContext, destinationHash, snapshot, snapshotCommand, testServicePin } from "./destinationDocumentFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("quote-storage"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const digest = "ab".repeat(32);
const quoteDigest = (tag: "commerce.quote.v2" | "commerce.quote-money.v2", body: unknown) =>
  destinationHash(canonicalCatalogDraftJson([tag, body]));
const taxDate = "2026-06-05T10:00:00.000Z";
const coverageTag = { kind: "not_applicable" };
const fiscalKind = "fiscal_profile";
const exclusiveKind = "tax_calculation";
type Kind = typeof fiscalKind | typeof exclusiveKind;
type Db = Pool | PoolClient;
type Claim = {
  kind: "claimed"; calculationId: string; generation: number; claimToken: string;
  pin: { requestDigest: string; invocationDigest: string };
};
type Refusal = { kind: "refused" | "unavailable"; code: string; field: string; remedy: string; effect?: "none" };
const fiscalFacts = { country: "XA", category: "standard", vatRateBps: 0, legalBasis: "policy-a" };
const refs = { taxClassKey: "class-a", assignmentRef: "assignment-a" };
const cadence = { schemaVersion: 1, kind: "fixed_days", days: 30 };
const line = { lineKey: "item-a", sku: "item-a", mode: "subscription", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 100, ...refs };
const cost = { ref: "cost-a", currency: "XXX", amountMinor: 2 };
const shipping = { ...refs, bucketKey: "shipping-a", kind: "shipping", carrierRef: "carrier-a", serviceRef: "service-a",
  cost, separatelyStated: true };
const fee = { feeKey: "fee-a", jurisdictionRef: "district-a", feeKind: "fee-kind", amountMinor: 3,
  scope: { kind: "delivery", bucketKey: shipping.bucketKey }, refundRule: { ref: "rule-a", revision: "revision-a" },
  providerPositionRef: "provider-position-a" };
const price = { priceListRef: "list-a", priceContextDigest: digest, priceEvidenceRef: "price-a", classMapRevision: "classes-a" };

async function fixture() {
  const ctx = await destinationContext(store.owner);
  const issued = await snapshot(store.runtime, ctx);
  const { address } = snapshotCommand(ctx).command.validated;
  const { installationRef, principalRef } = ctx.owner;
  const accountRef = "account-" + randomUUID();
  const effective = { from: taxDate, until: "2099-06-05T10:00:00.000Z" };
  const declaration = { jurisdiction: "district-a", taxKind: "sale", status: "registered" as const,
    actorRef: "actor-a", recordedAt: taxDate, effective };
  const coverage = { schemaVersion: 1 as const, accountRef, revision: "coverage-a", declarations: [declaration] };
  const installed = await applyTaxCoverageRevision(store.owner, {
    expectedHead: null, document: { installationRef, accountRef, coverage, actorRef: "fixture" },
  });
  expect(installed).toHaveProperty("coverageDigest");
  if (!("coverageDigest" in installed)) throw new Error("Expected a coverage revision");
  const coverageDigest = installed.coverageDigest;
  const cell = { target: { kind: "line", key: line.lineKey }, jurisdiction: "district-a",
    level: "district", taxKind: "sale", sourcing: "destination" } as const;
  const { lineKey, sourceOrdinal, quantity, unitBasisMinor } = line;
  const fullInput: TaxQuoteInputV1 = {
    scope: { adapter: "adapter-a", adapterVersion: "1", accountRef, mode: "test" },
    market: "market-a", currency: "XXX", purpose: "final", taxDate, shipFromRef: "origin-a",
    policyRevision: "policy-a", classMapRevision: "classes-a",
    destination: { snapshotRef: issued.binding.snapshotRef, digest: issued.binding.destinationDigest,
      policyRevision: issued.binding.policyRevision, address },
    money: { amountBasis: "exclusive", sources: [{ lineKey, sourceOrdinal, quantity, unitBasisMinor }],
      delivery: [{ bucketKey: shipping.bucketKey, deliveryKind: "shipping", amountMinor: 2 }],
      adjustments: [{ adjustmentRef: "discount-a", sequence: 1, amountMinor: 1, target: { lineKeys: [lineKey] } },
        { adjustmentRef: "discount-b", sequence: 2, amountMinor: 1, target: { bucketKey: shipping.bucketKey } }], fees: [] },
    lines: [{ lineKey, sku: line.sku, mode: "subscription", taxClass: refs.taxClassKey, assignmentRef: refs.assignmentRef }],
    delivery: [{ bucketKey: shipping.bucketKey, carrierRef: shipping.carrierRef, serviceRef: shipping.serviceRef,
      cost, separatelyStated: true, taxClass: refs.taxClassKey, assignmentRef: refs.assignmentRef }],
    required: [cell, { ...cell, target: { kind: "delivery", key: shipping.bucketKey } }], coverage,
  };
  const validUntil = issued.evidenceExpiresAt;
  const invocation = { purpose: "final", mode: "subscription", cadence, lines: [{ sku: line.sku, quantity: 1 }],
    deliverySelector: "delivery-a", paymentSelector: "payment-a" };
  function compose(kind: Kind) {
    const basis = kind === fiscalKind ? "inclusive" : "exclusive";
    const candidate = { amountBasis: basis, deliverySelectionRef: testServicePin.deliverySelectionRef,
      delivery: [{ ...shipping, amountMinor: 2, threshold: { flatMinor: 2, freeThresholdMinor: 500 } }], feeLines: [fee] };
    return { catalogueEvidenceRef: "catalogue-a", evidenceExpiresAt: issued.evidenceExpiresAt, selection: issued.selection,
      service: testServicePin,
      limits: { installationRef, channelKey: "channel-a", methodKey: "method-a", providerKey: "provider-a",
        accountRef: "payment-account-a", mode: "test", currency: "XXX", profileRef: "limits-a", revision: 42,
        minMinor: 0, maxMinor: 1000, effective: { minMinor: 1, maxMinor: 500 } },
      planInput: { currency: "XXX", listBasis: basis, price, engine: "promotion-engine.v1",
        lines: [{ ...line, amountKind: kind === fiscalKind ? "gross" : "net" }], baseline: candidate,
        selected: { ...candidate, adjustments: [
          { amountOffMinor: 1, adjustmentRef: "discount-a", evidenceRef: "rule-a", appliesTo: "line", target: { lineKeys: [lineKey] } },
          { amountOffMinor: 1, adjustmentRef: "discount-b", evidenceRef: "rule-b", appliesTo: "shipping",
            target: { bucketKey: shipping.bucketKey } },
        ] } },
      ...(kind === fiscalKind ? { fiscal: { facts: fiscalFacts,
        coordinates: { installationRef, marketRef: "market-a", packId: "pack-a", packVersion: "1" } } } : {}) };
  }
  function begin(kind: Kind, extended: boolean, evaluationKey: string = randomUUID()) {
    const identity = { installationRef, principalRef, clientId: ctx.clientId, scopeRef: ctx.scopeRef, evaluationKey };
    const fullRequest = kind === fiscalKind ? { basis: "inclusive", taxDate } : makeTaxQuoteRequest(evaluationKey, fullInput);
    const { address: _address, ...destination } = fullInput.destination;
    const request = "input" in fullRequest
      ? { ...fullRequest, input: { ...fullRequest.input, destination } } : fullRequest;
    const recovery = kind === fiscalKind ? null : digest;
    const pin = { destination: issued.binding, request, requestDigest: evaluationDigest("evaluation-request", fullRequest),
      kind, validUntil, coverage: kind === fiscalKind ? null : { accountRef, revision: coverage.revision, digest: coverageDigest },
      recovery, ...(extended ? { composition: compose(kind) } : {}) };
    return { operation: "claim", identity, invocation, pin, recovery };
  }
  function adapterEvidence(evaluationKey: string, providerRef: string) {
    const request = makeTaxQuoteRequest(evaluationKey, fullInput);
    const resolution = { assignmentRef: refs.assignmentRef, policyRevision: fullInput.policyRevision,
      sourceRef: "source-a", sourceDigest: digest, effective };
    return { requestKey: evaluationKey, scope: fullInput.scope, calculationRef: providerRef, status: "final",
      calculatedAt: taxDate, expiresAt: validUntil, taxDate, destinationDigest: issued.binding.destinationDigest,
      shipFromRef: fullInput.shipFromRef, inputDigest: request.inputDigest, policyRevision: fullInput.policyRevision,
      classMapRevision: fullInput.classMapRevision, fiscalDigest: digest, providerLines: [{ lineKey, providerLineRef: "provider-line" }],
      coverage: { digest, vector: [{ cell, decision: "in_scope_taxed", declaration,
        registration: { state: "active", effective, evidenceRef: "registration-a" },
        treatment: { kind: "taxable", reason: "registered", ruleRef: "rule-a" } }] },
      positions: { tax: [{ positionRef: "position-a", taxabilityReason: "registered", ruleRef: "rule-a", cell, resolution,
        resolutionDigest: digest, ratePercent: "0", providerLineRef: "provider-line" }],
        fees: [{ feeKey: fee.feeKey, jurisdiction: fee.jurisdictionRef, feeKind: fee.feeKind,
          scope: { kind: "delivery", key: shipping.bucketKey }, refundRule: fee.refundRule, providerPositionRef: fee.providerPositionRef }] } };
  }
  return { ctx, issued, begin, adapterEvidence };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Begin = ReturnType<Fixture["begin"]>;
const beginSql = "SELECT public.tax_calculation_begin_v1($1::jsonb) AS value";
const completeSql = "SELECT public.tax_calculation_complete_v1($1::jsonb) AS value";

async function invoke<T>(db: Db, sql: string, wire: object) {
  return (await db.query<{ value: T }>(sql, [wire])).rows[0]!.value;
}
async function claim(input: Begin, db: Db = store.runtime) {
  const result = await invoke<Claim>(db, beginSql, input);
  expect(result).toMatchObject({ kind: "claimed", generation: 1 });
  return result;
}

function seal(value: Fixture, input: Begin, grant: Claim, extended = Boolean(input.pin.composition), providerRef: string = randomUUID()) {
  const calc = grant.calculationId;
  const { destination, kind, requestDigest, validUntil, composition } = input.pin;
  const fiscal = kind === fiscalKind;
  const pin = composition ?? value.begin(kind, true).pin.composition!;
  const disposition = fiscal ? "no_provider_posting" : "required";
  const adapterEvidence = value.adapterEvidence(input.identity.evaluationKey, providerRef);
  const evidence = fiscal
    ? extended ? { ...pin.fiscal, policyRevision: evaluationDigest("fiscal-profile", [pin.fiscal!.facts, pin.fiscal!.coordinates]),
      calculationId: calc, coverage: coverageTag, posting: disposition, compositionDigest: evaluationDigest("evaluation-composition", pin) }
      : { policyRevision: "legacy-revision", posting: disposition }
    : { adapterEvidence, adapterDigest: digest,
      ...(extended ? { compositionDigest: evaluationDigest("evaluation-composition", pin) } : {}) };
  const limits = pin.limits;
  const paymentLimits = { profileRef: limits.profileRef, revision: extended ? String(limits.revision) : "legacy-revision",
    channelKey: limits.channelKey, currency: limits.currency, ...limits.effective };
  const position = { positionRef: "position-a", jurisdictionRef: "district-a", level: "district", taxKind: "sale",
    taxabilityReason: "registered", ruleRef: "rule-a", resolution: { assignmentRef: refs.assignmentRef, policyRevision: "policy-a",
      sourceRef: "source-a", sourceDigest: digest, effective: { from: taxDate, until: "2099-06-05T10:00:00.000Z" } },
    resolutionDigest: digest, providerLineRef: "provider-line", rateDecimal: "0", taxableMinor: 99, taxMinor: 0 };
  const moneyState = (basisMinor: number) => ({ basisMinor, netMinor: basisMinor, taxMinor: 0,
    taxPositions: [{ ...position, taxableMinor: basisMinor }] });
  const component = (base: number) => ({ preDiscountMinor: base, effectiveMinor: base - 1, netMinor: base - 1, taxMinor: 0,
    lineTotalMinor: base - 1, taxPositions: [{ ...position, taxableMinor: base - 1 }],
    discountAllocations: [{ allocationId: randomUUID(), adjustmentRef: "discount-a", sequence: 1, source: "legacy_promotion",
      basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0, evidenceRef: "rule-a",
      before: moneyState(base), after: moneyState(base - 1) }] });
  const unsigned = { catalogueEvidenceRef: pin.catalogueEvidenceRef, mode: "subscription", cadence, currency: "XXX", destination, paymentLimits, price,
    deliverySelectionRef: pin.service.deliverySelectionRef, amountBasis: fiscal ? "inclusive" : "exclusive",
    coverageDigest: fiscal && extended ? evaluationDigest("fiscal-coverage", coverageTag) : digest,
    promotion: { engine: "promotion-engine.v1", rankingRuleRef: fiscal ? "lowest_payable_gross" : "lowest_pre_tax.v1" },
    lines: [{ ...line, ...component(100) }], deliveryBuckets: [{ ...shipping, parts: [{ ...component(2), sourceOrdinal: 2 }] }],
    feeLines: [fee], netTotal: 100, taxTotal: 0, feeTotal: 3, payableMinor: 103,
    taxEvidence: { kind, taxDate, calculationId: calc, expiresAt: validUntil, evidenceDigest: "" } };
  const envelope = { calculationId: calc, invocationDigest: grant.pin.invocationDigest, requestDigest, generation: grant.generation,
    destination, kind, evidence, disposition, validUntil };
  const quote = { ...unsigned, taxEvidence: { ...unsigned.taxEvidence, evidenceDigest: evaluationDigest("evaluation-evidence", envelope) } };
  const status = input.invocation.purpose;
  const inner = { ...quote, quoteId: randomUUID(), status, schemaVersion: 2, contractVersion: "commerce.v1",
    moneyDigest: quoteDigest("commerce.quote-money.v2", quote) };
  const outcome = { kind: status, quote: { ...inner, quoteDigest: quoteDigest("commerce.quote.v2", inner) } };
  return { identity: input.identity, invocation: input.invocation, operation: "complete", calculationId: calc,
    generation: grant.generation, claimToken: grant.claimToken,
    seal: { destination, kind, requestDigest, validUntil, contradiction: false, disposition, evidence, outcome } };
}

function refusal(input: Begin, grant: Claim, outcome: Refusal) {
  const { destination, kind, requestDigest, validUntil } = input.pin;
  return { identity: input.identity, invocation: input.invocation, operation: "complete", calculationId: grant.calculationId,
    generation: grant.generation, claimToken: grant.claimToken, seal: { destination, kind, requestDigest, validUntil,
      contradiction: outcome.code === "tax_coverage_inconsistent", disposition: outcome.kind, evidence: null, outcome } };
}

const rowFor = async (input: Begin) => (await store.owner.query<{ row: unknown }>(
  "SELECT to_jsonb(r) AS row FROM public.tax_calculations r WHERE identity=$1", [input.identity])).rows;
const rawErrorKeys = ["length", "name", "message", "severity", "code", "detail", "hint", "position", "internalPosition", "internalQuery",
  "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine"].sort();

function expectError(error: unknown, message: string, detail: string | undefined, code = "22023") {
  expect(Object.getPrototypeOf(error)).toBe(DatabaseError.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toStrictEqual(rawErrorKeys);
  expect(error).toMatchObject({ message, detail, code,
    hint: message === "tax_invalid_input" && detail && ["/pin", "/seal", "/identity"].includes(detail) ? "Supply the documented input." : undefined });
}

const rejected = (db: Db, sql: string, wire: object) =>
  invoke(db, sql, wire).then(() => { throw new Error("Expected SQL refusal"); }, error => error);

async function rollback<T>(work: (runtime: PoolClient) => Promise<T>) {
  const db = await store.runtime.connect();
  try { await db.query("BEGIN"); return await work(db); }
  finally { await db.query("ROLLBACK"); db.release(); }
}

const domainRoutine = "public.tax_calculation_check_domain_v1(jsonb,jsonb,jsonb,boolean)";
const terminalRoutine = "public.tax_calculation_terminal_v1(public.tax_calculations)";
async function mutate(signature: string, before: string, after: string, witness: () => Promise<void>) {
  const { rows: [row] } = await store.owner.query<{ definition: string }>(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature]);
  expect(row!.definition).toContain(before);
  await store.owner.query(row!.definition.replace(before, after));
  try { await witness(); }
  finally { await store.owner.query(row!.definition); }
}

async function exactReplay(input: Begin, command: { seal: { outcome: object; validUntil: string } }) {
  const expected = { kind: "terminal", outcome: command.seal.outcome, validUntil: command.seal.validUntil };
  expect(await invoke(store.runtime, completeSql, command)).toStrictEqual(expected);
  const rows = await rowFor(input);
  expect(rows).toHaveLength(1);
  expect(await invoke(store.runtime, completeSql, command)).toStrictEqual(expected);
  const lookup = { operation: "lookup", identity: input.identity, invocation: input.invocation };
  expect(await invoke(store.runtime, beginSql, lookup)).toStrictEqual(expected);
  expect(await rowFor(input)).toStrictEqual(rows);
}

const arms = [
  { kind: fiscalKind, extended: false }, { kind: exclusiveKind, extended: false },
  { kind: fiscalKind, extended: true }, { kind: exclusiveKind, extended: true },
] as const;

it("seals and replays both success kinds in both wire versions through the restricted login", async () => {
  expect((await store.runtime.query("SELECT session_user, current_user")).rows).toStrictEqual([
    { session_user: "transfer_runtime", current_user: "transfer_runtime" },
  ]);
  const value = await fixture();
  for (const { kind, extended } of arms) {
    const input = value.begin(kind, extended);
    const grant = await claim(input);
    await exactReplay(input, seal(value, input, grant));
  }
});

it("rejects both mixed-version directions at the seal with no changes", async () => {
  const value = await fixture();
  const cases: { input: Begin; bad: Completion; good: Completion }[] = [];
  for (const { kind, extended } of arms) {
    const input = value.begin(kind, extended);
    const grant = await claim(input);
    cases.push({ input, bad: seal(value, input, grant, !extended), good: seal(value, input, grant) });
  }
  // Temporarily disabled seal shape admission in the disposable database.
  await mutate(domainRoutine, "EXISTS (SELECT FROM invalid_shapes WHERE field = '/seal')", "false", async () => {
    for (const { bad } of cases) {
      const reply = await rollback(db => invoke(db, completeSql, bad).catch((error: unknown) => error));
      if (reply instanceof DatabaseError) expect(reply.detail).not.toBe("/seal");
      else expect(reply).toHaveProperty("kind", "terminal");
    }
  });
  for (const { input, bad, good } of cases) {
    const before = await rowFor(input);
    expectError(await rejected(store.runtime, completeSql, bad), "tax_invalid_input", "/seal");
    expect(await rowFor(input)).toStrictEqual(before);
    await exactReplay(input, good);
  }
});

type JsonPath = (string | number)[];
function paths(node: unknown, path: JsonPath = []): { path: JsonPath; object: boolean }[] {
  if (Array.isArray(node)) return node.length === 0 ? [{ path: [...path, 0], object: false }]
    : node.flatMap((item: unknown, i) => paths(item, [...path, i]));
  if (node !== null && typeof node === "object") return [{ path, object: true },
    ...Object.entries(node).flatMap(([key, item]) => paths(item, [...path, key]))];
  return [{ path, object: false }];
}
function contaminate<T>(wire: T, root: JsonPath, target: { path: JsonPath; object: boolean }, key: string) {
  // A serialized wire has separate nodes even when the fixture reuses an object.
  const modified = JSON.parse(JSON.stringify(wire)) as T;
  const path = [...root, ...target.path];
  const parent = path.slice(0, -1).reduce<unknown>((node, part) => (node as Record<string | number, unknown>)[part], modified);
  const member = path.at(-1)!;
  const object = parent as Record<string | number, unknown>;
  object[member] = target.object ? { ...(object[member] as object), [key]: "private-text" } : { [key]: "private-text" };
  return modified;
}

it("closes both versions of every persisted caller JSON object and scalar slot", async () => {
  const value = await fixture();
  // Temporarily disabled pin shape admission in the disposable database.
  const baseline = value.begin(fiscalKind, true);
  for (const key of ["contactEmail", "line1"]) {
    const bad = contaminate(baseline, ["pin"], { path: ["composition", "planInput", "lines", 0], object: true }, key);
    await mutate(domainRoutine, "EXISTS (SELECT FROM invalid_shapes WHERE field = '/pin')", "false", async () => {
      await rollback(db => claim(bad, db));
    });
  }
  for (const { kind, extended } of arms) {
    const input = value.begin(kind, extended);
    for (const [root, detail] of [["identity", "/identity"], ["pin", "/pin"]] as const) {
      for (const target of paths(input[root])) for (const key of ["contactEmail", "line1"]) {
        const bad = contaminate(input, [root], target, key);
        expectError(await rejected(store.runtime, beginSql, bad), "tax_invalid_input",
          root === "identity" && !target.object && ["clientId", "principalRef", "scopeRef"].includes(String(target.path[0]))
            ? detail + "/" + target.path[0] : detail);
      }
    }
    expect(await rowFor(input)).toStrictEqual([]);
    const grant = await claim(input);
    const valid = seal(value, input, grant);
    const before = await rowFor(input);
    const refused = refusal(input, grant, { kind: "refused", code: "tax_calculation_expired",
      field: "/taxEvidence/expiresAt", remedy: "Select the destination again and obtain a fresh quote." });
    const unavailable = refusal(input, grant, { kind: "unavailable", code: "tax_adapter_unavailable",
      field: "/taxEvidence", remedy: "Request a new quote when the tax service is available.", effect: "none" });
    const indeterminate = { ...refused, seal: { ...refused.seal, disposition: "indeterminate", outcome: { kind: "indeterminate" } } };
    for (const command of [valid, refused, unavailable, indeterminate]) {
      const root = command === valid ? [] : ["outcome"];
      const node = command === valid ? command.seal : command.seal.outcome;
      for (const target of paths(node)) for (const key of ["contactEmail", "line1"]) {
        const bad = contaminate(command, ["seal", ...root], target, key);
        expectError(await rejected(store.runtime, completeSql, bad), "tax_invalid_input", "/seal");
      }
      if (command !== valid) for (const key of ["contactEmail", "line1"]) {
        const bad = contaminate(command, ["seal"], { path: ["evidence"], object: false }, key);
        expectError(await rejected(store.runtime, completeSql, bad), "tax_invalid_input", "/seal");
      }
    }
    expect(await rowFor(input)).toStrictEqual(before);
    await exactReplay(input, valid);
  }
}, postgresSetupTimeoutMs);

const cases = [
  [false, "refused", "tax_provider_reference_conflict", "/taxEvidence", "Reconcile the original calculation with the tax adapter owner before further work."],
  [false, "refused", "tax_evaluation_integrity_invalid", "/taxEvidence", "Recover the original evaluation from its authoritative owner."],
  [false, "refused", "tax_calculation_expired", "/taxEvidence/expiresAt", "Select the destination again and obtain a fresh quote."],
  [false, "refused", "commerce_destination_owner_mismatch", "/destination/snapshotRef", "Re-obtain evidence through the authenticated owner."],
  [false, "refused", "destination_digest_mismatch", "/destination/destinationDigest", "Replay the original document and its digest."],
  [false, "refused", "tax_reference_conflict", "/coverage", "Recover the verified original history through its owner."],
  [false, "unavailable", "tax_adapter_unavailable", "/taxEvidence", "Request a new quote when the tax service is available."],
  [false, "unavailable", "tax_coverage_evidence_unavailable", "/taxEvidence", "Request a new quote when the tax service is available."],
  [true, "refused", "tax_invalid_input", "/input", "Correct the documented quote input and obtain a fresh quote."],
  [true, "refused", "tax_invalid_input", "/coverage/declarations", "Have the coverage owner correct the declarations under /coverage/declarations, then obtain a fresh quote."],
  [true, "refused", "tax_invalid_input", "/required", "Have the coverage owner supply valid required coverage within the evidence limit under /required, then obtain a fresh quote."],
  [true, "refused", "tax_invalid_input", "/now", "Have the quote host supply a supported tax clock and obtain a fresh quote."],
  [true, "refused", "tax_scope_mismatch", "/input/scope", "Use the authorized tax binding for the original scope, market and currency."],
  [true, "refused", "tax_scope_mismatch", "/input/money/amountBasis", "Use the inclusive quote path for an inclusive price list or obtain an exclusive quote on the published exclusive basis."],
  [true, "refused", "tax_scope_mismatch", "/coverage/accountRef", "Recover the original coverage history for the authorized tax account."],
  [true, "refused", "tax_scope_mismatch", "/taxEvidence", "Have the tax adapter owner reconcile the calculation account, mode and sourcing with the authorized tax binding, then obtain a fresh quote."],
  [true, "refused", "tax_class_missing", "/input/lines", "Have the coverage owner supply the required tax class mapping for /input/lines, then obtain a fresh quote."],
  [true, "refused", "tax_class_missing", "/input/delivery", "Have the coverage owner supply the required tax class mapping for /input/delivery, then obtain a fresh quote."],
  [true, "refused", "tax_class_missing", "/input/required", "Have the coverage owner supply the required tax class mapping for /input/required, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/input/required", "Have the coverage owner supply an effective rule or explicit exemption for /input/required, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/input/policyRevision", "Have the coverage owner recover the rules for the original policy revision before requesting another quote."],
  [true, "refused", "tax_rule_missing", "/input/classMapRevision", "Have the coverage owner recover the original class map before requesting another quote."],
  [true, "refused", "tax_rule_missing", "/input/shipFromRef", "Have the coverage owner qualify the original shipping origin for /input/shipFromRef, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/input/destination/address/subdivisionCode", "Have the coverage owner qualify the destination subdivision for /input/destination/address/subdivisionCode, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/calculation/tax_breakdown", "Have the coverage owner qualify the fee and jurisdiction rules for /calculation/tax_breakdown, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/calculation/shipping_cost/tax_breakdown", "Have the coverage owner qualify the shipping jurisdiction and tax rule for /calculation/shipping_cost/tax_breakdown, then obtain a fresh quote."],
  [true, "refused", "tax_rule_missing", "/line_items", "Have the coverage owner qualify the merchandise jurisdiction and tax rules for /line_items, then obtain a fresh quote."],
  [true, "refused", "tax_coverage_undeclared", "/coverage/declarations", "Have the coverage owner supply the required effective declarations under /coverage/declarations, then obtain a fresh quote."],
  [true, "refused", "tax_coverage_inconsistent", "/observations", "Have the coverage owner reconcile registration, treatment and assessment for /observations, then obtain a fresh quote."],
  [true, "refused", "tax_breakdown_incomplete", "/taxEvidence", "Have the tax adapter owner resolve the incomplete calculation breakdown, then obtain a fresh quote."],
  [true, "refused", "tax_amount_out_of_range", "/input/money", "Use supported basket amounts, including the combined basis, and obtain a fresh quote."],
  [true, "refused", "tax_amount_out_of_range", "/taxEvidence", "Recover the original calculation with authoritative amounts within the supported range before requesting another quote."],
  [true, "refused", "tax_reference_conflict", "/taxEvidence", "Have the tax adapter owner resolve the conflicting request or response binding, then obtain a fresh quote."],
  [true, "refused", "tax_calculation_unusable", "/taxEvidence", "Have the tax coverage owner supply coverage supported by effective observations, then obtain a fresh quote."],
  [true, "refused", "tax_operation_unsupported", "/input/taxDate", "Use a whole-second UTC tax instant on or after the Unix epoch."],
  [true, "refused", "tax_operation_unsupported", "/input/money/sources", "Use at least one merchandise line and keep every merchandise amount positive before and after discounts."],
  [true, "refused", "tax_operation_unsupported", "/input/money/delivery", "Use at most one shipping bucket and no handling buckets."],
  [true, "refused", "tax_operation_unsupported", "/input/delivery/0", "Use a qualified delivery service and matching cost currency."],
  [true, "refused", "tax_operation_unsupported", "/input/money/delivery/0", "Use a qualified zero-shipping route, supply independent inactivity evidence, or use a supported positive shipping charge."],
  [true, "refused", "tax_operation_unsupported", "/input/money/adjustments", "Use the undiscounted basket or a qualified promotion that fits the selected tax route."],
  [true, "refused", "tax_operation_unsupported", "/calculation/tax_breakdown", "Use a qualified calculation route for this tax breakdown."],
  [true, "refused", "tax_operation_unsupported", "/calculation/shipping_cost/tax_breakdown", "Use a qualified calculation route for the shipping breakdown."],
  [true, "refused", "tax_operation_unsupported", "/line_items", "Use a qualified calculation route for the merchandise breakdown."],
  [true, "refused", "tax_adapter_response_invalid", "/taxEvidence", "Resolve the unrecognised response with the tax adapter owner before requesting a new quote."],
] as const;

it("admits each exact terminal tuple only on its allowed arms and replays its exact outcome", async () => {
  const value = await fixture();
  const input = value.begin(exclusiveKind, true);
  const grant = await claim(input);
  const [, kind, code, field, remedy] = cases[8]!;
  const positive = refusal(input, grant, { kind, code, field, remedy });
  // Temporarily disabled the extended-exclusive case filter in the disposable database.
  await mutate(terminalRoutine, "(composition_present AND r.pin->>'kind'='tax_calculation')", "false", async () => {
    expectError(await rejected(store.runtime, completeSql, positive), "tax_reference_conflict", "/taxEvidence");
  });
  // Temporarily disabled literal remedy matching in the disposable database.
  const changed = refusal(input, grant, { kind, code, field, remedy: "Changed remedy." });
  await mutate(terminalRoutine, "outcome->'remedy' IS DISTINCT FROM to_jsonb(approved_remedy)", "false", () =>
    mutate(terminalRoutine, "'remedy',approved_remedy", "'remedy',outcome->'remedy'", async () => {
      expect(await rollback(db => invoke(db, completeSql, changed))).toHaveProperty("outcome.remedy", "Changed remedy.");
    }));
  expectError(await rejected(store.runtime, completeSql, changed), "tax_reference_conflict", "/taxEvidence");

  for (const [extendedOnly, kind, code, field, remedy] of cases) {
    const outcome: Refusal = { kind, code, field, remedy, ...(kind === "unavailable" ? { effect: "none" } : {}) };
    for (const arm of arms) {
      const input = value.begin(arm.kind, arm.extended);
      const grant = await claim(input);
      const before = await rowFor(input);
      for (const wrong of [{ ...outcome, field: field + "/0" }, { ...outcome, remedy: remedy + " Changed." }]) {
        expectError(await rejected(store.runtime, completeSql, refusal(input, grant, wrong)), "tax_reference_conflict", "/taxEvidence");
      }
      const command = refusal(input, grant, outcome);
      expect(await rowFor(input)).toStrictEqual(before);
      if (extendedOnly && !(arm.extended && arm.kind === exclusiveKind)) {
        expectError(await rejected(store.runtime, completeSql, command), "tax_reference_conflict", "/taxEvidence");
        expect(await rowFor(input)).toStrictEqual(before);
      } else {
        if (code === "tax_coverage_inconsistent") {
          const unmarked = { ...command, seal: { ...command.seal, contradiction: false } };
          // Temporarily disabled the contradiction requirement in the disposable database.
          await mutate(terminalRoutine, "(outcome->>'code'='tax_coverage_inconsistent' AND NOT r.contradiction)", "false",
            async () => { expect(await rollback(db => invoke(db, completeSql, unmarked))).toHaveProperty("outcome", outcome); });
          expectError(await rejected(store.runtime, completeSql, unmarked), "tax_reference_conflict", "/taxEvidence");
          expect(await rowFor(input)).toStrictEqual(before);
        }
        await exactReplay(input, command);
        if (code === "tax_coverage_inconsistent") {
          expect((await store.owner.query("SELECT contradiction FROM public.tax_calculations WHERE calculation_id=$1",
            [grant.calculationId])).rows).toStrictEqual([{ contradiction: true }]);
        }
      }
    }
  }
}, postgresSetupTimeoutMs);

it("admits fresh successful authority after the four owner repairs and preserves the original outcomes", async () => {
  const value = await fixture();
  const repairCodes = ["tax_scope_mismatch", "tax_breakdown_incomplete", "tax_reference_conflict", "tax_calculation_unusable"];
  const repairs = cases.filter(([exclusiveOnly, , code, field]) => exclusiveOnly && field === "/taxEvidence" && repairCodes.includes(code));
  expect(repairs).toHaveLength(4);
  for (const [, kind, code, field, remedy] of repairs) {
    const original = value.begin(exclusiveKind, true);
    const fixed = value.begin(exclusiveKind, true);
    expect(original.identity.evaluationKey).not.toBe(fixed.identity.evaluationKey);
    const originalGrant = await claim(original);
    let unresolved = true;
    const complete = (input: Begin, grant: Claim) => unresolved
      ? refusal(input, grant, { kind, code, field, remedy }) : seal(value, input, grant);
    const oldCommand = complete(original, originalGrant);
    await exactReplay(original, oldCommand);
    unresolved = false;
    const fresh = complete(fixed, await claim(fixed));
    expect(fresh.seal.outcome.kind).toBe("final");
    await exactReplay(fixed, fresh);
    await exactReplay(original, oldCommand);
  }
});

it("checks pinned revision, fiscal rate, Unicode and canonical instants on their owner boundaries", async () => {
  const value = await fixture();
  const input = value.begin(fiscalKind, true);
  const composition = input.pin.composition!;
  const withComposition = (patch: Partial<typeof composition>) => ({ ...input, pin: {
    ...input.pin, composition: { ...composition, ...patch },
  } });
  const limits = (patch: object) => withComposition({ limits: { ...composition.limits, ...patch } });
  const fiscal = (vatRateBps: number) => withComposition({ fiscal: {
    ...composition.fiscal!, facts: { ...composition.fiscal!.facts, vatRateBps },
  } });
  const atMoneyRef = (lineKey: string) => withComposition({ planInput: { ...composition.planInput,
    lines: [{ ...composition.planInput.lines[0]!, lineKey }],
  } });
  const boundaries = [
    [limits({ revision: 1 }), limits({ revision: 0 })],
    [limits({ revision: 2_147_483_647 }), limits({ revision: 2_147_483_648 })],
    [limits({ profileRef: "😀".repeat(50) }), limits({ profileRef: "😀".repeat(50) + "x" })],
    [withComposition({ catalogueEvidenceRef: "😀".repeat(256) }), withComposition({ catalogueEvidenceRef: "😀".repeat(257) })],
    [atMoneyRef("😀".repeat(64)), atMoneyRef("😀".repeat(64) + "x")],
    [fiscal(0), fiscal(-1)], [fiscal(10_000), fiscal(10_001)],
    [withComposition({ evidenceExpiresAt: "0001-01-01T00:00:00.000Z" }), withComposition({ evidenceExpiresAt: "0000-01-01T00:00:00.000Z" })],
    [withComposition({ evidenceExpiresAt: "9999-12-31T23:59:59.999Z" }), withComposition({ evidenceExpiresAt: "2026-02-30T00:00:00.000Z" })],
    [input, limits({ revision: "42" })], [input, limits({ revision: 1.5 })],
    [input, limits({ currency: "xxx" })], [input, limits({ mode: "other" })],
    [limits({ minMinor: 0 }), limits({ minMinor: -1 })],
    [limits({ maxMinor: Number.MAX_SAFE_INTEGER }), limits({ maxMinor: Number.MAX_SAFE_INTEGER + 1 })],
  ] as const;
  // Temporarily disabled pin shape admission in the disposable database.
  await mutate(domainRoutine, "EXISTS (SELECT FROM invalid_shapes WHERE field = '/pin')", "false", async () => {
    for (const [, invalid] of boundaries) await rollback(db => claim(invalid, db));
  });
  for (const [valid, invalid] of boundaries) {
    await rollback(db => claim(valid, db));
    expectError(await rejected(store.runtime, beginSql, invalid), "tax_invalid_input", "/pin");
    expect(await rowFor(input)).toStrictEqual([]);
  }
  const malformed = { ...input, pin: { ...input.pin, composition: null } };
  expectError(await rejected(store.runtime, beginSql, malformed), "tax_invalid_input", "/pin");
  const ancient = { basis: "inclusive", taxDate: "0000-02-29T00:00:00.000Z" };
  for (const extended of [true, false]) {
    const input = value.begin(fiscalKind, extended);
    const candidate = { ...input, pin: { ...input.pin, request: ancient, requestDigest: evaluationDigest("evaluation-request", ancient) } };
    if (extended) expectError(await rejected(store.runtime, beginSql, candidate), "tax_invalid_input", "/pin/request/taxDate");
    else await rollback(db => claim(candidate, db));
  }
  const maxRevision = limits({ revision: 2_147_483_647 });
  const completed = seal(value, maxRevision, await claim(maxRevision));
  expect(completed.seal.outcome.quote.paymentLimits.revision).toBe("2147483647");
  await exactReplay(maxRevision, completed);
});

it("uses the installed wire byte, depth and generation bounds on composition requests", async () => {
  const value = await fixture();
  const input = value.begin(fiscalKind, true);
  const empty = { ...input, padding: "" };
  const padding = 1_048_576 - Buffer.byteLength(canonicalCatalogDraftJson(empty));
  const atCap = { ...empty, padding: "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2) };
  await rollback(db => claim(atCap, db));
  expectError(await rejected(store.runtime, beginSql, { ...atCap, padding: atCap.padding + "x" }), "tax_invalid_input", "/");
  let nested: unknown = null;
  for (let depth = 1; depth < 48; depth++) nested = [nested];
  const atDepth = { ...input, padding: nested };
  await rollback(db => claim(atDepth, db));
  expectError(await rejected(store.runtime, beginSql, { ...atDepth, padding: [nested] }), "catalog_publication_wire_invalid", undefined);
  const grant = await claim(input);
  const command = seal(value, input, grant);
  const before = await rowFor(input);
  for (const generation of [0, 2_147_483_648, 1.5]) {
    expectError(await rejected(store.runtime, completeSql, { ...command, generation }), "tax_invalid_input", "/seal");
  }
  expectError(await rejected(store.runtime, completeSql, { ...command, generation: 2_147_483_647 }),
    "tax_claim_stale", "/claim", "55000");
  expect(await rowFor(input)).toStrictEqual(before);
  await exactReplay(input, command);
});

type Completion = ReturnType<typeof seal>;
function bindEditedSeal(command: Completion, grant: Claim, evidence = command.seal.evidence,
  paymentLimits = command.seal.outcome.quote.paymentLimits, extraEnvelope: Record<string, unknown> = {}) {
  const { calculationId, generation } = command;
  const { requestDigest, destination, kind, disposition, validUntil, outcome } = command.seal;
  const { quoteId, status, schemaVersion, contractVersion, moneyDigest: _money, quoteDigest: _quote, ...money } = outcome.quote;
  const envelope = { calculationId, invocationDigest: grant.pin.invocationDigest, requestDigest, generation,
    destination, kind, evidence, disposition, validUntil, ...extraEnvelope };
  const sealedMoney = { ...money, paymentLimits,
    taxEvidence: { ...money.taxEvidence, evidenceDigest: evaluationDigest("evaluation-evidence", envelope) } };
  const core = { ...sealedMoney, quoteId, status, schemaVersion, contractVersion, moneyDigest: quoteDigest("commerce.quote-money.v2", sealedMoney) };
  return { ...command, seal: { ...command.seal, evidence, outcome: {
    ...outcome, quote: { ...core, quoteDigest: quoteDigest("commerce.quote.v2", core) },
  } } };
}

it("binds both extended evidence frames and each payment limit coordinate before writing", async () => {
  const value = await fixture();
  for (const kind of [fiscalKind, exclusiveKind] as const) {
    const input = value.begin(kind, true);
    const grant = await claim(input);
    const command = seal(value, input, grant);
    const limits = command.seal.outcome.quote.paymentLimits;
    const evidence = command.seal.evidence;
    const foreignComposition = { ...evidence, compositionDigest: evaluationDigest("evaluation-composition",
      value.begin(kind, true).pin.composition!.planInput) };
    const bound = bindEditedSeal(command, grant, foreignComposition);
    // Temporarily disabled the composition digest comparison in the disposable database.
    await mutate(terminalRoutine,
      "evidence->>'compositionDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-composition',composition)", "false",
      async () => { expect(await rollback(db => invoke(db, completeSql, bound))).toHaveProperty("kind", "terminal"); });

    const failures = [bound];
    for (const patch of [{ profileRef: "other" }, { channelKey: "other" }, { currency: "AAA" }, { minMinor: 2 }, { maxMinor: 501 },
      ...["042", " 42", "+42", "42 ", "43", "٤٢", "2147483648"].map(revision => ({ revision }))]) {
      failures.push(bindEditedSeal(command, grant, evidence, { ...limits, ...patch }));
    }
    if (kind === fiscalKind && "facts" in evidence) {
      for (const patch of [{ facts: { ...fiscalFacts, vatRateBps: 1 } }, { coordinates: { ...evidence.coordinates!, marketRef: "market-b" } },
        { policyRevision: digest }, { calculationId: randomUUID() }, { coverage: { kind: "changed" } }, { posting: "required" }]) {
        failures.push(bindEditedSeal(command, grant, { ...evidence, ...patch }));
      }
    }
    const before = await rowFor(input);
    for (const bad of failures) {
      expectError(await rejected(store.runtime, completeSql, bad), "tax_reference_conflict", "/taxEvidence");
      expect(await rowFor(input)).toStrictEqual(before);
    }
    await exactReplay(input, command);
  }
});

async function storedFrame(calculationId: string) {
  return (await store.owner.query<{ text: string; digest: string }>(
    "SELECT outcome_text AS text,outcome_digest AS digest FROM public.tax_calculations WHERE calculation_id=$1",
    [calculationId])).rows[0]!;
}

async function writeStoredFrame(calculationId: string, text: string) {
  const owner = await store.owner.connect();
  try {
    await owner.query("BEGIN; ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard");
    await owner.query("UPDATE public.tax_calculations SET outcome_text=$2,outcome_digest=$3 WHERE calculation_id=$1",
      [calculationId, text, destinationHash(text)]);
    await owner.query("ALTER TABLE public.tax_calculations ENABLE TRIGGER tax_calculation_guard; COMMIT");
  } finally { await owner.query("ROLLBACK"); owner.release(); }
}

it("verifies extended evidence on readback and exports only the verified public outcome", async () => {
  const value = await fixture();
  const input = value.begin(fiscalKind, true);
  input.invocation.purpose = "estimate";
  const grant = await claim(input);
  const command = seal(value, input, grant);
  await exactReplay(input, command);
  const stored = await storedFrame(grant.calculationId);
  const [tag, body] = JSON.parse(stored.text) as [string, Record<string, unknown>];
  expect(tag).toBe("platform.tax.evaluation-outcome.v1");
  expect(Object.keys(body).sort()).toStrictEqual([
    "calculationId", "invocationDigest", "requestDigest", "generation", "destination", "kind", "evidence",
    "disposition", "validUntil", "outcome", "submissionDigest", "providerDigest", "contradiction",
  ].sort());
  const privacy = async () => (await store.runtime.query<{ export: unknown }>(
    "SELECT public.tax_calculation_export_v1($1) AS export", [input.identity.clientId])).rows[0]!.export;
  const lookup = { operation: "lookup", identity: input.identity, invocation: input.invocation };
  expect(await privacy()).toStrictEqual([{
    calculationId: grant.calculationId, status: "terminal", issuedAt: expect.any(String), outcome: command.seal.outcome,
  }]);

  for (const key of ["contactEmail", "line1"]) {
    const added = { [key]: "private-text" };
    const rebound = bindEditedSeal(command, grant, undefined, undefined, added);
    const dirty = { ...body, ...added, outcome: rebound.seal.outcome };
    await writeStoredFrame(grant.calculationId, canonicalCatalogDraftJson([tag, dirty]));
    // Temporarily disabled both terminal root checks in the disposable database.
    await mutate(terminalRoutine, "OR body - envelope_keys - ARRAY['outcome','submissionDigest','providerDigest','contradiction'] <> '{}'::jsonb",
      "", () => mutate(terminalRoutine,
        "body - ARRAY['calculationId','invocationDigest','generation','submissionDigest','providerDigest'],NULL",
        "body - ARRAY['calculationId','invocationDigest','generation','submissionDigest','providerDigest','contactEmail','line1'],NULL",
        async () => { expect(await invoke(store.runtime, beginSql, lookup)).toHaveProperty("outcome", rebound.seal.outcome); }));
    expectError(await rejected(store.runtime, beginSql, lookup), "tax_evaluation_integrity_invalid", "/taxEvidence", "55000");
    expect(await privacy()).toStrictEqual([{
      calculationId: grant.calculationId, status: "terminal", issuedAt: expect.any(String), verification: "failed",
    }]);
  }

  const foreign = bindEditedSeal(command, grant, { ...command.seal.evidence, compositionDigest: digest });
  const corrupt = { ...body, evidence: foreign.seal.evidence, outcome: foreign.seal.outcome };
  await writeStoredFrame(grant.calculationId, canonicalCatalogDraftJson([tag, corrupt]));
  // Temporarily disabled the composition digest comparison in the disposable database.
  await mutate(terminalRoutine,
    "evidence->>'compositionDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-composition',composition)", "false",
    async () => { expect(await invoke(store.runtime, beginSql, lookup)).toHaveProperty("outcome", foreign.seal.outcome); });
  expectError(await rejected(store.runtime, beginSql, lookup), "tax_evaluation_integrity_invalid", "/taxEvidence", "55000");
  await writeStoredFrame(grant.calculationId, stored.text);
  await exactReplay(input, command);
});

it("erases extended subject evidence and keeps the provider uniqueness marker effective", async () => {
  const value = await fixture();
  const input = value.begin(exclusiveKind, true);
  const grant = await claim(input);
  const providerRef = randomUUID();
  await exactReplay(input, seal(value, input, grant, true, providerRef));
  const providerDigest = (await store.owner.query<{ digest: string }>(
    "SELECT provider_digest AS digest FROM public.tax_calculations WHERE calculation_id=$1", [grant.calculationId])).rows[0]!.digest;
  expect(providerDigest).toMatch(/^[0-9a-f]{64}$/u);
  // Keep a distinct owned action pending to check the same provider identity after erasure.
  const competing = await fixture();
  const next = competing.begin(exclusiveKind, true);
  const other = value.begin(exclusiveKind, true);
  // The same provider account and scope are needed across subjects. Use the original verified history.
  next.pin.coverage = other.pin.coverage;
  if (!("input" in next.pin.request) || !("input" in other.pin.request)) throw new Error("Expected exclusive request");
  const { address } = snapshotCommand(competing.ctx).command.validated;
  const nextRequest = makeTaxQuoteRequest(next.identity.evaluationKey, { ...other.pin.request.input,
    destination: { ...next.pin.request.input.destination, address } });
  const { address: _address, ...destination } = nextRequest.input.destination;
  next.pin.request = { ...nextRequest, input: { ...nextRequest.input, destination } };
  next.pin.requestDigest = evaluationDigest("evaluation-request", nextRequest);
  const nextGrant = await claim(next);

  expect((await store.runtime.query("SELECT public.tax_calculation_erase_v1($1) AS erased", [input.identity.clientId])).rows)
    .toStrictEqual([{ erased: 1 }]);
  expect((await store.owner.query(`SELECT jsonb_strip_nulls(to_jsonb(r)) AS row
    FROM public.tax_calculations r WHERE calculation_id=$1`, [grant.calculationId])).rows)
    .toStrictEqual([{ row: { calculation_id: grant.calculationId, state: "erased", provider_digest: providerDigest } }]);
  expect((await store.runtime.query("SELECT public.tax_calculation_export_v1($1) AS export", [input.identity.clientId])).rows)
    .toStrictEqual([{ export: [] }]);
  const attempted = seal(competing, next, nextGrant, true, providerRef);
  const outcome = { kind: "refused", code: "tax_provider_reference_conflict", field: "/taxEvidence",
    remedy: "Reconcile the original calculation with the tax adapter owner before further work." };
  // Temporarily disabled the partial uniqueness index inside a rolled-back database transaction.
  const owner = await store.owner.connect();
  try {
    await owner.query("BEGIN; DROP INDEX public.tax_calculations_provider_key; SET LOCAL ROLE transfer_runtime");
    expect(await invoke(owner, completeSql, attempted)).toHaveProperty("outcome.kind", "final");
  } finally { await owner.query("ROLLBACK"); owner.release(); }
  const expected = { kind: "terminal", outcome, validUntil: next.pin.validUntil };
  expect(await invoke(store.runtime, completeSql, attempted)).toStrictEqual(expected);
  expect(await invoke(store.runtime, completeSql, attempted)).toStrictEqual(expected);
});
