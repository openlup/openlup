import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { expect } from "vitest";
import { commerceQuoteV2Schema } from "@openlup/platform/pricing";
import type { CommerceQuoteV2, CommerceQuoteMoneyV2 } from "@openlup/platform/pricing/contracts";
import type { AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { bindEditedSeal, claim, completeSql, exclusiveKind, fiscalKind, fixture, invoke, quoteDigest, seal } from "./commerceQuoteV2StorageFixture.js";
import { testServicePin } from "./destinationDocumentFixture.js";
import { allocations, buckets, fees, insert, itemTable, orderTable, positions, snapshots, sources, version } from "./orderMoneyV2Storage.fixture.js";

type Sku = { sku: string; id: string };
type Body = CommerceQuoteMoneyV2;
type Component = Body["lines"][number];
type PromotionTarget = { id: string } & ({ lineKey: string } | { bucketKey: string });
const digest = "a".repeat(64);

function component(basis: number, taxPositions: Component["taxPositions"] = []) {
  const taxMinor = taxPositions.reduce((sum, position) => sum + position.taxMinor, 0);
  return {
    preDiscountMinor: basis, effectiveMinor: basis, netMinor: basis, taxMinor,
    lineTotalMinor: basis + taxMinor, discountAllocations: [], taxPositions,
  };
}

export function reseal(body: Body, quoteId = randomUUID()): CommerceQuoteV2 {
  const inner = { ...body, quoteId, status: "final", schemaVersion: 2, contractVersion: "commerce.v1",
    moneyDigest: quoteDigest("commerce.quote-money.v2", body) } as const;
  return { ...inner, quoteDigest: quoteDigest("commerce.quote.v2", inner) };
}

export async function issue(store: Pick<AccountMutationsStore, "owner" | "runtime">, sku: Sku, inclusive: boolean,
  edit: (body: Body) => Body = body => body,
  { pending = false, legacySeal = false, promotions = [] }: {
    pending?: boolean; legacySeal?: boolean; promotions?: readonly PromotionTarget[];
  } = {}) {
  const at = (await store.owner.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
  const value = await fixture(store, at.toISOString());
  const input = value.begin(inclusive ? fiscalKind : exclusiveKind, !legacySeal);
  if (promotions.length > 0) {
    const plan = input.pin.composition!.planInput;
    plan.selected.adjustments = promotions.map(promotion => ({
      amountOffMinor: 1, adjustmentRef: promotion.id, evidenceRef: "b".repeat(64),
      ...("lineKey" in promotion
        ? { appliesTo: "line", target: { lineKeys: [promotion.lineKey] } } as const
        : { appliesTo: "shipping", target: { bucketKey: promotion.bucketKey } } as const),
    }));
    await store.owner.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id, definition)
      SELECT id, jsonb_build_object('id',id,'status','active','trigger_type','automatic',
        'discount_type','fixed_amount','applies_to_kind','line_with_variant','stacking_rule','exclusive',
        'eligibility','{}'::jsonb,'applies_to_payload','{}'::jsonb,'region_availability','[]'::jsonb)
      FROM unnest($1::text[]) AS promotion(id)`, [promotions.map(({ id }) => id)]);
  }
  const grant = await claim(input, store.runtime);
  const command = seal(value, input, grant);
  const original = command.seal.outcome.quote;
  const baselinePosition = original.lines[0]!.taxPositions[0]!;
  const first = { ...original.lines[0]!, sku: sku.sku, ...component(100, [{
    ...baselinePosition, taxableMinor: 100,
  }]) };
  const { quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract,
    moneyDigest: _money, quoteDigest: _quote, ...bare } = original;
  const body = edit({
    ...bare, paymentLimits: { ...bare.paymentLimits, ...(legacySeal ? { revision: "1" } : {}) }, lines: [first], deliveryBuckets: [], feeLines: [], netTotal: 100, taxTotal: 0, feeTotal: 0, payableMinor: 100,
  } as Body);
  const quote = reseal(body);
  const complete = bindEditedSeal({ ...command, seal: { ...command.seal,
    outcome: { ...command.seal.outcome, quote: quote as typeof original } } }, grant);
  if (!pending) {
    const result = await invoke<{ kind: string; outcome?: { quote?: { quoteId: string } } }>(store.runtime, completeSql, complete);
    expect(result.kind).toBe("terminal");
    expect(result.outcome?.quote?.quoteId).toBe(quote.quoteId);
  }
  return { quote: commerceQuoteV2Schema.parse(complete.seal.outcome.quote), clientId: value.ctx.clientId,
    selection: value.issued.selection, service: testServicePin };
}
export type Evidence = Awaited<ReturnType<typeof issue>>;

function amounts(value: Pick<Component, "preDiscountMinor" | "effectiveMinor" | "netMinor" | "taxMinor">) {
  return { pre_discount_minor: value.preDiscountMinor, effective_minor: value.effectiveMinor,
    net_minor: value.netMinor, tax_minor: value.taxMinor };
}

export async function write(db: PoolClient, evidence: Evidence, sku: Sku,
  opts: { orderId?: string; snapshot?: Record<string, unknown>; item?: Record<string, unknown>; source?: Record<string, unknown>;
    erased?: boolean; clientId?: string; bucketErased?: boolean; snapshotFirst?: boolean;
    beforeSnapshot?: () => Promise<unknown> } = {}) {
  const { quote, clientId, selection, service } = evidence;
  const id = opts.orderId ?? randomUUID();
  const erased = opts.erased ?? false;
  await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
  await db.query("SELECT 1 FROM public.clients WHERE id=$1 FOR UPDATE", [opts.clientId ?? clientId]);
  const writeHeader = () => insert(db, orderTable, { id, client_id: opts.clientId ?? clientId, status: "pending_payment",
    money_version: version, currency_code: quote.currency, total_amount_minor: quote.payableMinor });
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
    money_version: version, amount_basis: quote.amountBasis, currency: quote.currency, mode: quote.mode,
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
    await insert(db, sources, { order_id: id, sku_id: sku.id, sku_code: row.sku, line_key: row.lineKey,
      tax_class_key: row.taxClassKey, assignment_ref: row.assignmentRef, mode: row.mode,
      source_ordinal: row.sourceOrdinal, source_rank: index + 1, quantity: row.quantity, unit_basis_minor: row.unitBasisMinor,
      ...amounts(row), ...(index === 0 ? opts.source : {}) });
    await addComponent(row, { line_key: row.lineKey });
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
