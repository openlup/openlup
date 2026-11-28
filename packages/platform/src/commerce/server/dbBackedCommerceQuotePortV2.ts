import { randomUUID } from "node:crypto";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import { commerceQuoteV2Schema, composeCommerceQuoteMoneyV2, planCommerceQuoteMoneyV2, quoteDigest } from "../../pricing/index.js";
import type { CommerceQuoteV2, ComposeCommerceQuoteMoneyV2Input, PlanCommerceQuoteMoneyV2Input, CommerceQuoteMoneyV2Plan } from "../../pricing/index.js";
import { beginTaxCalculation, completeTaxCalculation, evaluationDigest, makeTaxQuoteRequest, reconcileTaxCoverage, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../tax/index.js";
import type { TaxCalculationPortV1, TaxCalculationTransactionLane, TaxCoverageRevision } from "../../tax/index.js";
import type { DestinationContextV2, DestinationPortV2, DestinationServicePinV2, DestinationVerifiedReadV2 } from "./destinations/index.js";
import type { LimitsReadResult, LimitsTuple } from "./commerceMoneyLimitsV2.js";
import { destinationRefusal, expired, integrity, missingCoverage, pending, projectAdapterFailure, refused } from "./commerceQuoteV2Refusals.js";
import { lookupPublishedSkuTaxAssignmentRefusal } from "./publishedSkuTaxAssignments.js";

type Begin = Exclude<Parameters<typeof beginTaxCalculation>[1], Uint8Array>;
type Complete = Exclude<Parameters<typeof completeTaxCalculation>[1], Uint8Array>;
type QuoteFrames = {
  snapshot<T>(value: T, omit?: string): T;
  invalid(field: string): Refusal;
  dependency<T>(field: string, work: () => Promise<T>): Promise<T>;
  infrastructure(field: string, cause: unknown): Error;
};
type Claim = Extract<Awaited<ReturnType<typeof beginTaxCalculation>>, { kind: "claimed" }>;
type Pin = NonNullable<Extract<Begin, { operation: "claim" }>["pin"]>;
type Composition = NonNullable<Pin["composition"]>;
type Fiscal = NonNullable<Extract<Pin, { kind: "fiscal_profile" }>["composition"]>["fiscal"];
type TaxRequest = ReturnType<typeof makeTaxQuoteRequest>;
type TaxInput = TaxRequest["input"];
type AdapterResult = Awaited<ReturnType<TaxCalculationPortV1["quote"]>>;
type AdapterSuccess = Extract<AdapterResult, { kind: "final" | "estimate" }>;
type CheckoutDestinationRead = Extract<DestinationVerifiedReadV2, { evidenceExpiresAt: string }>;
type Refusal = { kind: "refused"; code: string; field: string; remedy: string };
type RetainedRequest = Omit<TaxRequest, "input"> & { input: Omit<TaxInput, "destination"> & {
  destination: Omit<TaxInput["destination"], "address">;
} };
type Interval = { minMinor: number; maxMinor: number };
type FiscalPositions = Pick<Extract<ComposeCommerceQuoteMoneyV2Input, { fiscal: unknown }>, "fiscal" | "positions">;
type ExclusivePositions = Pick<Extract<ComposeCommerceQuoteMoneyV2Input, { verifiedMoney: unknown }>, "verifiedMoney" | "positions" | "feeLines">;
type Rail = LimitsTuple & { mode: "test" | "live" };
type FreshFacts = {
  planInput: PlanCommerceQuoteMoneyV2Input;
  catalogueEvidenceRef: string;
  service: DestinationServicePinV2;
  rail: Rail;
  bounds: { rail: Interval; wire: Interval; order: Interval; intent: Interval; attempt: Interval; capture: Interval };
  taxDate: string;
  quoteCutoff: string;
};
type ExclusiveBinding = {
  adapter: TaxCalculationPortV1;
  scope: TaxInput["scope"];
  recovery: string | null;
  isDefinitive: (result: Extract<AdapterResult, { kind: "refused" }>) => boolean;
  readCoverage: (installationRef: string, accountRef: string) => Promise<TaxCoverageRevision | null>;
  readTaxFacts: (owner: QuoteOwnerContext, plan: CommerceQuoteMoneyV2Plan, service: DestinationServicePinV2, document: CheckoutDestinationRead) =>
    Promise<Pick<TaxInput, "market" | "shipFromRef" | "policyRevision" | "required">>;
};

/** @experimental Trusted host-authorized checkout owner. */
export type QuoteOwnerContext = Omit<Begin["identity"], "evaluationKey">;
/** @experimental Ordered quote invocation and its evaluation key. */
export type CommerceQuoteV2Request = Begin["invocation"] & { key: string };
/** @experimental Terminal quote or actionable result without private evidence. */
export type QuoteOutcome = { kind: "quoted"; quote: CommerceQuoteV2; freshness: "current" | "historical" }
  | (Refusal & { amountAdvice?: Interval & { currency: string } })
  | (Omit<Refusal, "kind"> & { kind: "unavailable"; effect: "none" });
/** @experimental Installed owner bindings used only by the opt-in quote port. */
export interface DbBackedCommerceQuotePortV2Deps {
  lane: TaxCalculationTransactionLane;
  privacyRegistry: { readonly contributors: readonly { readonly id: string }[]; readonly missingContributors: readonly string[] };
  destination: Pick<DestinationPortV2, "snapshot" | "read">;
  snapshotCommand: (owner: QuoteOwnerContext, request: CommerceQuoteV2Request) => Promise<Parameters<DestinationPortV2["snapshot"]>[1]>;
  readPlan: (owner: QuoteOwnerContext, request: CommerceQuoteV2Request, document: CheckoutDestinationRead) => Promise<FreshFacts>;
  readLimits: (rail: Rail) => Promise<LimitsReadResult>;
  clockToleranceMs: number;
  readFiscal?: (owner: QuoteOwnerContext) => Promise<Fiscal>;
  exclusive?: ExclusiveBinding;
}
/** @experimental Server quote entry for the opt-in native installation. */
export interface CommerceQuotePortV2 {
  createQuote(context: QuoteOwnerContext, request: CommerceQuoteV2Request): Promise<QuoteOutcome>;
}

const maxMinor = 2_147_483_647;
const unbound = () => refused("money_limits_unavailable", "/paymentLimits", "Install or select a qualified payment limits tuple.");
const contactIssue = () => refused("destination_contact_incomplete", "/destination/contact", "Collect the recipient name and phone, then issue a new destination snapshot.");
const erased = () => refused("destination_evidence_erased", "owner", "Review the privacy disposition through authorized support.");
const instant = (value: string) => typeof value === "string" && value.length === 24 && value >= "0001"
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const tupleKeys = ["installationRef", "channelKey", "methodKey", "providerKey", "accountRef", "mode", "currency"] as const;
const scopeKeys = ["adapter", "adapterVersion", "accountRef", "mode"] as const;
const sameScope = (a: TaxInput["scope"], b: TaxInput["scope"]) => scopeKeys.every(key => a[key] === b[key]);
const coverageTag = { kind: "not_applicable" } as const;

function validateQuote(quote: unknown) {
  const parsed = commerceQuoteV2Schema.safeParse(quote);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue?.code !== "custom" || !issue.params) return integrity();
  const { code, field, remedy } = issue.params;
  return refused(code, field, remedy);
}

