import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { applyTaxCoverageRevision, evaluationDigest, makeTaxQuoteRequest } from "@openlup/platform/tax";
import type { TaxQuoteInputV1 } from "@openlup/platform/tax/contracts";
import type { JourneyInstallation } from "../helpers/storeJourney.js";
import { destinationContext, destinationHash, snapshot, snapshotCommand, testServicePin } from "./destinationDocumentFixture.js";

const digest = "ab".repeat(32);
const quoteDigest = (tag: "commerce.quote.v2" | "commerce.quote-money.v2", body: unknown) =>
  destinationHash(canonicalCatalogDraftJson([tag, body]));
const fixtureTaxDate = "2026-06-05T10:00:00.000Z";
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

async function fixture(store: Pick<JourneyInstallation, "owner" | "runtime">, taxDate = fixtureTaxDate) {
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
  return { ctx, issued, begin, adapterEvidence, fullInput };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Begin = ReturnType<Fixture["begin"]>;
const beginSql = "SELECT public.tax_calculation_begin_v1($1::jsonb) AS value";
const completeSql = "SELECT public.tax_calculation_complete_v1($1::jsonb) AS value";

async function invoke<T>(db: Db, sql: string, wire: object) {
  return (await db.query<{ value: T }>(sql, [wire])).rows[0]!.value;
}
async function claim(input: Begin, db: Db) {
  const result = await invoke<Claim>(db, beginSql, input);
  expect(result).toMatchObject({ kind: "claimed", generation: 1 });
  return result;
}

function seal(value: Fixture, input: Begin, grant: Claim, extended = Boolean(input.pin.composition), providerRef: string = randomUUID()) {
  const calc = grant.calculationId;
  const { destination, kind, requestDigest, validUntil, composition } = input.pin;
  const taxDate = "input" in input.pin.request ? input.pin.request.input!.taxDate : input.pin.request.taxDate;
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

const rowFor = async (store: JourneyInstallation, input: Begin) => (await store.owner.query<{ row: unknown }>(
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

async function rollback<T>(store: JourneyInstallation, work: (runtime: PoolClient) => Promise<T>) {
  const db = await store.runtime.connect();
  try { await db.query("BEGIN"); return await work(db); }
  finally { await db.query("ROLLBACK"); db.release(); }
}

const domainRoutine = "public.tax_calculation_check_domain_v1(jsonb,jsonb,jsonb,boolean)";
const terminalRoutine = "public.tax_calculation_terminal_v1(public.tax_calculations)";
async function mutate(store: JourneyInstallation, signature: string, before: string, after: string, witness: () => Promise<void>) {
  const { rows: [row] } = await store.owner.query<{ definition: string }>(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature]);
  expect(row!.definition).toContain(before);
  await store.owner.query(row!.definition.replace(before, after));
  try { await witness(); }
  finally { await store.owner.query(row!.definition); }
}

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

type Completion = ReturnType<typeof seal>;
function bindEditedSeal<E = Completion["seal"]["evidence"]>(command: Completion, grant: Claim, evidence: E = command.seal.evidence as E,
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

export const terminalCases = [
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

export { beginSql, bindEditedSeal, contaminate, paths, claim, completeSql, digest, domainRoutine, exclusiveKind, expectError, fiscalFacts, fiscalKind,
  fixture, invoke, mutate, quoteDigest, refusal, rejected, rollback, rowFor, seal, terminalRoutine };
export type { Begin, Claim, Completion, Fixture, JsonPath, Refusal };
