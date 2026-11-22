import { isDeepStrictEqual } from "node:util";
import { checked, invalid, oneOf } from "../contracts/decode.js";
import { taxCommitRequestV1Schema, taxReverseRequestV1Schema } from "../contracts/index.js";
import type { TaxCommitRequestV1, TaxRefusal, TaxRefusalCode, TaxReverseRequestV1, TaxScopeV1, TaxUnavailable } from "../contracts/index.js";
import { instant } from "../contracts/schemas.js";
import { taxDigest, verifyTaxQuoteResult } from "../digest.js";
import {
  checkScope, epoch, fields, id, incomplete, isProviderRejection, matchesEcho, member, nullable, readPages, record,
  StripeQuoteUnavailable, text,
} from "./client.js";
import type { RefundReservation, ReversalParams, SaleParams } from "./effects.js";
import type { StripeTaxAdapterOptions } from "./index.js";
import { planQuote } from "./plan.js";

const signed = checked((value): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && !Object.is(value, -0), "Obtain an exact integer amount in minor units.");
const charge = { amount: signed, amount_tax: signed, tax_behavior: oneOf("exclusive"), tax_code: text };
const transaction = fields({
  id, object: oneOf("tax.transaction"), type: oneOf("transaction", "reversal"), reference: text,
  currency: text, posted_at: epoch, tax_date: epoch, created: epoch, metadata: fields({ openlup_request_digest: text }),
  reversal: nullable(fields({ original_transaction: id })), shipping_cost: nullable(fields(charge)),
});
const line = fields({
  ...charge, id, object: oneOf("tax.transaction_line_item"), type: oneOf("transaction", "reversal"),
  reference: text, quantity: signed, reversal: nullable(fields({ original_line_item: id })),
});
type ExpectedUnit = { originalPositionRef: string; reference: string; amount: number; amount_tax: number; tax_code: string;
  quantity?: number; postedPositionRef?: string };
type Expected = {
  currency: string; taxDate: string; postedAt?: string; original?: string; full?: boolean;
  lines: ExpectedUnit[]; shipping?: ExpectedUnit;
};
type ProviderReceipt = { id: string; positions: { originalPositionRef: string; postedPositionRef: string }[] };

export function refuseError(error: unknown): TaxRefusal {
  if (error instanceof Error && "field" in error && "code" in error) {
    return { kind: "refused", code: error.code as TaxRefusalCode, field: error.field as string, remedy: error.message };
  }
  throw error;
}

export function assertScope(actual: TaxScopeV1, expected: TaxScopeV1, field: string) {
  for (const key of ["adapter", "adapterVersion", "accountRef", "mode"] as const) {
    if (actual[key] !== expected[key]) invalid(field + "/" + key, "Use the adapter's pinned account and mode.", "tax_scope_mismatch");
  }
}

export function assertClientScope(options: StripeTaxAdapterOptions) {
  const { accountRef, mode } = options.marketPack.scope;
  if (options.client.scope.accountRef !== accountRef || options.client.scope.mode !== mode) {
    invalid("/client/scope", "The client scope differs from the market pack. Supply a client for the pinned account and mode.", "tax_scope_mismatch");
  }
}

function verifyUnit(actual: ReturnType<typeof line> | NonNullable<ReturnType<typeof transaction>["shipping_cost"]>,
  expected: ExpectedUnit, path: string) {
  for (const key of ["amount", "amount_tax", "tax_code"] as const) matchesEcho(actual[key], expected[key], path + "/" + key);
}