function outcome(result: Exclude<Awaited<ReturnType<typeof beginTaxCalculation>>, Claim>): QuoteOutcome {
  if (result.kind === "refused") return result;
  if (result.kind !== "terminal") return pending();
  if (!("quote" in result.outcome)) return result.outcome;
  const quote = validateQuote(result.outcome.quote);
  if ("kind" in quote) return quote;
  if (quote.status !== result.outcome.kind || quote.taxEvidence.expiresAt !== result.validUntil) return integrity();
  return { kind: "quoted", quote, freshness: result.freshness };
}

function checkContact(plan: CommerceQuoteMoneyV2Plan, { document: { contact } }: DestinationVerifiedReadV2) {
  if (plan.winner.delivery.some(row => row.kind === "shipping") && (!contact.recipientName?.trim() || !contact.contactPhone?.trim())) return contactIssue();
}

function projectAddress({ document: { address } }: DestinationVerifiedReadV2): TaxInput["destination"]["address"] {
  const { country, subdivision, ...street } = address;
  return { ...street, countryCode: country, ...(subdivision === undefined ? {} : { subdivisionCode: subdivision }) };
}

function paymentLimits(read: LimitsReadResult, { rail, bounds, planInput }: FreshFacts, owner: QuoteOwnerContext): Composition["limits"] | undefined {
  if (!read.present || read.value.active !== true) return;
  const { active: _active, schemaVersion, ...installed } = read.value;
  if (schemaVersion !== 2 || tupleKeys.some(key => rail[key] !== installed[key]) || rail.currency !== planInput.currency
    || rail.installationRef !== owner.installationRef) return;
  const ranges = [installed, bounds.rail, bounds.wire, bounds.order, bounds.intent, bounds.attempt, bounds.capture];
  const isMinor = (n: number) => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
  if (ranges.some(({ minMinor, maxMinor }) => !isMinor(minMinor) || !isMinor(maxMinor) || minMinor > maxMinor)) return;
  const minMinor = Math.max(1, ...ranges.map(range => range.minMinor));
  const max = Math.min(maxMinor, ...ranges.map(range => range.maxMinor));
  if (minMinor <= max) return { ...installed, mode: rail.mode, revision: read.revision, effective: { minMinor, maxMinor: max } };
}

