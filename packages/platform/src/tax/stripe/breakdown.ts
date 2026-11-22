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
  const candidates = cells.filter(cell => bindingsFor(cell, pack).some(binding =>
    binding.taxType === (row.tax_rate_details?.tax_type ?? null) && isDeepStrictEqual(binding.provider, row.jurisdiction)));
  const matches = candidates.filter(cell => cell.sourcing === sourcing);
  if (!matches.length && candidates.length) {
    invalid(path + "/sourcing", "The detail uses different sourcing. Obtain evidence for the required sourcing.", "tax_scope_mismatch");
  }
  if (matches.length === 1) return { row, path, cell: matches[0] };
  if (row.tax_rate_details === null) return;
  return incomplete(path + "/jurisdiction", "The detail does not identify one required jurisdiction and tax kind.");
}

function treatmentFor(reason: string, hasRate: boolean, amount: number, cell: Cell, code: string): Observation["treatment"] {
  const kind = rated.has(reason) && hasRate ? "taxable"
    : exempt.has(reason) ? "exempt" : reason === "not_collecting" ? "not_applicable" : undefined;
  if (!kind || (!hasRate && amount !== 0)) return;
  const ruleRef = taxDigest("resolution", [code, cell, kind, reason]);
  return { kind, reason, ruleRef };
}

function groupKey(country: string | null, state: string | null, type: string | null, rate: string | null | undefined, reason: string) {
  const decimal = rate?.includes(".") ? rate.replace(/0+$/u, "").replace(/\.$/u, "") : rate;
  return JSON.stringify([country, state, type, decimal, reason]);
}

function grouped(rows: readonly { key: string; amount: number }[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const { key, amount } of rows) {
    if (amount !== 0) totals.set(key, (totals.get(key) ?? 0n) + BigInt(amount));
  }
  return totals;
}

function normalizeFee(row: Header | undefined, mirrors: readonly Matched[], input: TaxQuoteInputV1, pack: StripeQuoteMarketPack) {
  const path = "/calculation/tax_breakdown";
  if (!row) {
    if (mirrors.length) incomplete(mirrors[0].path, "The shipping fee mirror is missing its header assessment.");
    return;
  }
  const rate = row.tax_rate_details;
  const candidates = input.required.flatMap(cell => {
    const { target } = cell;
    const jurisdictions = bindingsFor(cell, pack).filter(binding =>
      binding.taxType === feeType && binding.provider.country === rate.country && binding.provider.state === rate.state);
    if (target.kind !== "fee" || jurisdictions.length !== 1) return [];
    return pack.fees.filter(binding => declarationKey(binding) === declarationKey(cell) && binding.feeKey === target.key)
      .map(binding => ({ cell, target, binding }));
  });
  if (rate.rate_type !== "flat_amount" || !rate.flat_amount?.amount || rate.flat_amount.currency !== input.currency.toLowerCase()
    || rate.country === null || candidates.length !== 1) {
    incomplete(path, "The flat fee does not match one qualified fee cell and currency.");
  }
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
  return { cell, metadata, treatment, amount: row.amount };
}

export function normalizeSnapshot(
  calculation: Calculation, components: readonly ComponentEvidence[], input: TaxQuoteInputV1, pack: StripeQuoteMarketPack,
  registrations: ReadonlyMap<string, Observation["registration"]>,
) {
  const observations = new Map<string, Observation>();
  const unavailable = new Set<string>();
  const ordinary: Detail[] = [];
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
      ordinary.push(row);
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
  const fees = header.filter(row => row.tax_rate_details.tax_type === feeType);
  if (fees.length > 1) incomplete("/calculation/tax_breakdown", "The header has multiple fee assessments.");
  const fee = normalizeFee(fees[0], mirrors, input, pack);
  if (fee) observe(fee.cell, fee.amount, fee.treatment, "/calculation/tax_breakdown");

  const path = "/calculation";
  const tax = sum(ordinary.map(row => row.amount)) + BigInt(fee?.amount ?? 0);
  reconcileAmount(path + "/tax_amount_exclusive", calculation.tax_amount_exclusive, sum(header.map(row => row.amount)));
  reconcileAmount(path + "/tax_amount_exclusive", calculation.tax_amount_exclusive, tax);
  const headerGroups = grouped(header.filter(row => row.tax_rate_details.tax_type !== feeType).map(row => {
    const { country, state, tax_type, percentage_decimal, rate_type, flat_amount } = row.tax_rate_details;
    if (row.amount > 0 && (rate_type !== "percentage" || flat_amount !== null || percentage_decimal == null)) {
      incomplete(path + "/tax_breakdown", "An ordinary header assessment is missing its percentage identity.");
    }
    return { key: groupKey(country, state, tax_type, percentage_decimal, row.taxability_reason), amount: row.amount };
  }));
  const detailGroups = grouped(ordinary.map(row => ({ key: groupKey(row.jurisdiction.country, row.jurisdiction.state,
    row.tax_rate_details?.tax_type ?? null, row.tax_rate_details?.percentage_decimal, row.taxability_reason), amount: row.amount })));
  if (!isDeepStrictEqual(headerGroups, detailGroups)) incomplete(path + "/tax_breakdown", "The grouped header and component assessments differ.");
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
  return { coverage, positions, metadata, fee };
}