async function verifyReceipt(options: StripeTaxAdapterOptions, response: unknown, wire: SaleParams | ReversalParams,
  expected: Expected, candidate?: string): Promise<ProviderReceipt> {
  const path = "/transaction";
  const scope = options.marketPack.scope;
  const source = record(response, path);
  checkScope(source, path, scope, true);
  const row = transaction(response, path);
  if (candidate) matchesEcho(row.id, candidate, path + "/id");
  const type = expected.original ? "reversal" : "transaction";
  matchesEcho(row.type, type, path + "/type");
  matchesEcho(row.reversal?.original_transaction ?? null, expected.original ?? null, path + "/reversal");
  matchesEcho(row.reference, wire.reference, path + "/reference");
  matchesEcho(row.metadata.openlup_request_digest, wire.metadata.openlup_request_digest, path + "/metadata/openlup_request_digest");
  matchesEcho(row.currency, expected.currency.toLowerCase(), path + "/currency");
  matchesEcho(row.tax_date, expected.taxDate, path + "/tax_date");
  if (expected.postedAt) matchesEcho(row.posted_at, expected.postedAt, path + "/posted_at");
  if (row.posted_at > row.created) incomplete(path + "/created", "Creation precedes liability posting.");
  const shipping = member(source, "shipping_cost", path + "/shipping_cost");
  if (shipping !== null) checkScope(record(shipping, path + "/shipping_cost"), path + "/shipping_cost", scope);

  const byReference = new Map(expected.lines.map(unit => [unit.postedPositionRef ?? unit.reference, unit]));
  const url = "/v1/tax/transactions/" + row.id + "/line_items";
  const positions = await readPages(url, path + "/line_items", scope,
    page => options.client.transactions.listLineItems(row.id, page), (value, field) => {
      const item = record(value, field);
      checkScope(item, field, scope, true);
      const parent = member(item, "transaction", field + "/transaction");
      if (parent !== undefined) matchesEcho(parent, row.id, field + "/transaction");
      const decoded = line(value, field);
      matchesEcho(decoded.type, type, field + "/type");
      if (!expected.original) matchesEcho(decoded.reversal, null, field + "/reversal");
      const key = expected.original ? decoded.reversal?.original_line_item ?? "" : decoded.reference;
      const unit = byReference.get(key);
      if (!unit) incomplete(field + "/reference", "The reporting line is unexpected or repeated.");
      byReference.delete(key);
      if (!expected.full) matchesEcho(decoded.reference, unit.reference, field + "/reference");
      if (unit.quantity !== undefined) matchesEcho(decoded.quantity, unit.quantity, field + "/quantity");
      verifyUnit(decoded, unit, field);
      return { id: decoded.id, originalPositionRef: unit.originalPositionRef, postedPositionRef: decoded.id };
    }, member(source, "line_items", path + "/line_items"));
  if (byReference.size) incomplete(path + "/line_items", "The reporting line set is incomplete.");
  if (expected.shipping) {
    if (!row.shipping_cost) incomplete(path + "/shipping_cost", "The reporting shipping unit is missing.");
    verifyUnit(row.shipping_cost, expected.shipping, path + "/shipping_cost");
    const alias = "shipping:" + row.id;
    positions.push({ id: alias, originalPositionRef: expected.shipping.originalPositionRef, postedPositionRef: alias });
  } else matchesEcho(row.shipping_cost, null, path + "/shipping_cost");
  return { id: row.id, positions: positions.map(({ originalPositionRef, postedPositionRef }) => ({
    originalPositionRef, postedPositionRef,
  })).sort((a, b) => a.originalPositionRef < b.originalPositionRef ? -1 : 1) };
}

function binding(options: StripeTaxAdapterOptions, operation: "commit" | "reverse", ref: string,
  request: TaxCommitRequestV1 | TaxReverseRequestV1, digest: string) {
  const { intent: _intent, ...body } = request;
  if (taxDigest(operation, body) !== digest) {
    invalid("/" + (operation === "commit" ? "transactionRef" : "reversalRef"),
      "The reference is reserved for a different request. Replay the original request and digest.", "tax_reference_conflict");
  }
  const reference = "ol-tax-" + taxDigest("commit", [options.installationRef, options.marketPack.scope, ref]);
  return { reference, idempotencyKey: "ol-tax-" + operation + "-" + reference.slice(7) };
}

type Send = NonNullable<ReturnType<StripeTaxAdapterOptions["effects"]["commit"]>>["send"];
const uncertain = (transport = false): TaxUnavailable => ({
  kind: "unavailable", code: transport ? "tax_adapter_unavailable" : "tax_coverage_evidence_unavailable", effect: "unknown",
});