async function freshPin(deps: DbBackedCommerceQuotePortV2Deps, owner: QuoteOwnerContext, request: CommerceQuoteV2Request, ctx: DestinationContextV2,
  { snapshot, invalid, dependency, infrastructure }: QuoteFrames) {
  const command = await dependency("/destination/snapshot", () => deps.snapshotCommand(owner, request));
  const issued = await dependency("/destination/snapshot", () => deps.destination.snapshot(ctx, command, new Date().toISOString()));
  if ("outcome" in issued) return destinationRefusal(issued);
  if ("evidenceDisposition" in issued) return erased();
  const { binding: destination, selection } = issued;
  const read = await dependency("/destination/read", () => deps.destination.read(ctx, "snapshot", destination.snapshotRef, destination));
  if ("outcome" in read) return destinationRefusal(read);
  if (read.binding.snapshotRef !== destination.snapshotRef || read.binding.destinationDigest !== destination.destinationDigest ||
    read.binding.policyRevision !== destination.policyRevision || read.evidenceExpiresAt !== issued.evidenceExpiresAt) return integrity();
  const doc = snapshot(read);
  const resolved = await dependency("/plan", async () => {
    try {
      return { facts: await deps.readPlan(owner, request, doc) };
    } catch (cause) {
      const refusal = lookupPublishedSkuTaxAssignmentRefusal(cause);
      if (!refusal) throw cause;
      return refused(refusal.code, refusal.field, refusal.remedy);
    }
  });
  if ("kind" in resolved) return resolved;
  let planInput: Composition["planInput"];
  let facts: FreshFacts;
  try {
    const { planInput: original, ...rest } = resolved.facts;
    planInput = snapshot(original, "codeDiagnostics") as Composition["planInput"];
    facts = { ...snapshot(rest), planInput };
  } catch { return invalid("/planInput"); }
  const planned = planCommerceQuoteMoneyV2(planInput);
  if (planned.kind === "refused") return planned;
  const contact = checkContact(planned, doc);
  if (contact) return contact;
  const { rail, service, catalogueEvidenceRef, quoteCutoff, taxDate } = facts;
  const ordered = [...planned.lines].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
  if (ordered.length !== request.lines.length || ordered.some((line, i) => line.sku !== request.lines[i].sku
    || line.quantity !== request.lines[i].quantity || line.mode !== request.mode)) return invalid("/planInput/lines");
  if (selection.scopeRef !== owner.scopeRef || service.deliverySelectionRef !== planned.winner.deliverySelectionRef ||
    planned.winner.delivery.some(row => row.kind === "shipping" && (row.carrierRef !== service.carrierRef || row.serviceRef !== service.serviceRef)))
    return invalid("/planInput");
  if (!instant(quoteCutoff) || !instant(taxDate) || !instant(doc.evidenceExpiresAt)) return invalid("/now");
  const cutoff = Math.min(Date.parse(quoteCutoff), Date.parse(doc.evidenceExpiresAt) - deps.clockToleranceMs);
  if (cutoff <= Date.parse(taxDate)) return expired();
  const validUntil = new Date(cutoff).toISOString();
  const limits = paymentLimits(await dependency("/read", () => deps.readLimits(rail)), facts, owner);
  if (!limits) return unbound();
  const composition = { planInput, catalogueEvidenceRef, evidenceExpiresAt: doc.evidenceExpiresAt, selection, service, limits };
  if (planned.moneyInput.amountBasis === "inclusive") {
    if (!deps.readFiscal) throw infrastructure("/fiscalProfile", new Error("Missing installed fiscal profile binding"));
    const fiscal = await dependency("/fiscalProfile", async () => snapshot(await deps.readFiscal!(owner)));
    if (fiscal.coordinates.installationRef !== owner.installationRef || !Number.isInteger(fiscal.facts.vatRateBps) ||
      fiscal.facts.vatRateBps < 0 || fiscal.facts.vatRateBps > 10_000) return invalid("/pin/composition/fiscal");
    return { pin: { kind: "fiscal_profile", destination, request: { basis: "inclusive", taxDate }, coverage: null, recovery: null,
      validUntil, composition: { ...composition, fiscal } } satisfies Pin };
  }
  const tax = deps.exclusive;
  if (!tax) throw infrastructure("/taxEvidence", new Error("Missing scoped tax binding"));
  const installed = await dependency("/coverage", () => tax.readCoverage(owner.installationRef, tax.scope.accountRef));
  if (!installed?.coverage.declarations.length) return missingCoverage();
  if (installed.installationRef !== owner.installationRef || installed.accountRef !== tax.scope.accountRef ||
    installed.revision !== installed.coverage.revision || installed.coverageDigest !== evaluationDigest("coverage-revision", installed.coverage)) return integrity();
  const { market, shipFromRef, policyRevision, required } = await dependency("/taxEvidence", () => tax.readTaxFacts(owner, planned, service, doc));
  if (!required.length) return missingCoverage();
  const coverage = reconcileTaxCoverage({ scope: tax.scope, taxDate, coverage: installed.coverage, required, observations: [] });
  if (coverage.vector.some(row => row.decision === "undeclared")) return missingCoverage();
  if (coverage.kind === "refused") return refused(coverage.code, coverage.field, coverage.remedy);
  const input: TaxInput = { scope: tax.scope, market, shipFromRef, policyRevision, required, taxDate,
    currency: planInput.currency, purpose: request.purpose, classMapRevision: planInput.price.classMapRevision,
    destination: { snapshotRef: destination.snapshotRef, digest: destination.destinationDigest,
      policyRevision: destination.policyRevision, address: projectAddress(doc) },
    money: { ...planned.moneyInput, amountBasis: "exclusive" }, coverage: installed.coverage,
    lines: planned.lines.map(({ lineKey, sku, mode, taxClassKey, assignmentRef }) => ({ lineKey, sku, mode, taxClass: taxClassKey, assignmentRef })),
    delivery: planned.winner.delivery.map(({ bucketKey, carrierRef, serviceRef, cost, separatelyStated, taxClassKey, assignmentRef }) =>
      ({ bucketKey, carrierRef, serviceRef, cost, separatelyStated, taxClass: taxClassKey, assignmentRef })),
  };
  try {
    return { pin: { kind: "tax_calculation", destination, request: makeTaxQuoteRequest(request.key, input), validUntil, recovery: tax.recovery,
      coverage: { accountRef: installed.accountRef, revision: installed.revision, digest: installed.coverageDigest }, composition } satisfies Pin };
  } catch (error) {
    if (error instanceof Error && "field" in error && "code" in error) return refused(String(error.code), String(error.field), error.message);
    return invalid("/pin/request");
  }
}

