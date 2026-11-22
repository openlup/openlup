import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2Tax } from "@openlup/core/pricing";
import { invalid } from "../contracts/decode.js";
import { cellKey } from "../contracts/identity.js";
import type { TaxCalculationEvidenceV1, TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal } from "../contracts/index.js";
import { taxDigest, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../digest.js";
import { normalizeSnapshot } from "./breakdown.js";
import type { ComponentEvidence } from "./breakdown.js";
import {
  checkCalculationScope, checkScope, incomplete, lineItem, matchesEcho, member, providerCall, readPages, record, StripeQuoteUnavailable,
} from "./client.js";
import type { CalculationParams, StripeQuoteClient } from "./client.js";
import { planQuote } from "./plan.js";
import type { StripeQuoteMarketPack } from "./plan.js";
import { readRegistrations } from "./registrations.js";

type ProviderTax = Extract<CatalogueMoneyV2Tax, { kind: "provider" }>;
type Position = TaxCalculationEvidenceV1["positions"]["tax"][number];
type RegistrationInventory = Awaited<ReturnType<typeof readRegistrations>>;

async function calculateSnapshot(
  client: StripeQuoteClient, now: () => Date, request: TaxQuoteRequestV1, plan: ReturnType<typeof planQuote>,
  pack: StripeQuoteMarketPack, amounts: readonly number[], sequence: number, registrations: RegistrationInventory,
) {
  const { input, inputDigest, key } = request;
  const metadata = { input_digest: inputDigest, sequence: String(sequence) };
  const line_items: CalculationParams["line_items"] = [];
  const components = plan.components.map((item, index) => {
    const charge = { amount: amounts[index], tax_code: item.code, tax_behavior: "exclusive" } as const;
    if (!item.source) return { item, charge };
    const { sourceOrdinal, quantity } = item.source;
    const line = { ...charge, reference: "ol-m-" + sourceOrdinal, quantity, metadata };
    line_items.push(line);
    return { item, charge, line };
  });
  const delivery = components.find(item => !item.line);
  const shipping = delivery?.charge;
  const sendShipping = shipping && (shipping.amount > 0 || plan.zeroShipping);
  const params: CalculationParams = { ...plan.params, line_items, ...(sendShipping && { shipping_cost: shipping }) };
  const idempotencyKey = "tax-quote-" + taxDigest("input", [input.scope, key, input.taxDate, sequence]);
  const response = await providerCall(() => client.calculations.create(structuredClone(params), { idempotencyKey }));
  const calculatedAt = now().toISOString();
  const calculation = checkCalculationScope(response, params, input.scope);
  if (calculation.expires_at <= calculatedAt) {
    invalid("/calculation/expires_at", "The calculation expired before observation. Obtain a fresh evaluation.", "tax_calculation_expired");
  }

  const url = "/v1/tax/calculations/" + calculation.id + "/line_items";
  const lines = await readPages(url, "/line_items", input.scope,
    page => client.calculations.listLineItems(calculation.id, { ...page, expand: ["data.tax_breakdown"] }), (value, path) => {
      const source = record(value, path);
      checkScope(source, path, input.scope, true);
      const parent = member(source, "calculation", path + "/calculation");
      if (parent !== undefined) matchesEcho(parent, calculation.id, path + "/calculation");
      return { ...lineItem(value, path), path };
    }, calculation.line_items);
  const byReference = new Map(lines.map(line => [line.reference, line]));
  if (lines.length !== line_items.length || byReference.size !== line_items.length) {
    incomplete("/line_items", "The line item set differs from the request.");
  }
  const normalized: ComponentEvidence[] = components.map(({ item, charge, line }) => {
    const match = line && byReference.get(line.reference);
    const actual = line ? match : calculation.shipping_cost;
    const path = line ? match?.path ?? "/line_items" : "/calculation/shipping_cost";
    if (!line && !sendShipping) {
      matchesEcho(actual, null, path);
      return { plan: item, amount: 0, charged: null, path };
    }
    if (!actual) incomplete(path, "The requested component is missing.");
    for (const key of ["amount", "tax_code", "tax_behavior"] as const) matchesEcho(actual[key], charge[key], path + "/" + key);
    if (line && match) {
      matchesEcho(match.quantity, line.quantity, path + "/quantity");
      matchesEcho(match.metadata.input_digest, inputDigest, path + "/metadata/input_digest");
      matchesEcho(match.metadata.sequence, metadata.sequence, path + "/metadata/sequence");
    }
    return { plan: item, amount: charge.amount, charged: actual, path, ...(match && { lineId: match.id }) };
  });
  if (!delivery) matchesEcho(calculation.shipping_cost, null, "/calculation/shipping_cost");
  return { calculation, calculatedAt, normalized, ...normalizeSnapshot(calculation, normalized, input, pack, registrations) };
}

export async function quoteStripeTax(
  options: { client: StripeQuoteClient; marketPack: StripeQuoteMarketPack; now: () => Date },
  request: TaxQuoteRequestV1,
): Promise<TaxQuoteResultV1> {
  try {
    const refusal = verifyTaxQuoteRequest(request);
    if (refusal) return refusal;
    const original = structuredClone(request);
    const { input, inputDigest, key } = original;
    const { client, now } = options;
    for (const field of ["accountRef", "mode"] as const) {
      if (client.scope?.[field] !== input.scope[field]) {
        invalid("/input/scope/" + field,
          "The provider client scope differs from the quote. Use a client bound to the requested account and mode.", "tax_scope_mismatch");
      }
    }
    const pack = structuredClone(options.marketPack);
    const plan = planQuote(input, pack);
    const shipping = plan.components.find(component => !component.source);
    const omitShipping = !plan.zeroShipping && shipping?.effectiveMinor === 0;
    if (omitShipping && shipping.preDiscountMinor > 0) {
      invalid("/input/money/adjustments",
        "A discount makes shipping free in only some snapshots. Qualify zero-amount shipping in the market pack or keep shipping positive in every snapshot.",
        "tax_operation_unsupported");
    }
    const registrations = await readRegistrations(client, input, pack);
    if (omitShipping && shipping.cells.some(cell => registrations.get(cellKey(cell))?.state !== "inactive")) {
      invalid("/input/money/delivery/0",
        "Zero shipping lacks a qualified provider shape or independent inactivity evidence. Supply either before quoting.", "tax_operation_unsupported");
    }
    const states: ProviderTax["components"][number]["states"][number][][] = plan.components.map(() => []);
    const amounts = plan.components.map(item => item.preDiscountMinor);
    const tax = new Map<string, Position>();
    const calculationIds = new Set<string>();
    const feeAmounts = new Map<string, number>();
    let final: Awaited<ReturnType<typeof calculateSnapshot>> | undefined;
    for (const sequence of plan.sequences) {
      const allocations = plan.components.map(item => item.allocations.find(row => row.sequence === sequence));
      allocations.forEach((row, index) => { if (row) amounts[index] = row.afterMinor; });
      const snapshot = await calculateSnapshot(client, now, original, plan, pack, amounts, sequence, registrations);
      const { coverage, calculation, fee } = snapshot;
      if (fee) {
        const identity = cellKey(fee.cell);
        const previous = feeAmounts.get(identity);
        if (previous !== undefined && previous !== fee.amount) {
          incomplete(fee.amountPath, "The flat fee assessment changed between discount snapshots.");
        }
        feeAmounts.set(identity, fee.amount);
      }
      const { vector, digest } = coverage;
      if (coverage.kind !== "resolved") {
        const { vector: _vector, digest: _digest, ...failure } = coverage;
        return { ...failure, coverage: { vector, digest } };
      }
      if (calculationIds.has(calculation.id)) incomplete("/calculation/id", "The provider reused a calculation across different snapshots.");
      calculationIds.add(calculation.id);
      if (final && final.coverage.digest !== digest) {
        invalid("/input/money/adjustments",
          "Coverage treatment changed between discount states. Use discounts that preserve the same coverage treatment.", "tax_operation_unsupported");
      }
      snapshot.positions.forEach((taxPositions, index) => {
        const component = states[index];
        const amountMinor = amounts[index];
        if (sequence === 0 || allocations[index]) {
          component.push({ afterSequence: sequence, amountMinor, taxPositions });
        } else if (!isDeepStrictEqual(component.at(-1)?.taxPositions, taxPositions)) {
          invalid("/input/money/adjustments",
            "An unallocated component changed between discount states. Use discounts that keep tax stable on unallocated components.",
            "tax_operation_unsupported");
        }
      });
      for (const [ref, row] of snapshot.metadata) tax.set(ref, row);
      final = snapshot;
    }

    if (!final) throw new Error("The calculation plan lacks an initial snapshot.");
    const { calculation, calculatedAt, coverage, fee } = final;
    const money = calculateCatalogueMoneyV2({ ...input.money,
      fees: fee ? [{ feeKey: fee.metadata.feeKey, amountMinor: fee.amount }] : [] },
    { kind: "provider", payableMinor: calculation.amount_total,
      components: plan.components.map(({ ref }, index) => ({ ref, states: states[index] })) });
    const fiscalTax = [...tax.values()].sort((a, b) => a.positionRef < b.positionRef ? -1 : 1);
    const providerLines = final.normalized.flatMap(({ plan, lineId }) =>
      plan.source && lineId ? [{ lineKey: plan.source.lineKey, providerLineRef: lineId }] : []);
    const lineIds = new Map(providerLines.map(row => [row.lineKey, row.providerLineRef]));
    const positions = { tax: fiscalTax.map(row => {
      const target = row.cell.target;
      const providerLineRef = target.kind === "line" ? lineIds.get(target.key) : undefined;
      return { ...row, ...(providerLineRef && { providerLineRef }) };
    }), fees: fee ? [fee.metadata] : [] };
    const binding = { scope: input.scope, destinationDigest: input.destination.digest, shipFromRef: input.shipFromRef,
      policyRevision: input.policyRevision, classMapRevision: input.classMapRevision };
    const fiscalDigest = taxDigest("fiscal", { ...binding, coverage: coverage.vector,
      tax: fiscalTax.map(({ resolutionDigest: _digest, ...row }) => row), fees: positions.fees });
    if (calculation.expires_at <= now().toISOString()) {
      invalid("/calculation/expires_at", "The calculation expired during evaluation. Obtain a fresh evaluation.", "tax_calculation_expired");
    }
    const evidence = { ...binding, requestKey: key, inputDigest, calculationRef: calculation.id, calculatedAt,
      expiresAt: calculation.expires_at, taxDate: input.taxDate, coverage: { vector: coverage.vector, digest: coverage.digest },
      providerLines, positions, fiscalDigest };
    const evidenceDigest = taxDigest("evidence", { ...evidence, status: input.purpose });
    const result: TaxQuoteResultV1 = input.purpose === "estimate"
      ? { kind: "estimate", money, evidence: { ...evidence, status: "estimate" }, evidenceDigest }
      : { kind: "final", money, evidence: { ...evidence, status: "final" }, evidenceDigest };
    return verifyTaxQuoteResult(request, result) ?? result;
  } catch (error) {
    if (error instanceof StripeQuoteUnavailable) return { kind: "unavailable", code: "tax_adapter_unavailable", effect: "none" };
    if (error instanceof CatalogueMoneyV2Error) {
      const field = "/" + error.field.replace(/\[(\d+)\]/g, "/$1").replaceAll(".", "/");
      return { kind: "refused", field, remedy: error.remedy,
        code: error.code === "money_amount_out_of_range" ? "tax_amount_out_of_range" : "tax_breakdown_incomplete" };
    }
    if (error instanceof Error && "code" in error && "field" in error) {
      return { kind: "refused", code: error.code as TaxRefusal["code"], field: error.field as string, remedy: error.message };
    }
    throw error;
  }
}
