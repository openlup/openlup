import { isDeepStrictEqual } from "node:util";
import type { CatalogueMoneyV2Position } from "@openlup/core/pricing";
import { invalid } from "../contracts/decode.js";
import { cellKey, declarationKey, includesInstant, sameCell } from "../contracts/identity.js";
import type { TaxCalculationEvidenceV1, TaxCoverageInputV1, TaxQuoteInputV1 } from "../contracts/index.js";
import { reconcileTaxCoverage } from "../coverage.js";
import { taxDigest } from "../digest.js";
import { incomplete } from "./client.js";
import type { calculation, detail } from "./client.js";
import type { Cell, QuoteComponent, StripeQuoteMarketPack } from "./plan.js";
import { witnessedInstant } from "./registrations.js";

type Detail = ReturnType<typeof detail>;
type Calculation = ReturnType<typeof calculation>;
type Header = Calculation["tax_breakdown"][number];
type Observation = TaxCoverageInputV1["observations"][number];
type Position = TaxCalculationEvidenceV1["positions"]["tax"][number];
type Fee = TaxCalculationEvidenceV1["positions"]["fees"][number];
type Matched = { row: Detail; path: string; cell: Cell };
export type ComponentEvidence = {
  plan: QuoteComponent; amount: number; charged: Calculation["shipping_cost"]; path: string; lineId?: string;
};

const rated = new Set(["standard_rated", "reduced_rated", "zero_rated", "portion_reduced_rated",
  "portion_standard_rated", "proportionally_rated", "taxable_basis_reduced"]);
const exempt = new Set(["product_exempt", "customer_exempt", "product_exempt_holiday", "not_subject_to_tax", "portion_product_exempt"]);
const feeType = "retail_delivery_fee";
const sum = (amounts: readonly number[]) => amounts.reduce((total, amount) => total + BigInt(amount), 0n);

function reconcileAmount(field: string, actual: number, expected: bigint): void {
  if (expected > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(field, "The reconciled sum exceeds the safe minor-unit range. Reduce the basket amounts.", "tax_amount_out_of_range");
  }
  if (BigInt(actual) !== expected) incomplete(field, "The total differs from its reconciled amounts.");
}

function bindingsFor(cell: Cell, pack: StripeQuoteMarketPack) {
  return pack.jurisdictions.filter(binding => declarationKey(binding) === declarationKey(cell)
    && binding.level === cell.level && binding.sourcing === cell.sourcing);
}

function matchDetail(row: Detail, path: string, cells: readonly Cell[], pack: StripeQuoteMarketPack): Matched | undefined {
  if (row.tax_rate_details === null && row.amount !== 0) {
    incomplete(path + "/tax_rate_details", "A nonzero assessment lacks its rate identity.");
  }
  const sourcing = row.sourcing === "origin" ? "ship_from" : "destination";
  const candidates = cells.flatMap(cell => bindingsFor(cell, pack).filter(binding =>
    binding.taxType === (row.tax_rate_details?.tax_type ?? null) && isDeepStrictEqual(binding.provider, row.jurisdiction)).map(() => cell));
  const matches = candidates.filter(cell => cell.sourcing === sourcing);
  if (!matches.length && candidates.length) {
    invalid(path + "/sourcing", "The detail uses different sourcing. Obtain evidence for the required sourcing.", "tax_scope_mismatch");
  }
  if (matches.length === 1) return { row, path, cell: matches[0] };
  if (row.tax_rate_details === null) return;
  return invalid(path + "/jurisdiction",
    "The detail has no unique required jurisdiction and tax-kind binding. Qualify its jurisdiction and tax type in the market pack and supply its required cell.", "tax_rule_missing");
}

function treatmentFor(reason: string, hasRate: boolean, amount: number, cell: Cell, code: string): Observation["treatment"] {
  const kind = rated.has(reason) && hasRate ? "taxable"
    : exempt.has(reason) ? "exempt" : reason === "not_collecting" ? "not_applicable" : undefined;
  if (!kind || (!hasRate && amount !== 0)) return;
  const ruleRef = taxDigest("resolution", [code, cell, kind, reason]);
  return { kind, reason, ruleRef };
}