async function execute(
  options: StripeTaxAdapterOptions, wire: SaleParams | ReversalParams, expected: Expected,
  idempotencyKey: string, send: Send, intent: TaxCommitRequestV1["intent"],
  apply: (key: string) => Promise<unknown>, beforeSend?: (now: string) => void,
): Promise<ProviderReceipt | TaxRefusal | TaxUnavailable> {
  const candidate = options.effects.findTransactionIdByReference(wire.reference);
  if (candidate !== undefined || intent === "recover" || send.kind === "unknown") {
    if (!candidate) return uncertain();
    try {
      id(candidate, "/transaction/id");
      const result = await options.client.transactions.retrieve(candidate);
      return await verifyReceipt(options, result, wire, expected, candidate);
    } catch (error) { return uncertain(!isProviderRejection(error) && !(error instanceof Error && "field" in error)); }
  }
  const now = options.now().toISOString();
  beforeSend?.(now);
  if (now >= instant(send.before, "/reservation/send/before")) {
    invalid("/intent", "The reserved send window elapsed. Reconcile the original reporting reference.", "tax_operation_unsupported");
  }
  assertClientScope(options);
  let result: unknown;
  try {
    result = await apply(idempotencyKey);
  } catch (error) {
    if (isProviderRejection(error) && error.code !== "tax_reference_conflict") return refuseError(error);
    return uncertain(!isProviderRejection(error));
  }
  try {
    return await verifyReceipt(options, result, wire, expected);
  } catch (error) { return uncertain(error instanceof StripeQuoteUnavailable); }
}

