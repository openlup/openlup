import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { expect } from "vitest";
import { calculateCatalogueMoneyV2 } from "@openlup/core/pricing";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { commerceQuoteV2Schema, composeCommerceQuoteMoneyV2, planCommerceQuoteMoneyV2 } from "@openlup/platform/pricing";
import { applyTaxCoverageRevision, evaluationDigest, makeTaxQuoteRequest } from "@openlup/platform/tax";
import type { TaxCalculationEvidenceV1, TaxQuoteInputV1 } from "@openlup/platform/tax/contracts";
// eslint-disable-next-line no-restricted-imports -- build the fixture from the same checked snapshot as native completion
import { checkedQuoteResult, taxDigest, taxFiscalDigest } from "../../packages/platform/src/tax/digest.js";
import type { CommerceQuoteV2, CommerceQuoteMoneyV2 } from "@openlup/platform/pricing/contracts";
import type { AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { beginSql, bindEditedSeal, claim, completeSql, exclusiveKind, fiscalKind, fixture, invoke, quoteDigest, seal, type Claim } from "./commerceQuoteV2StorageFixture.js";
import { testServicePin } from "./destinationDocumentFixture.js";
import { allocations, buckets, fees, insert, itemTable, orderTable, positions, snapshots, sources, version } from "./orderMoneyV2Storage.fixture.js";

type Sku = { sku: string; id: string };
type Body = CommerceQuoteMoneyV2;
type Component = Body["lines"][number];
type Part = Body["deliveryBuckets"][number]["parts"][number];
type Store = Pick<AccountMutationsStore, "owner" | "runtime">;
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Begin = ReturnType<Fixture["begin"]>;
type Cell = TaxQuoteInputV1["required"][number];
type TaxRow = TaxCalculationEvidenceV1["positions"]["tax"][number];
type PromotionTarget = { id: string } & ({ lineKey: string } | { bucketKey: string });
const digest = "a".repeat(64);

function component(basis: number, taxPositions: Component["taxPositions"] = []) {
  const taxMinor = taxPositions.reduce((sum, position) => sum + position.taxMinor, 0);
  return {
    preDiscountMinor: basis, effectiveMinor: basis, netMinor: basis, taxMinor,
    lineTotalMinor: basis + taxMinor, discountAllocations: [], taxPositions,
  };
}

export function reseal(body: Body, quoteId: string = randomUUID()): CommerceQuoteV2 {
  const inner = { ...body, quoteId, status: "final", schemaVersion: 2, contractVersion: "commerce.v1",
    moneyDigest: quoteDigest("commerce.quote-money.v2", body) } as const;
  return { ...inner, quoteDigest: quoteDigest("commerce.quote.v2", inner) };
}

function comparableMoney(body: Body) {
  const { coverageDigest: _coverageDigest, taxEvidence: { calculationId: _calculationId, evidenceDigest: _evidenceDigest, ...taxEvidence },
    lines, deliveryBuckets, ...money } = body;
  const taxPositions = (positions: Part["taxPositions"]) =>
    positions.map(({ resolutionDigest: _resolutionDigest, ...position }) => position);
  const state = (value: Part["discountAllocations"][number]["before"]) =>
    ({ ...value, taxPositions: taxPositions(value.taxPositions) });
  const part = <T extends Part>(value: T) => ({
    ...value, taxPositions: taxPositions(value.taxPositions),
    discountAllocations: value.discountAllocations.map(allocation =>
      ({ ...allocation, before: state(allocation.before), after: state(allocation.after) })),
  });
  return { ...money, taxEvidence, lines: lines.map(part),
    deliveryBuckets: deliveryBuckets.map(bucket => ({ ...bucket, parts: bucket.parts.map(part) })) };
}

function taxPositionsFor(part: Part) {
  const assessments = new Map<string, Part["taxPositions"][number]>();
  for (const { taxPositions } of [...part.discountAllocations.flatMap(({ before, after }) => [before, after]), part]) {
    for (const position of taxPositions) assessments.set(position.positionRef, position);
  }
  return [...assessments.values()];
}

async function verifyExclusive(store: Store, value: Fixture, input: Begin, body: Body) {
  const composition = input.pin.composition!;
  const lines = body.lines.map(({ lineKey, sourceOrdinal, sku, mode, quantity, unitBasisMinor, taxClassKey, assignmentRef }) =>
    ({ lineKey, sourceOrdinal, sku, mode, quantity, unitBasisMinor, taxClassKey, assignmentRef, amountKind: "net" as const }));
  const delivery = body.deliveryBuckets.map(({ parts, ...bucket }) => ({ ...bucket, amountMinor: parts[0]!.preDiscountMinor }));
  const { selected, ...originalPlan } = composition.planInput;
  const baseline = { ...originalPlan.baseline, delivery, feeLines: [] };
  const planInput = { ...originalPlan, lines, baseline,
    ...(selected.adjustments.length ? { selected: { ...baseline, adjustments: selected.adjustments } } : {}) };
  const planned = planCommerceQuoteMoneyV2(planInput);
  if (planned.kind !== "planned") throw new Error(JSON.stringify(planned));
  const { amountBasis, ...plannedAmounts } = planned.moneyInput;
  if (amountBasis !== "exclusive") throw new Error("Expected an exclusive order money plan");
  const moneyInput = { ...plannedAmounts, amountBasis };

  const sample = value.fullInput.required[0]!;
  const parts = [...body.lines.map(line => ({ part: line, target: { kind: "line" as const, key: line.lineKey } })),
    ...body.deliveryBuckets.map(({ bucketKey, parts }) => ({ part: parts[0]!, target: { kind: "delivery" as const, key: bucketKey } }))];
  const tax: TaxRow[] = [];
  const unassessed: Cell[] = [];
  for (const { part, target } of parts) {
    const positions = taxPositionsFor(part);
    if (!positions.length) unassessed.push({ ...sample, target });
    for (const position of positions) {
      const { jurisdictionRef: jurisdiction, level, taxKind, rateDecimal, taxableMinor: _basis, taxMinor: _tax, ...metadata } = position;
      const cell = { ...sample, target, jurisdiction, level, taxKind };
      tax.push({ ...metadata, cell, resolutionDigest: taxDigest("resolution", metadata.resolution),
        ...(rateDecimal === undefined ? {} : { ratePercent: rateDecimal }) });
    }
  }

  const fees = body.feeLines.map(({ feeKey, jurisdictionRef: jurisdiction, feeKind, scope, refundRule, providerPositionRef }) =>
    ({ feeKey, jurisdiction, feeKind, refundRule,
      scope: scope.kind === "order" ? scope : { kind: "delivery" as const, key: scope.bucketKey },
      ...(providerPositionRef === undefined ? {} : { providerPositionRef }) }));
  const feeCells = fees.map(({ feeKey, jurisdiction, feeKind, scope }) => ({ ...sample, jurisdiction, taxKind: feeKind,
    target: { kind: "fee" as const, key: feeKey, taxClass: lines[0]!.taxClassKey, assignmentRef: lines[0]!.assignmentRef,
      ...(scope.kind === "delivery" ? { deliveryKey: scope.key } : {}) } }));
  // Distinct assessments can share a required cell. Keep each assessment's tax kind.
  const taxedCells = new Map(tax.map(row => [canonicalCatalogDraftJson(row.cell), row]));
  const required = [...Array.from(taxedCells.values(), row => row.cell), ...feeCells, ...unassessed];
  const declarationKey = ({ jurisdiction, taxKind }: Pick<Cell, "jurisdiction" | "taxKind">) => JSON.stringify([jurisdiction, taxKind]);
  const declarations = new Map(required.map(({ jurisdiction, taxKind }) =>
    [declarationKey({ jurisdiction, taxKind }), { ...value.fullInput.coverage.declarations[0]!, jurisdiction, taxKind }]));
  const coverage = { ...value.fullInput.coverage, revision: "coverage-b", declarations: [...declarations.values()] };
  const installed = await applyTaxCoverageRevision(store.owner, { expectedHead: value.fullInput.coverage.revision,
    document: { installationRef: input.identity.installationRef, accountRef: coverage.accountRef, coverage, actorRef: "fixture" } });
  if (!("coverageDigest" in installed)) throw new Error(JSON.stringify(installed));

  const request = makeTaxQuoteRequest(input.identity.evaluationKey, {
    ...value.fullInput, coverage, money: moneyInput, required,
    lines: lines.map(({ lineKey, sku, mode, taxClassKey, assignmentRef }) => ({ lineKey, sku, mode, taxClass: taxClassKey, assignmentRef })),
    delivery: delivery.map(({ bucketKey, carrierRef, serviceRef, separatelyStated, cost, taxClassKey, assignmentRef }) =>
      ({ bucketKey, carrierRef, serviceRef, separatelyStated, cost, taxClass: taxClassKey, assignmentRef })),
  });
  const exemptions = new Set(unassessed.map(cell => canonicalCatalogDraftJson(cell)));
  const vector: TaxCalculationEvidenceV1["coverage"]["vector"] = request.input.required.map(cell => {
    const declaration = declarations.get(declarationKey(cell))!;
    const key = canonicalCatalogDraftJson(cell);
    const exempt = exemptions.has(key);
    const position = taxedCells.get(key);
    return { cell, declaration, decision: exempt ? "in_scope_exempt" : "in_scope_taxed",
      registration: { state: "active", effective: declaration.effective, evidenceRef: "registration-a" },
      treatment: { kind: exempt ? "exempt" : "taxable", reason: position?.taxabilityReason ?? "registered", ruleRef: position?.ruleRef ?? "rule-a" } };
  });
  const { providerLines: _providerLines, ...previousEvidence } = value.adapterEvidence(input.identity.evaluationKey, randomUUID());
  const evidence = { ...previousEvidence, status: "final" as const, inputDigest: request.inputDigest,
    coverage: { vector, digest: taxDigest("coverage", vector) }, positions: { tax, fees } };
  evidence.fiscalDigest = taxFiscalDigest(evidence);

  const partsByTarget = new Map(parts.map(({ part, target }) => [JSON.stringify([target.kind, target.key]), part]));
  const money = calculateCatalogueMoneyV2(
    { ...moneyInput, fees: body.feeLines.map(({ feeKey, amountMinor }) => ({ feeKey, amountMinor })) },
    { kind: "provider", payableMinor: body.payableMinor, components: planned.plan.components.map(({ ref, preDiscountMinor, allocations }) => {
      const target = ref.kind === "merchandise" ? ["line", ref.lineKey] : ["delivery", ref.bucketKey];
      const part = partsByTarget.get(JSON.stringify(target))!;
      const stages = new Map(part.discountAllocations.map(step => [step.sequence, step.after.taxPositions]));
      stages.set(0, part.discountAllocations[0]?.before.taxPositions ?? part.taxPositions);
      const states = [{ afterSequence: 0, amountMinor: preDiscountMinor }, ...allocations.map(({ sequence, afterMinor }) =>
        ({ afterSequence: sequence, amountMinor: afterMinor }))];
      return { ref, states: states.map(state => ({ ...state, taxPositions: stages.get(state.afterSequence)!
        .map(({ positionRef, jurisdictionRef, rateDecimal, taxableMinor, taxMinor }) =>
          ({ positionRef, jurisdictionRef, ...(rateDecimal === undefined ? {} : { rateDecimal }), taxableMinor, taxMinor })) })) };
    }) });
  const checked = checkedQuoteResult(request, { kind: "final", money, evidence, evidenceDigest: taxDigest("evidence", evidence) });
  if ("kind" in checked || !checked.result) throw new Error(JSON.stringify(checked));
  const result = checked.result;
  const { address: _address, ...destination } = request.input.destination;
  const pin = { ...input.pin, request: { ...request, input: { ...request.input, destination } },
    requestDigest: evaluationDigest("evaluation-request", request),
    coverage: { ...input.pin.coverage!, revision: coverage.revision, digest: installed.coverageDigest },
    composition: { ...composition, catalogueEvidenceRef: body.catalogueEvidenceRef, planInput } };
  const invocation = { ...input.invocation, lines: lines.map(({ sku, quantity }) => ({ sku, quantity })) };
  const amounts = new Map(result.money.fees.map(({ feeKey, amountMinor }) => [feeKey, amountMinor]));
  const { catalogueEvidenceRef, mode, cadence, paymentLimits } = body;
  const composed = composeCommerceQuoteMoneyV2({ planInput, taxEvidence: { ...body.taxEvidence, kind: exclusiveKind },
    verifiedMoney: result.money, facts: { catalogueEvidenceRef, mode, ...(cadence ? { cadence } : {}), destination: body.destination,
      coverageDigest: result.evidence.coverage.digest, paymentLimits },
    positions: result.evidence.positions.tax.map(({ cell, ratePercent: _rate, ...metadata }) =>
      ({ ...metadata, jurisdictionRef: cell.jurisdiction, level: cell.level, taxKind: cell.taxKind })),
    feeLines: result.evidence.positions.fees.map(({ jurisdiction, scope, ...fee }) =>
      ({ ...fee, jurisdictionRef: jurisdiction, amountMinor: amounts.get(fee.feeKey)!,
        scope: scope.kind === "order" ? scope : { kind: "delivery", bucketKey: scope.key } })),
    allocationIds: result.money.components.flatMap(({ ref, allocations }) => {
      const target = ref.kind === "merchandise" ? ["line", ref.lineKey] : ["delivery", ref.bucketKey];
      const part = partsByTarget.get(JSON.stringify(target))!;
      return allocations.map(({ sequence }) => ({ ref, sequence,
        allocationId: part.discountAllocations.find(step => step.sequence === sequence)!.allocationId }));
    }),
  });
  if (composed.kind !== "composed") throw new Error(JSON.stringify(composed));
  return { input: { ...input, pin, invocation }, money: composed.money, result, evidence: {
    adapterEvidence: result.evidence, adapterDigest: result.evidenceDigest,
    compositionDigest: evaluationDigest("evaluation-composition", pin.composition),
  } };
}

export async function issue(store: Store, sku: Sku, inclusive: boolean,
  edit: (body: Body) => Body = body => body,
  { pending = false, legacySeal = false, promotions = [], paymentBounds, context, measureCompletion = false }: {
    pending?: boolean; legacySeal?: boolean; promotions?: readonly PromotionTarget[];
    context?: Parameters<typeof fixture>[2];
    paymentBounds?: Pick<Body["paymentLimits"], "minMinor" | "maxMinor">;
    measureCompletion?: boolean;
  } = {}) {
  const at = (await store.owner.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
  const value = await fixture(store, at.toISOString(), context);
  const input = value.begin(inclusive ? fiscalKind : exclusiveKind, !legacySeal);
  if (paymentBounds && input.pin.composition) {
    Object.assign(input.pin.composition.limits, paymentBounds, { effective: paymentBounds });
  }
  if (input.pin.composition && (promotions.length || !inclusive)) {
    input.pin.composition.planInput.selected.adjustments = promotions.map(promotion => ({
      amountOffMinor: 1, adjustmentRef: promotion.id, evidenceRef: "b".repeat(64),
      ...("lineKey" in promotion
        ? { appliesTo: "line", target: { lineKeys: [promotion.lineKey] } } as const
        : { appliesTo: "shipping", target: { bucketKey: promotion.bucketKey } } as const),
    }));
  }
  if (promotions.length) {
    await store.owner.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id, definition)
      SELECT id, jsonb_build_object('id',id,'status','active','trigger_type','automatic',
        'discount_type','fixed_amount','applies_to_kind','line_with_variant','stacking_rule','exclusive',
        'eligibility','{}'::jsonb,'applies_to_payload','{}'::jsonb,'region_availability','[]'::jsonb)
      FROM unnest($1::text[]) AS promotion(id)`, [promotions.map(({ id }) => id)]);
  }
  const template: Claim = { kind: "claimed", calculationId: randomUUID(), generation: 1, claimToken: randomUUID(),
    pin: { invocationDigest: digest, requestDigest: input.pin.requestDigest } };
  const original = seal(value, input, template).seal.outcome.quote;
  const baselinePosition = original.lines[0]!.taxPositions[0]!;
  const first = { ...original.lines[0]!, sku: sku.sku, ...component(100, [{ ...baselinePosition, taxableMinor: 100 }]) };
  const { quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract,
    moneyDigest: _money, quoteDigest: _quote, ...bare } = original;
  const body = edit({
    ...bare, paymentLimits: { ...bare.paymentLimits, ...(legacySeal ? { revision: "1" } : {}) },
    lines: [first], deliveryBuckets: [], feeLines: [], netTotal: 100, taxTotal: 0, feeTotal: 0, payableMinor: 100,
  } as Body);
  const verified = inclusive ? undefined : await verifyExclusive(store, value, input, body);
  if (verified) expect(comparableMoney(verified.money)).toStrictEqual(comparableMoney(body));
  const grant = verified ? await invoke<Claim>(store.runtime, beginSql, verified.input) : await claim(input, store.runtime);
  expect(grant).toMatchObject({ kind: "claimed", generation: 1 });
  const command = seal(value, input, grant);
  const money = verified?.money ?? body;
  const taxEvidence = { ...money.taxEvidence, calculationId: grant.calculationId };
  const quote = reseal({ ...money, taxEvidence } as Body);
  const complete = bindEditedSeal({ ...command, invocation: verified?.input.invocation ?? command.invocation,
    seal: { ...command.seal, requestDigest: grant.pin.requestDigest,
      outcome: { ...command.seal.outcome, quote: quote as typeof original } } }, grant, verified?.evidence ?? command.seal.evidence);

  let completionBytes: { base: number; supplement: number; assembled: number } | undefined;
  if (!pending) {
    const wire = verified
      ? { ...complete, seal: { ...complete.seal, adapterMoneyResult: verified.result.money } }
      : complete;
    if (measureCompletion) {
      const text = JSON.stringify(wire);
      const { rows: [sizes] } = await store.owner.query<{ base: number; supplement: number }>(`WITH request AS (SELECT $1::jsonb AS value)
        SELECT octet_length(public.catalog_publication_canonical(value #- '{seal,adapterMoneyResult}',0)) AS base,
          octet_length(public.catalog_publication_canonical(value #> '{seal,adapterMoneyResult}',0)) AS supplement FROM request`, [text]);
      completionBytes = { ...sizes!, assembled: Buffer.byteLength(text) };
    }
    const result = await invoke<{ kind: string; outcome?: { quote?: { quoteId: string } } }>(store.runtime, completeSql, wire);
    expect(result.kind).toBe("terminal");
    expect(result.outcome?.quote?.quoteId).toBe(quote.quoteId);
  }
  return { quote: commerceQuoteV2Schema.parse(complete.seal.outcome.quote), clientId: value.ctx.clientId,
    selection: value.issued.selection, service: testServicePin, completionBytes };
}
export type Evidence = Awaited<ReturnType<typeof issue>>;

function amounts(value: Pick<Component, "preDiscountMinor" | "effectiveMinor" | "netMinor" | "taxMinor">) {
  return { pre_discount_minor: value.preDiscountMinor, effective_minor: value.effectiveMinor,
    net_minor: value.netMinor, tax_minor: value.taxMinor };
}

export async function write(db: PoolClient, evidence: Evidence, sku: Sku,
  opts: { orderId?: string; snapshot?: Record<string, unknown>; item?: Record<string, unknown>; source?: Record<string, unknown>;
    moneyVersion?: string;
    erased?: boolean; clientId?: string; bucketErased?: boolean; snapshotFirst?: boolean;
    beforeSnapshot?: () => Promise<unknown>; beforeSource?: () => Promise<unknown> } = {}) {
  const { quote, clientId, selection, service } = evidence;
  const id = opts.orderId ?? randomUUID();
  const erased = opts.erased ?? false;
  await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
  await db.query("SELECT 1 FROM public.clients WHERE id=$1 FOR UPDATE", [opts.clientId ?? clientId]);
  const writeHeader = () => insert(db, orderTable, { id, client_id: opts.clientId ?? clientId, status: "pending_payment",
    money_version: opts.moneyVersion ?? version, currency_code: quote.currency, total_amount_minor: quote.payableMinor });
  const writeSnapshot = () => insert(db, snapshots, {
    order_id: id, calculation_id: quote.taxEvidence.calculationId, accepted_quote_id: quote.quoteId,
    accepted_quote_digest: quote.quoteDigest, token_digest: digest, accepted_money_digest: quote.moneyDigest,
    evidence_digest: quote.taxEvidence.evidenceDigest, coverage_digest: quote.coverageDigest,
    destination_snapshot_ref: quote.destination.snapshotRef, destination_digest: erased ? null : quote.destination.destinationDigest,
    destination_policy_revision: erased ? null : quote.destination.policyRevision,
    delivery_selection_ref: erased ? null : quote.deliverySelectionRef, destination_erased: erased, acceptance_ref: "acceptance",
    price_list_ref: quote.price.priceListRef, price_context_digest: quote.price.priceContextDigest,
    price_evidence_ref: quote.price.priceEvidenceRef, class_map_revision: quote.price.classMapRevision,
    catalogue_evidence_ref: quote.catalogueEvidenceRef, limit_profile_ref: quote.paymentLimits.profileRef,
    limit_channel_key: quote.paymentLimits.channelKey, limit_revision: Number(quote.paymentLimits.revision),
    limit_min_minor: quote.paymentLimits.minMinor, limit_max_minor: quote.paymentLimits.maxMinor,
    money_version: opts.moneyVersion ?? version, amount_basis: quote.amountBasis, currency: quote.currency, mode: quote.mode,
    promotion_engine: quote.promotion.engine, cadence_days: quote.cadence?.days,
    tax_date: quote.taxEvidence.taxDate, evaluation_expires_at: quote.taxEvidence.expiresAt,
    net_total: quote.netTotal, tax_total: quote.taxTotal, fee_total: quote.feeTotal, payable_minor: quote.payableMinor,
    ...opts.snapshot,
  });

  if (opts.snapshotFirst) await writeSnapshot();
  await writeHeader();
  await opts.beforeSnapshot?.();
  if (!opts.snapshotFirst) await writeSnapshot();
  await insert(db, "commerce_destination_v2_order_bindings", {
    order_id: id, snapshot_ref: quote.destination.snapshotRef, selection: erased ? null : selection, service: erased ? null : service,
  });

  const adjustments = new Map<string, string>();
  const addPositions = async (items: Component["taxPositions"], target: Record<string, unknown>, side = "final", slot = 0, allocation?: string) => {
    for (const [index, item] of items.entries()) {
      await insert(db, positions, { order_id: id, ...target, position_ref: item.positionRef, rule_ref: item.ruleRef,
        assignment_ref: item.resolution.assignmentRef, policy_revision: item.resolution.policyRevision,
        resolution_source_ref: item.resolution.sourceRef, resolution_source_digest: item.resolution.sourceDigest,
        resolution_digest: item.resolutionDigest, jurisdiction_ref: item.jurisdictionRef, taxability_reason: item.taxabilityReason,
        provider_line_ref: item.providerLineRef, state_side: side, level: item.level, tax_kind: item.taxKind,
        rate_decimal: item.rateDecimal, allocation_id: allocation, allocation_slot: slot, position_rank: index + 1,
        effective_from: item.resolution.effective.from, effective_until: item.resolution.effective.until,
        taxable_minor: item.taxableMinor, tax_minor: item.taxMinor });
    }
  };
  const addComponent = async (value: Pick<Component, "taxPositions" | "discountAllocations">, target: Record<string, unknown>) => {
    await addPositions(value.taxPositions, target);
    for (const a of value.discountAllocations) {
      let adjustmentId = adjustments.get(a.adjustmentRef);
      if (adjustmentId === undefined) {
        adjustmentId = randomUUID();
        adjustments.set(a.adjustmentRef, adjustmentId);
        const total = [...quote.lines, ...quote.deliveryBuckets.flatMap(bucket => bucket.parts)]
          .flatMap(item => item.discountAllocations).filter(item => item.adjustmentRef === a.adjustmentRef)
          .reduce((sum, item) => sum + item.basisReductionMinor, 0);
        await insert(db, "commerce_order_adjustments", { id: adjustmentId, order_id: id, kind: "promotion_discount",
          scope: target.bucket_key ? "shipping" : "line", amount_minor: total,
          promotion_id: a.adjustmentRef, definition_fingerprint: a.evidenceRef });
      }
      await insert(db, allocations, { order_id: id, ...target, allocation_id: a.allocationId, adjustment_id: adjustmentId,
        adjustment_ref: a.adjustmentRef, evidence_ref: a.evidenceRef, sequence: a.sequence,
        basis_reduction_minor: a.basisReductionMinor, net_reduction_minor: a.netReductionMinor, tax_reduction_minor: a.taxReductionMinor,
        before_basis_minor: a.before.basisMinor, before_net_minor: a.before.netMinor, before_tax_minor: a.before.taxMinor,
        after_basis_minor: a.after.basisMinor, after_net_minor: a.after.netMinor, after_tax_minor: a.after.taxMinor });
      await addPositions(a.before.taxPositions, target, "before", a.sequence, a.allocationId);
      await addPositions(a.after.taxPositions, target, "after", a.sequence, a.allocationId);
    }
  };

  let ordinal = 0;
  const itemIds: string[] = [];
  for (const [index, row] of quote.lines.entries()) {
    const writeSource = async () => {
      await insert(db, sources, { order_id: id, sku_id: sku.id, sku_code: row.sku, line_key: row.lineKey,
        tax_class_key: row.taxClassKey, assignment_ref: row.assignmentRef, mode: row.mode,
        source_ordinal: row.sourceOrdinal, source_rank: index + 1, quantity: row.quantity, unit_basis_minor: row.unitBasisMinor,
        ...amounts(row), ...(index === 0 ? opts.source : {}) });
      await addComponent(row, { line_key: row.lineKey });
    };
    if (!opts.beforeSource) await writeSource();
    const unit = Math.floor(row.effectiveMinor / row.quantity);
    const extras = row.effectiveMinor % row.quantity;
    const split = [[row.quantity - extras, unit], ...(extras ? [[extras, unit + 1]] : [])];
    for (const [quantity, price] of split) {
      const itemId = randomUUID();
      const promoted = row.preDiscountMinor !== row.effectiveMinor;
      const position = promoted ? ++ordinal : row.sourceOrdinal;
      ordinal = Math.max(ordinal, position);
      await insert(db, itemTable, { id: itemId, order_id: id, sku_id: sku.id, line_ordinal: position,
        quantity, unit_amount_minor: price, line_amount_minor: price * quantity, line_key: row.lineKey,
        ...(promoted ? { source_line_ordinal: row.sourceOrdinal, catalog_unit_amount_minor: row.unitBasisMinor,
          catalog_line_amount_minor: row.unitBasisMinor * quantity, promotion_discount_allocated_minor: (row.unitBasisMinor - price) * quantity,
          promotion_allocation_fingerprint: digest } : {}), ...(itemIds.length === 0 ? opts.item : {}) });
      itemIds.push(itemId);
    }
    if (opts.beforeSource) {
      await opts.beforeSource();
      await writeSource();
    }
  }
  for (const [index, bucket] of quote.deliveryBuckets.entries()) {
    const bucketErased = opts.bucketErased ?? erased;
    await insert(db, buckets, { order_id: id, bucket_key: bucket.bucketKey, part_no: 0, bucket_rank: index + 1,
      tax_class_key: bucket.taxClassKey, assignment_ref: bucket.assignmentRef, cost_ref: bucket.cost.ref, kind: bucket.kind,
      cost_currency: bucket.cost.currency, cost_amount_minor: bucket.cost.amountMinor, separately_stated: bucket.separatelyStated,
      carrier_ref: bucketErased ? null : bucket.carrierRef, service_ref: bucketErased ? null : bucket.serviceRef, destination_erased: bucketErased });
    for (const [part, value] of bucket.parts.entries()) {
      const target = { bucket_key: bucket.bucketKey, part_no: part + 1 };
      await insert(db, buckets, { order_id: id, ...target, source_ordinal: value.sourceOrdinal, ...amounts(value) });
      await addComponent(value, target);
    }
  }
  const shipping = quote.deliveryBuckets.filter(bucket => bucket.kind === "shipping")
    .flatMap(bucket => bucket.parts).reduce((sum, part) => sum + part.preDiscountMinor, 0);
  if (shipping > 0) await insert(db, "commerce_order_adjustments", { order_id: id, kind: "shipping_charge", scope: "shipping", amount_minor: shipping });
  for (const [index, fee] of quote.feeLines.entries()) {
    await insert(db, fees, { order_id: id, fee_key: fee.feeKey, fee_rank: index + 1, fee_kind: fee.feeKind,
      jurisdiction_ref: fee.jurisdictionRef, amount_minor: fee.amountMinor, scope_kind: fee.scope.kind,
      ...(fee.scope.kind === "delivery" ? { bucket_key: fee.scope.bucketKey, bucket_part_no: 0 } : {}),
      refund_rule_ref: fee.refundRule.ref, refund_rule_revision: fee.refundRule.revision, provider_position_ref: fee.providerPositionRef });
  }
  return { id, itemIds };
}