const locationKey = (country: string | null, state: string | null, reason: string) => JSON.stringify([country, state, reason]);
const NOT_IMPOSED = null; // Concrete rate kinds are strings.
type Group = { path: string; kind: string | null; tax: bigint; basis: bigint };
type OrdinaryDetail = Detail & { path: string };
const unsupported = (path: string, cause: string): never =>
  invalid(path, cause + " Use a supported calculation route or qualify that layout on the owner's test account before enabling it.", "tax_operation_unsupported");

function addGroup(groups: Map<string, Group>, key: string, kind: Group["kind"], row: Header | Detail, path: string) {
  const prior = groups.get(key);
  if (prior && prior.kind !== kind) unsupported(path + "/tax_rate_details/tax_type", "The not-imposed header group mixes tax kinds.");
  groups.set(key, { kind, path: prior?.path ?? path,
    tax: (prior?.tax ?? 0n) + BigInt(row.amount), basis: (prior?.basis ?? 0n) + BigInt(row.taxable_amount) });
}

function reconcileGroups(header: readonly Header[], ordinary: readonly OrdinaryDetail[], resolved: boolean) {
  const path = "/calculation/tax_breakdown";
  const layouts = new Map<string, "rated" | "not_imposed" | "unclassified">();
  const details = new Map<string, Group>(), summaries = new Map<string, Group>();
  for (const row of ordinary) {
    const { jurisdiction, tax_rate_details: rate, taxability_reason: reason } = row;
    const location = locationKey(jurisdiction.country, jurisdiction.state, reason);
    const layout = rate ? "rated" : exempt.has(reason) || reason === "not_collecting" ? "not_imposed" : "unclassified";
    if (layouts.has(location) && layouts.get(location) !== layout)
      unsupported(row.path + "/tax_rate_details", "The detail group mixes null and concrete rates at the same location and reason.");
    layouts.set(location, layout);
    if (layout === "unclassified" && resolved) unsupported(row.path + "/tax_rate_details", "The null-rate detail has no qualified treatment.");
    if (layout === "unclassified") continue;
    const kind = rate?.tax_type ?? NOT_IMPOSED;
    addGroup(details, JSON.stringify([location, rate?.percentage_decimal ?? "0", kind]), kind, row, row.path);
  }
  for (const [index, row] of header.entries()) {
    const { country, state, tax_type, percentage_decimal, rate_type, flat_amount } = row.tax_rate_details;
    if (tax_type === feeType) continue;
    const field = path + "/" + index;
    if (country === null) unsupported(field + "/tax_rate_details/country", "The ordinary header group has no country.");
    if (flat_amount !== null || (rate_type !== null && rate_type !== "percentage"))
      unsupported(field + "/tax_rate_details", "The ordinary header group has a flat amount or an unqualified rate type.");
    const location = locationKey(country, state, row.taxability_reason);
    const layout = layouts.get(location);
    if (layout === "unclassified") continue;
    const projected = layout === "not_imposed";
    if (projected && (percentage_decimal !== "0" || row.amount !== 0))
      incomplete(field + "/tax_rate_details", "The header conflicts with the zero-rate, zero-tax treatment in the component evidence.");
    if (rate_type !== "percentage" && !(projected && rate_type === null))
      incomplete(field + "/tax_rate_details/rate_type", "The ordinary header group lacks its percentage identity.");
    addGroup(summaries, JSON.stringify([location, percentage_decimal, projected ? NOT_IMPOSED : tax_type]), tax_type, row, field);
  }
  for (const key of new Set([...summaries.keys(), ...details.keys()])) {
    const summary = summaries.get(key), detail = details.get(key);
    if (!detail) incomplete(summary!.path + "/tax_rate_details", "The header group has no matching component breakdown.");
    if (!summary) {
      if (detail.kind === NOT_IMPOSED && detail.tax === 0n && detail.basis === 0n)
        unsupported(path, "The header omits a complete zero-tax, zero-basis not-imposed group.");
      incomplete(path, "The header omits a component group.");
    }
    if (summary.tax !== detail.tax) incomplete(summary.path + "/amount", "The grouped header and component assessments differ.");
    if (summary.basis !== detail.basis) incomplete(summary.path + "/taxable_amount", "The grouped header and component taxable bases differ.");
  }
}