async function finish(deps: DbBackedCommerceQuotePortV2Deps, context: DestinationContextV2, scope: Pick<Begin, "identity" | "invocation">, claim: Claim,
  { snapshot, dependency, infrastructure }: QuoteFrames): Promise<QuoteOutcome> {
  const { pin, calculationId, generation, claimToken, dispatchDeadlineMs, cutoffDeadlineMs } = claim;
  const { composition, destination, kind, invocationDigest, requestDigest, documentDigest } = pin;
  if (!composition) return integrity();
  const planned = planCommerceQuoteMoneyV2(composition.planInput);
  if (planned.kind === "refused") return planned;
  let validUntil = pin.validUntil;
  const seal = (outcome: Complete["seal"]["outcome"], contradiction = false) => completeTaxCalculation(deps.lane, {
    ...scope, calculationId, generation, claimToken, seal: { kind, destination, requestDigest, validUntil, evidence: null, outcome, contradiction },
  });
  const compositionDigest = evaluationDigest("evaluation-composition", composition);
  const { channelKey, currency, profileRef, revision, effective } = composition.limits;
  const facts = { catalogueEvidenceRef: composition.catalogueEvidenceRef, destination, mode: scope.invocation.mode,
    ...(scope.invocation.cadence ? { cadence: scope.invocation.cadence } : {}),
    paymentLimits: { ...effective, profileRef, channelKey, currency, revision: String(revision) } };
  let positionFacts: FiscalPositions | ExclusivePositions;
  let evidence: unknown, disposition: string, coverageDigest: string, taxDate: string, payable: number;
  let adapter: { request: TaxRequest; result: AdapterSuccess } | undefined;
  if (pin.kind === "tax_calculation") {
    const tax = deps.exclusive;
    if (!tax) return pending();
    const doc = await dependency("/destination/read", () => deps.destination.read(context, "snapshot", destination.snapshotRef, destination));
    if ("outcome" in doc) return destinationRefusal(doc);
    if (doc.documentDigest !== documentDigest) return integrity();
    const contact = checkContact(planned, doc);
    if (contact) return contact;
    const retained = pin.request as RetainedRequest;
    const request = { ...retained, input: { ...retained.input, destination: { ...retained.input.destination, address: projectAddress(doc) } } };
    if (!sameScope(tax.scope, request.input.scope) || evaluationDigest("evaluation-request", request) !== requestDigest) return integrity();
    const rejected = verifyTaxQuoteRequest(request);
    if (rejected) return rejected;
    const dispatch = snapshot(request);
    if (!(performance.now() < dispatchDeadlineMs)) return expired();
    const reply = await dependency("/taxEvidence", () => tax.adapter.quote(dispatch));
    if (reply.kind === "refused" || reply.kind === "unavailable") {
      const definitive = reply.kind === "unavailable" || await dependency("/taxEvidence", async () => tax.isDefinitive(reply));
      const projected = definitive ? projectAdapterFailure(reply) : { kind: "indeterminate" as const };
      if (projected.kind === "indeterminate") return pending();
      if (!(performance.now() < dispatchDeadlineMs)) return expired();
      return outcome(await seal(projected, projected.code === "tax_coverage_inconsistent"));
    }
    const error = verifyTaxQuoteResult(request, reply);
    if (error) return error;
    let result: AdapterSuccess;
    try { result = snapshot(reply); } catch { return integrity(); }
    disposition = result.evidence.coverage.vector.every(row => row.decision === "out_of_scope") ? "skip" : "required";
    ({ taxDate } = request.input);
    if (!instant(result.evidence.expiresAt)) return integrity();
    if (result.evidence.expiresAt < validUntil) validUntil = result.evidence.expiresAt;
    const sealDeadline = cutoffDeadlineMs - (Date.parse(pin.validUntil) - Date.parse(validUntil));
    if (!(performance.now() < Math.min(dispatchDeadlineMs, sealDeadline))) return expired();
    coverageDigest = result.evidence.coverage.digest;
    evidence = { adapterEvidence: result.evidence, adapterDigest: result.evidenceDigest };
    adapter = { request, result };
    const fees = new Map(result.money.fees.map(fee => [fee.feeKey, fee.amountMinor]));
    positionFacts = {
      verifiedMoney: result.money,
      positions: result.evidence.positions.tax.map(({ cell, ratePercent: _rate, ...meta }) => ({
        ...meta, jurisdictionRef: cell.jurisdiction, level: cell.level, taxKind: cell.taxKind,
      })),
      feeLines: result.evidence.positions.fees.map(({ jurisdiction, scope: feeScope, ...fee }) => ({
        ...fee, jurisdictionRef: jurisdiction, amountMinor: fees.get(fee.feeKey)!,
        scope: feeScope.kind === "order" ? feeScope : { kind: "delivery", bucketKey: feeScope.key },
      })),
    };
    payable = result.money.payableMinor;
  } else {
    const fiscal = pin.composition?.fiscal;
    if (!fiscal) return integrity();
    ({ taxDate } = pin.request as { taxDate: string });
    const policyRevision = evaluationDigest("fiscal-profile", [fiscal.facts, fiscal.coordinates]);
    coverageDigest = evaluationDigest("fiscal-coverage", coverageTag);
    disposition = "no_provider_posting";
    evidence = { ...fiscal, policyRevision, calculationId, coverage: coverageTag, posting: disposition };
    const shipping = new Set(planned.winner.delivery.filter(row => row.kind === "shipping").map(row => row.bucketKey));
    const rates = planned.plan.components.flatMap(({ ref }) => ref.kind === "delivery" && shipping.has(ref.bucketKey)
      ? [] : [{ ref, rateBps: fiscal.facts.vatRateBps }]);
    const positions = planned.plan.components.flatMap(({ ref, preDiscountMinor }) => {
      if (!preDiscountMinor) return [];
      const row = ref.kind === "merchandise" ? planned.lines.find(line => line.lineKey === ref.lineKey)! :
        planned.winner.delivery.find(bucket => bucket.bucketKey === ref.bucketKey)!;
      const resolution = { assignmentRef: row.assignmentRef, policyRevision, sourceRef: fiscal.facts.legalBasis, effective: { from: taxDate } };
      return [{ ref, position: { positionRef: randomUUID(), jurisdictionRef: fiscal.facts.country, level: "country", taxKind: "vat",
        taxabilityReason: fiscal.facts.category, ruleRef: fiscal.facts.legalBasis, resolution, resolutionDigest: evaluationDigest("resolution", resolution) } }];
    });
    positionFacts = { fiscal: rates, positions };
    try { payable = calculateCatalogueMoneyV2(planned.moneyInput, { kind: "inclusive", components: rates }).payableMinor; }
    catch (error) {
      if (!(error instanceof CatalogueMoneyV2Error) || error.code !== "money_amount_out_of_range") throw infrastructure("/planInput", error);
      return refused("money_amount_out_of_range", planned.winner.adjustments?.length ? "/planInput/selected" : "/planInput/baseline",
        "Choose a supported amount and obtain a fresh quote.");
    }
  }
  if (payable < effective.minMinor || payable > effective.maxMinor) return {
    ...refused("money_amount_out_of_range", "/payableMinor", "Choose a supported amount and obtain a fresh quote."),
    amountAdvice: { currency, ...effective },
  };
  const envelope = { calculationId, invocationDigest, requestDigest, generation, destination, kind,
    evidence: { ...evidence as object, compositionDigest }, disposition, validUntil };
  const taxEvidence = { kind, calculationId, taxDate, expiresAt: validUntil, evidenceDigest: evaluationDigest("evaluation-evidence", envelope) };
  const allocationIds = planned.plan.components.flatMap(({ ref, allocations }) =>
    allocations.map(({ sequence }) => ({ ref, sequence, allocationId: randomUUID() })));
  const assembly = { planInput: composition.planInput, allocationIds, facts: { ...facts, coverageDigest } };
  const composed = "fiscal" in positionFacts
    ? composeCommerceQuoteMoneyV2({ ...assembly, ...positionFacts, taxEvidence: { ...taxEvidence, kind: "fiscal_profile" } })
    : composeCommerceQuoteMoneyV2({ ...assembly, ...positionFacts, taxEvidence: { ...taxEvidence, kind: "tax_calculation" } });
  const checked = (refusal: ReturnType<typeof refused>) => {
    if (refusal.code === "money_amount_out_of_range") throw infrastructure("/payableMinor", refusal);
    return refusal;
  };
  if (composed.kind === "refused") return checked(composed);
  const unsigned = { ...composed.money, contractVersion: "commerce.v1", schemaVersion: 2, quoteId: randomUUID(),
    status: scope.invocation.purpose, moneyDigest: composed.moneyDigest } as const;
  const quote = validateQuote({ ...unsigned, quoteDigest: quoteDigest("commerce.quote.v2", unsigned) });
  if ("kind" in quote) return checked(quote);
  const successSeal = { kind, destination, requestDigest, validUntil, evidence,
    outcome: { kind: quote.status, quote }, contradiction: false, compositionDigest };
  return outcome(await completeTaxCalculation(deps.lane, { ...scope, calculationId, generation, claimToken,
    seal: successSeal as Complete["seal"], ...(adapter ? { adapter } : {}) }));
}