export async function commit(options: StripeTaxAdapterOptions, input: TaxCommitRequestV1) {
  try {
    const request = taxCommitRequestV1Schema.parse(input);
    const { calculationRef, transactionRef, postedAt, capturedAt, captureEvidenceRef, intent } = request;
    const reservation = options.effects.commit(transactionRef);
    if (!reservation) invalid("/transactionRef", "No effect is reserved. Reserve the verified capture before posting.", "tax_calculation_unusable");
    const { reference, idempotencyKey } = binding(options, "commit", transactionRef, request, reservation.requestDigest);
    assertScope(calculationRef.scope, options.marketPack.scope, "/calculationRef/scope");
    assertClientScope(options);
    const accepted = options.effects.accepted(calculationRef);
    if (!accepted || accepted.result.kind !== "final") {
      invalid("/calculationRef", "The accepted final quote is missing. Supply the original quote and evidence.", "tax_calculation_unusable");
    }
    const { result, request: original } = accepted;
    const refusal = verifyTaxQuoteResult(original, result);
    if (refusal) return refusal;
    const { evidence, evidenceDigest, money } = result;
    assertScope(evidence.scope, calculationRef.scope, "/calculationRef/scope");
    if (evidence.calculationRef !== calculationRef.ref || evidenceDigest !== calculationRef.evidenceDigest) {
      invalid("/calculationRef", "The accepted calculation differs. Replay the original calculation reference and digest.", "tax_reference_conflict");
    }
    id(calculationRef.ref, "/calculationRef/ref");
    const { currency } = original.input;
    if (!isDeepStrictEqual(reservation.capture, { ref: captureEvidenceRef, currency, payableMinor: money.payableMinor, capturedAt })) {
      invalid("/captureEvidenceRef", "The verified capture differs from this quote. Use its exact amount, currency and capture instant.", "tax_reference_conflict");
    }
    const { vector } = evidence.coverage;
    if (!vector.some(row => row.decision === "in_scope_taxed" || row.decision === "in_scope_exempt")
      || evidence.positions.fees.length || vector.some(row => row.cell.target.kind === "fee" && row.decision !== "out_of_scope")) {
      invalid("/calculationRef", "This calculation skips reporting or has unqualified fee reporting. Use a reportable fee-free calculation.", "tax_operation_unsupported");
    }
    const { taxDate } = evidence;
    const postedSeconds = Date.parse(postedAt) / 1000;
    if (!Number.isInteger(postedSeconds) || postedAt < taxDate || postedSeconds < 0) {
      invalid("/postedAt", "Pin a whole-second posting time on or after the calculation tax instant.");
    }
    const plan = planQuote(original.input, options.marketPack);
    const lines: ExpectedUnit[] = [];
    let shipping: ExpectedUnit | undefined;
    const refs = new Map<string, Set<string>>();
    for (const { cell, providerLineRef } of evidence.positions.tax) {
      if (cell.target.kind !== "line" || !providerLineRef) continue;
      const lineRefs = refs.get(cell.target.key) ?? new Set<string>();
      lineRefs.add(providerLineRef);
      refs.set(cell.target.key, lineRefs);
    }
    for (const { source, code, effectiveMinor } of plan.components) {
      const component = money.components.find(({ ref }) => source
        ? ref.kind === "merchandise" && ref.lineKey === source.lineKey : ref.kind === "delivery");
      if (!component) incomplete("/money/components", "The accepted reporting component is missing.");
      const amounts = { amount: effectiveMinor, amount_tax: component.final.taxMinor, tax_code: code };
      if (source) {
        const ids = refs.get(source.lineKey);
        if (ids?.size !== 1) {
          invalid("/calculationRef", "The merchandise line lacks a unique provider line identity. Obtain a calculation with line evidence.", "tax_operation_unsupported");
        }
        lines.push({ ...amounts, originalPositionRef: [...ids][0], reference: "ol-m-" + source.sourceOrdinal, quantity: source.quantity });
      } else if (plan.zeroShipping || effectiveMinor > 0) {
        const alias = "shipping:" + calculationRef.ref;
        shipping = { ...amounts, originalPositionRef: alias, reference: alias };
      }
    }
    if (new Set(lines.map(unit => unit.originalPositionRef)).size !== lines.length) {
      incomplete("/calculationRef", "The calculation reused a reporting line identity.");
    }
    const body = { calculation: calculationRef.ref, reference, posted_at: postedSeconds };
    const wire = { ...body, metadata: { openlup_request_digest: taxDigest("commit", [reservation.requestDigest, body]) } };
    const receipt = await execute(options, wire, { currency, taxDate, postedAt, lines, shipping }, idempotencyKey, reservation.send, intent,
      key => options.client.transactions.createFromCalculation(wire, { idempotencyKey: key }), now => {
        if (accepted.closed) invalid("/calculationRef", "The calculation was closed locally. Reconcile it with the original capture.", "tax_calculation_closed");
        if (now >= evidence.expiresAt || capturedAt >= evidence.expiresAt || postedAt >= evidence.expiresAt) {
          invalid("/calculationRef", "The calculation expired before capture or posting. Reconcile the original obligation.", "tax_calculation_expired");
        }
        if (capturedAt < evidence.calculatedAt || postedAt > now) {
          invalid("/postedAt", "Use a capture after calculation and a posting time between capture and the current time.");
        }
      });
    return "kind" in receipt ? receipt : { kind: "committed" as const, providerTransactionRef: receipt.id, positions: receipt.positions };
  } catch (error) { return refuseError(error); }
}