function normalizeFee(fee: { row: Header; index: number } | undefined, mirrors: readonly Matched[], input: TaxQuoteInputV1, pack: StripeQuoteMarketPack) {
  if (!fee) {
    if (mirrors.length) incomplete(mirrors[0].path, "The shipping fee mirror is missing its header assessment.");
    return;
  }
  const { row, index } = fee;
  const path = "/calculation/tax_breakdown/" + index;
  const rate = row.tax_rate_details;
  if (rate.rate_type !== "flat_amount" || !rate.flat_amount?.amount || rate.flat_amount.currency !== input.currency.toLowerCase()
    || rate.country === null) incomplete(path + "/tax_rate_details", "The fee lacks a flat rate in the quote currency and jurisdiction.");
  const candidates = input.required.flatMap(cell => {
    const { target } = cell;
    const jurisdictions = bindingsFor(cell, pack).filter(binding =>
      binding.taxType === feeType && binding.provider.country === rate.country && binding.provider.state === rate.state);
    if (target.kind !== "fee") return [];
    return jurisdictions.flatMap(() => pack.fees.filter(binding => declarationKey(binding) === declarationKey(cell)
      && binding.feeKey === target.key).map(binding => ({ cell, target, binding })));
  });
  if (candidates.length !== 1) invalid(path + "/tax_rate_details",
    "The flat fee has no unique required cell and binding. Qualify the fee in the market pack and supply its required cell.", "tax_rule_missing");
  const [{ cell, target, binding }] = candidates;
  if (binding.layout === "shipping_mirror") {
    const mirror = mirrors[0];
    if (mirrors.length !== 1 || !sameCell(mirror.cell, cell) || mirror.row.amount !== row.amount
      || mirror.row.taxable_amount !== row.taxable_amount || mirror.row.taxability_reason !== row.taxability_reason) {
      incomplete(path, "The fee assessment lacks its exact qualified shipping mirror.");
    }
  } else if (mirrors.length) incomplete(path, "The top-only fee unexpectedly has a shipping mirror.");
  const metadata: Fee = { feeKey: target.key, jurisdiction: cell.jurisdiction, feeKind: cell.taxKind,
    scope: target.deliveryKey === undefined ? { kind: "order" } : { kind: "delivery", key: target.deliveryKey },
    refundRule: binding.refundRule };
  const treatment = treatmentFor(row.taxability_reason, true, row.amount, cell, target.taxClass);
  return { cell, metadata, treatment, amount: row.amount, amountPath: path + "/amount" };
}