export async function createQuote(deps: DbBackedCommerceQuotePortV2Deps, owner: QuoteOwnerContext,
  admitted: CommerceQuoteV2Request, frames: QuoteFrames): Promise<QuoteOutcome> {
  const { key: evaluationKey, ...invocation } = admitted;
  if ((invocation.mode === "subscription") !== (invocation.cadence !== undefined)) return frames.invalid("/invocation/cadence");
  const scope = { identity: { ...owner, evaluationKey }, invocation };
  const lookup = await beginTaxCalculation(deps.lane, { ...scope, operation: "lookup" });
  if (lookup.kind !== "missing" && lookup.kind !== "pending") return lookup.kind === "claimed" ? integrity() : outcome(lookup);
  const ctx: DestinationContextV2 = { clientId: owner.clientId, scopeRef: owner.scopeRef, owner: {
    installationRef: owner.installationRef, principalKind: "customer", principalRef: owner.principalRef, customerOrSessionRef: owner.clientId,
  } };
  const fresh = lookup.kind === "missing" ? await freshPin(deps, owner, admitted, ctx, frames) : undefined;
  if (fresh && !("pin" in fresh)) return fresh;
  const recovery = fresh ? fresh.pin.recovery : deps.exclusive?.recovery;
  if (!fresh && !recovery) return pending();
  const claim = await beginTaxCalculation(deps.lane, { ...scope, operation: "claim", recovery: recovery ?? null,
    ...(fresh ? { pin: fresh.pin } : {}) });
  if (!fresh && claim.kind === "refused" && claim.code === "tax_adapter_unavailable") return pending();
  if (claim.kind !== "claimed") return outcome(claim);
  return finish(deps, ctx, scope, claim, frames);
}