function reversalUnits(request: TaxReverseRequestV1, original: RefundReservation["original"]) {
  const refuse = (field: string) => invalid(field,
    "The reserved refund requires unsupported or unproven amounts. Reserve exact eligible original line and shipping deltas.", "tax_reversal_unsubstantiated");
  const byId = new Map(original.units.map(unit => [unit.originalPositionRef, unit]));
  if (original.id !== request.originalRef || original.currency !== request.currency || original.refundedMinor !== request.fromMinor
    || original.payableMinor < request.toMinor || byId.size !== original.units.length
    || original.units.some(unit => ![unit.remainingNetMinor, unit.remainingTaxMinor].every(amount => Number.isSafeInteger(amount) && amount >= 0)
      || (unit.kind !== "line" && unit.kind !== "shipping"))
    || new Set(original.units.map(unit => unit.postedPositionRef)).size !== original.units.length
    || original.units.filter(unit => unit.kind === "shipping").length > 1
    || original.units.reduce((sum, unit) => sum + BigInt(unit.remainingNetMinor) + BigInt(unit.remainingTaxMinor), 0n)
      !== BigInt(original.payableMinor - original.refundedMinor)) refuse("/originalRef");

  if (request.mode === "full" && request.toMinor !== original.payableMinor) refuse("/toMinor");
  const lines: ExpectedUnit[] = [];
  let shipping: ExpectedUnit | undefined;
  for (const [index, item] of request.positions.entries()) {
    const field = "/positions/" + index;
    const originalUnit = byId.get(item.originalPositionRef) ?? refuse(field + "/originalPositionRef");
    if (item.feeDeltaMinor || -item.netDeltaMinor > originalUnit.remainingNetMinor
      || -item.taxDeltaMinor > originalUnit.remainingTaxMinor
      || (request.mode === "full" && (item.netDeltaMinor !== -originalUnit.remainingNetMinor
        || item.taxDeltaMinor !== -originalUnit.remainingTaxMinor))) refuse(field);
    if (!item.netDeltaMinor && !item.taxDeltaMinor) continue;
    const unit = { originalPositionRef: item.originalPositionRef, postedPositionRef: originalUnit.postedPositionRef,
      reference: "ol-r-" + index, amount: item.netDeltaMinor, amount_tax: item.taxDeltaMinor, tax_code: originalUnit.taxCode };
    if (originalUnit.kind === "shipping") shipping = unit;
    else lines.push({ ...unit, postedPositionRef: id(originalUnit.postedPositionRef, field + "/originalPositionRef") });
  }
  const full = request.mode === "full" && request.fromMinor === 0 && lines.length + Number(!!shipping) === original.units.length;
  return { full, lines, shipping };
}

export async function reverse(options: StripeTaxAdapterOptions, input: TaxReverseRequestV1) {
  try {
    const request = taxReverseRequestV1Schema.parse(input);
    if (request.mode === "amount") {
      invalid("/mode", "Flat amounts have no verified allocation. Reserve an exact line or full reversal.", "tax_operation_unsupported");
    }
    const reservation = options.effects.reverse(request.reversalRef);
    if (!reservation) invalid("/reversalRef", "No effect is reserved. Reserve the verified refund before reversing.", "tax_reversal_unsubstantiated");
    const { reference, idempotencyKey } = binding(options, "reverse", request.reversalRef, request, reservation.requestDigest);
    assertScope(request.scope, options.marketPack.scope, "/scope");
    assertClientScope(options);
    const { original, refundEvidenceRef } = reservation;
    assertScope(original.scope, request.scope, "/originalRef/scope");
    if (refundEvidenceRef !== request.refundEvidenceRef) {
      invalid("/refundEvidenceRef", "The verified refund differs from the reservation. Replay the original refund evidence.", "tax_reference_conflict");
    }
    id(original.id, "/originalRef");
    const { lines, shipping, full } = reversalUnits(request, original);
    const body = { reference, original_transaction: original.id, mode: full ? "full" as const : "partial" as const,
      ...(!full && lines.length && { line_items: lines.map(({ amount, amount_tax, reference, postedPositionRef }) =>
        ({ amount, amount_tax, reference, original_line_item: postedPositionRef! })) }),
      ...(!full && shipping && { shipping_cost: { amount: shipping.amount, amount_tax: shipping.amount_tax } }) };
    const wire = { ...body, metadata: { openlup_request_digest: taxDigest("reverse", [reservation.requestDigest, body]) } };
    const expected = { currency: original.currency, taxDate: original.taxDate, original: original.id, lines, shipping, full };
    const receipt = await execute(options, wire, expected, idempotencyKey, reservation.send, request.intent,
      key => options.client.transactions.createReversal(wire, { idempotencyKey: key }));
    return "kind" in receipt ? receipt : { kind: "reversed" as const, providerReversalRef: receipt.id, positions: request.positions };
  } catch (error) { return refuseError(error); }
}