export function normalizeSnapshot(
  calculation: Calculation, components: readonly ComponentEvidence[], input: TaxQuoteInputV1, pack: StripeQuoteMarketPack,
  registrations: ReadonlyMap<string, Observation["registration"]>,
) {
  const observations = new Map<string, Observation>();
  const unavailable = new Set<string>();
  const ordinary: OrdinaryDetail[] = [];
  const mirrors: Matched[] = [];
  const metadata = new Map<string, Position>();
  const feeCells = input.required.filter(cell => cell.target.kind === "fee");
  function observe(cell: Cell, amount: number, treatment: Observation["treatment"], path: string) {
    const key = cellKey(cell);
    const previous = observations.get(key);
    if (!treatment) unavailable.add(key);
    if (previous?.treatment && treatment && !isDeepStrictEqual(previous.treatment, treatment)) {
      incomplete(path, "The cell has conflicting treatments within the same snapshot.");
    }
    const assessedMinor = amount + (previous?.assessedMinor ?? 0);
    if (!Number.isSafeInteger(assessedMinor)) invalid(path, "Reduce the cell assessment to a safe integer.", "tax_amount_out_of_range");
    const present = treatment ?? previous?.treatment;
    observations.set(key, { cell, assessedMinor, ...(present && { treatment: present }) });
  }

  const positions = components.map(({ plan, charged, path }) => {
    const details = charged?.tax_breakdown ?? [];
    reconcileAmount(path + "/amount_tax", charged?.amount_tax ?? 0, sum(details.map(row => row.amount)));
    const taxPositions: CatalogueMoneyV2Position[] = [];
    for (const [index, row] of details.entries()) {
      const field = path + "/tax_breakdown/" + index;
      if (row.tax_rate_details?.tax_type === feeType) {
        if (plan.ref.kind !== "delivery") incomplete(field, "A fee mirror appeared on a merchandise line.");
        const bucketKey = plan.ref.bucketKey;
        const eligible = feeCells.filter(({ target }) => target.kind === "fee"
          && (target.deliveryKey === undefined || target.deliveryKey === bucketKey));
        const mirror = matchDetail(row, field, eligible, pack);
        if (!mirror) incomplete(field, "The fee mirror does not identify a qualified fee cell.");
        mirrors.push(mirror);
        continue;
      }
      ordinary.push({ ...row, path: field });
      const matched = matchDetail(row, field, plan.cells, pack);
      if (!matched) {
        for (const cell of plan.cells) unavailable.add(cellKey(cell));
        continue;
      }
      const { cell } = matched;
      const treatment = treatmentFor(row.taxability_reason, row.tax_rate_details !== null, row.amount, cell, plan.code);
      observe(cell, row.amount, treatment, field);
      if (!treatment) continue;
      const rate = row.tax_rate_details?.percentage_decimal;
      const sourceRef = taxDigest("resolution", [treatment.ruleRef, row.jurisdiction, row.tax_rate_details]);
      const positionRef = taxDigest("resolution", [cellKey(cell), sourceRef]);
      if (metadata.has(positionRef)) incomplete(field, "The calculation repeated an assessment identity.");
      const resolution = { assignmentRef: plan.assignment.assignmentRef, policyRevision: input.policyRevision,
        sourceRef, effective: witnessedInstant(input.taxDate) };
      metadata.set(positionRef, { positionRef, cell, ...(rate !== undefined && { ratePercent: rate }),
        taxabilityReason: treatment.reason, ruleRef: treatment.ruleRef, resolution, resolutionDigest: taxDigest("resolution", resolution) });
      taxPositions.push({ positionRef, jurisdictionRef: cell.jurisdiction, ...(rate !== undefined && { rateDecimal: rate }),
        taxableMinor: row.taxable_amount, taxMinor: row.amount });
    }
    return taxPositions.sort((a, b) => a.positionRef < b.positionRef ? -1 : 1);
  });

  const header = calculation.tax_breakdown;
  if (header.some(row => row.inclusive)) incomplete("/calculation/tax_breakdown", "The header includes an inclusive assessment.");
  const fees = header.flatMap((row, index) => row.tax_rate_details.tax_type === feeType ? [{ row, index }] : []);
  if (fees.length > 1) incomplete("/calculation/tax_breakdown", "The header has multiple fee assessments.");
  const fee = normalizeFee(fees[0], mirrors, input, pack);
  if (fee) observe(fee.cell, fee.amount, fee.treatment, "/calculation/tax_breakdown");

  const path = "/calculation";
  const tax = sum(ordinary.map(row => row.amount)) + BigInt(fee?.amount ?? 0);
  reconcileAmount(path + "/tax_amount_exclusive", calculation.tax_amount_exclusive, sum(header.map(row => row.amount)));
  reconcileAmount(path + "/tax_amount_exclusive", calculation.tax_amount_exclusive, tax);
  reconcileAmount(path + "/amount_total", calculation.amount_total, sum(components.map(item => item.amount)) + tax);

  const acknowledged = new Set(input.coverage.declarations.filter(row => row.status === "not_registered_acknowledged"
    && includesInstant(row.effective, input.taxDate)).map(declarationKey));
  const coverage = reconcileTaxCoverage({ scope: input.scope, taxDate: input.taxDate, coverage: input.coverage, required: input.required,
    observations: input.required.map(cell => {
      const key = cellKey(cell);
      const registration = registrations.get(key);
      const { treatment, ...observation } = observations.get(key) ?? { cell };
      const unknown = unavailable.has(key);
      const wouldInferInactivity = unknown && registration?.state === "inactive"
        && !observation.assessedMinor && acknowledged.has(declarationKey(cell));
      return { ...observation, ...(!unknown && treatment && { treatment }),
        ...(!wouldInferInactivity && registration && { registration }) };
    }),
  });
  reconcileGroups(header, ordinary, coverage.kind === "resolved");
  return { coverage, positions, metadata, fee };
}
