import { isDeepStrictEqual } from "node:util";
import { calculateCatalogueMoneyV2, CatalogueMoneyV2Error } from "@openlup/core/pricing";
import type { CatalogueMoneyV2Tax } from "@openlup/core/pricing";
import { TAX_CALCULATION_CONTRACT_VERSION } from "./contracts/index.js";
import type {
  TaxCalculationEvidenceV1, TaxCalculationPort, TaxCoverageInputV1, TaxFiscalValidityResultV1, TaxQuoteInputV1,
  TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal, TaxScopeV1,
} from "./contracts/index.js";
import { array, checked, invalid, object, oneOf, schema, variant } from "./contracts/decode.js";
import { cellKey, compareCells, declarationKey, includesInstant } from "./contracts/identity.js";
import {
  instant, interval, moneyRef, rate, ref, scope, taxCloseInputV1Schema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema, unsigned,
} from "./contracts/schemas.js";
import { reconcileTaxCoverage } from "./coverage.js";
import { taxDigest, taxFiscalDigest, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "./digest.js";

type Evidence = TaxCalculationEvidenceV1;
type Cell = TaxQuoteInputV1["required"][number];
type Observation = TaxCoverageInputV1["observations"][number];
type LocalTax = Extract<CatalogueMoneyV2Tax, { kind: "local" }>;
type Rate = LocalTax["components"][number]["rates"][number];

type Effective = NonNullable<Observation["registration"]>["effective"];
type Registration = NonNullable<Observation["registration"]> & Readonly<{ jurisdiction: string; taxKind: string }>;
type Rule = Readonly<{
  jurisdiction: string; taxKind: string; taxClass: string; effective: Effective; ruleRef: string; legalBasisRef: string;
}> & (
  Readonly<{ kind: "rate"; ratePercent: string }>
  | Readonly<{ kind: "exempt"; reason: string }>
  | Readonly<{ kind: "fee"; amountMinor: number; refundRule: Readonly<{ ref: string; revision: string }> }>
);

const coordinates = { jurisdiction: ref, taxKind: ref };
const registrationRow = object({
  ...coordinates, state: oneOf("active", "inactive"), effective: interval, evidenceRef: ref,
});
const ruleFields = { ...coordinates, taxClass: ref, effective: interval, ruleRef: ref, legalBasisRef: ref };
const rule = variant<Rule>("kind", {
  rate: object({ ...ruleFields, jurisdiction: moneyRef, kind: oneOf("rate"), ratePercent: rate }),
  exempt: object({ ...ruleFields, kind: oneOf("exempt"), reason: ref }),
  fee: object({ ...ruleFields, kind: oneOf("fee"), amountMinor: unsigned, refundRule: object({ ref, revision: ref }) }),
});
const duration = checked((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  "Supply a positive safe integer duration in milliseconds.");
const tableOptions = schema(object({
  now: checked((value): value is () => string => typeof value === "function", "Supply a clock returning a UTC instant."),
  scope, market: ref, currency: ref, calculationLifetimeMs: duration, validityWindowMs: duration,
  rounding: oneOf("half_up_largest_remainder"), registrations: array(registrationRow), rules: array(rule),
}));
/** Application-owned rules, registration evidence and clocks for one exclusive tax binding. */
export interface LocalRateTableOptionsV1 {
  readonly scope: TaxScopeV1;
  readonly market: string;
  readonly currency: string;
  readonly rounding: "half_up_largest_remainder";
  readonly now: () => string;
  readonly calculationLifetimeMs: number;
  readonly validityWindowMs: number;
  readonly registrations: readonly Registration[];
  readonly rules: readonly Rule[];
}

const ruleKey = ({ jurisdiction, taxKind, taxClass }: Pick<Rule, "jurisdiction" | "taxKind" | "taxClass">) =>
  JSON.stringify([jurisdiction, taxKind, taxClass]);

function indexIntervals<T extends { effective: Effective }>(
  rows: readonly T[], key: (row: T) => string, field: string,
): Map<string, T[]> {
  const ordered = rows.map((row, index) => ({ row, index, id: key(row) })).sort((a, b) =>
    a.id === b.id ? compare(a.row.effective.from, b.row.effective.from) : compare(a.id, b.id));
  const groups = new Map<string, T[]>();
  for (const { row, index, id } of ordered) {
    const group = groups.get(id) ?? [];
    const previous = group.at(-1);
    if (previous && (previous.effective.until === undefined || row.effective.from < previous.effective.until)) {
      invalid(field + "/" + index + "/effective", "Use nonoverlapping effective intervals for this table key.");
    }
    group.push(row);
    groups.set(id, group);
  }
  return groups;
}

function compare(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function refuse(code: TaxRefusal["code"], field: string, remedy: string): TaxRefusal {
  return { kind: "refused", code, field, remedy };
}

const unsupported = () => refuse("tax_operation_unsupported", "",
  "Use a tax adapter with posting and reversal support for this operation.");
const unavailable = (): TaxFiscalValidityResultV1 => ({ kind: "unavailable", code: "tax_fiscal_validity_unavailable", effect: "none" });

function deadline(observedAt: string, durationMs: number): string {
  const end = Date.parse(observedAt) + durationMs;
  if (end >= Date.UTC(10000, 0, 1)) invalid("/now", "Supply a clock and duration whose deadline is within the supported date range.");
  return new Date(end).toISOString();
}

function quoteFailure(error: unknown): TaxRefusal {
  if (error instanceof CatalogueMoneyV2Error) {
    return refuse(error.code === "money_amount_out_of_range" ? "tax_amount_out_of_range" : "tax_invalid_input",
      "/money/" + error.field.replace(/\[(\d+)\]/g, ".$1").replaceAll(".", "/"), error.remedy);
  }
  if (error instanceof Error && "field" in error && typeof error.field === "string") {
    return refuse("tax_invalid_input", error.field, error.message);
  }
  throw error;
}

// This binding excludes the charge instant and declarations outside the effective coverage vector.
function economicBinding({ taxDate: _date, coverage: _coverage, required, ...input }: TaxQuoteInputV1) {
  return { ...input, required: [...required].sort(compareCells) };
}

function calculationRef(tableDigest: string, factsDigest: string, snapshot: Omit<Evidence, "calculationRef">) {
  const { requestKey, inputDigest, fiscalDigest, calculatedAt, expiresAt } = snapshot;
  return ["local-rate-table", tableDigest, factsDigest,
    taxDigest("evidence", { tableDigest, factsDigest, requestKey, inputDigest, fiscalDigest, calculatedAt, expiresAt })].join(".");
}

/** Calculate exclusive tax from an immutable local table with no posting effects. */
export function localRateTable(options: LocalRateTableOptionsV1): TaxCalculationPort {
  const table = tableOptions.parse(options);
  const rules = indexIntervals(table.rules, ruleKey, "/rules");
  const registrations = indexIntervals(table.registrations, declarationKey, "/registrations");
  const tableDigest = taxDigest("rate-table", {
    rounding: table.rounding, rules: [...rules.values()].flat(), registrations: [...registrations.values()].flat(),
  });

  function scopeMismatch(input: Pick<TaxQuoteInputV1, "scope" | "market" | "currency">): TaxRefusal | undefined {
    const field = !isDeepStrictEqual(input.scope, table.scope) ? "/scope"
      : input.market !== table.market ? "/market" : input.currency !== table.currency ? "/currency" : undefined;
    if (field) return refuse("tax_scope_mismatch", field, "Select the tax binding for the request's scope, market and currency.");
  }

  function assess(input: TaxQuoteInputV1) {
    const { taxDate } = input;
    const classes = new Map<string, Pick<Rule, "taxClass"> & { assignmentRef: string }>([
      ...input.lines.map(row => [JSON.stringify(["line", row.lineKey]), row] as const),
      ...input.delivery.map(row => [JSON.stringify(["delivery", row.bucketKey]), row] as const),
    ]);
    const selected = new Map<string, { rule: Rule; assignmentRef: string }>();
    const observations: Observation[] = [];
    for (const [index, cell] of input.required.entries()) {
      const { target } = cell;
      const { taxClass, assignmentRef } = target.kind === "fee" ? target : classes.get(targetKey(cell))!;
      const rule = rules.get(ruleKey({ ...cell, taxClass }))?.find(row => includesInstant(row.effective, taxDate));
      const field = "/input/required/" + index;
      if (!rule || (target.kind === "fee" ? rule.kind === "rate" : rule.kind === "fee")) {
        return { ...refuse("tax_rule_missing", field, "Supply an effective rule or explicit exemption for this class and cell."),
          jurisdiction: cell.jurisdiction, taxKind: cell.taxKind };
      }
      selected.set(cellKey(cell), { rule, assignmentRef });
      const registrationRow = registrations.get(declarationKey(cell))?.find(row => includesInstant(row.effective, taxDate));
      if (!registrationRow) {
        observations.push({ cell });
        continue;
      }
      const { state, effective, evidenceRef } = registrationRow;
      const treatment = rule.kind === "exempt" ? { kind: "exempt", reason: rule.reason } as const
        : state === "inactive" ? { kind: "not_applicable", reason: "registration-inactive" } as const
          : { kind: "taxable", reason: "local-rule-applies" } as const;
      // Decide coverage before assessing money. Only resolved taxable cells contribute charges.
      observations.push({ cell, registration: { state, effective, evidenceRef },
        treatment: { ...treatment, ruleRef: rule.ruleRef }, assessedMinor: 0 });
    }

    const { vector, digest, ...reconciled } = reconcileTaxCoverage({ ...inputForCoverage(input), observations });
    const coverage = { vector, digest };
    if (reconciled.kind !== "resolved") return { ...reconciled, coverage };
    const tax: Evidence["positions"]["tax"][number][] = [];
    const feePositions: Evidence["positions"]["fees"][number][] = [];
    const fees: TaxQuoteInputV1["money"]["fees"][number][] = [];
    const feeKeys = new Set<string>();
    const rates = new Map<string, Rate[]>();
    const facts = vector.map(row => selected.get(cellKey(row.cell))!.rule);
    for (const { cell, decision, treatment } of vector) {
      if (decision !== "in_scope_taxed") continue;
      const { rule, assignmentRef } = selected.get(cellKey(cell))!;
      const { target } = cell;
      if (target.kind === "fee" && rule.kind === "fee") {
        if (feeKeys.has(target.key)) {
          return refuse("tax_invalid_input", "/input/required", "Supply distinct keys for assessed fee cells.");
        }
        feeKeys.add(target.key);
        fees.push({ feeKey: target.key, amountMinor: rule.amountMinor });
        feePositions.push({ feeKey: target.key, jurisdiction: cell.jurisdiction, feeKind: cell.taxKind, refundRule: { ...rule.refundRule },
          scope: target.deliveryKey === undefined ? { kind: "order" } : { kind: "delivery", key: target.deliveryKey } });
      } else if (rule.kind === "rate") {
        const positionRef = "tax-" + taxDigest("resolution", cellKey(cell));
        const resolution = { assignmentRef, policyRevision: input.policyRevision, sourceRef: rule.legalBasisRef,
          sourceDigest: tableDigest, effective: { ...rule.effective } };
        tax.push({ positionRef, cell, ratePercent: rule.ratePercent, taxabilityReason: treatment!.reason,
          ruleRef: rule.ruleRef, resolution, resolutionDigest: taxDigest("resolution", resolution) });
        const key = targetKey(cell);
        const entries = rates.get(key) ?? [];
        entries.push({ positionRef, jurisdictionRef: cell.jurisdiction, rateDecimal: rule.ratePercent });
        rates.set(key, entries);
      }
    }

    const components: LocalTax["components"] = [
      ...input.money.sources.map(({ lineKey, sourceOrdinal }) => ({ ref: { kind: "merchandise" as const, lineKey, sourceOrdinal },
        rates: rates.get(JSON.stringify(["line", lineKey])) ?? [] })),
      ...input.money.delivery.map(({ bucketKey }) => ({ ref: { kind: "delivery" as const, bucketKey },
        rates: rates.get(JSON.stringify(["delivery", bucketKey])) ?? [] })),
    ];
    const money = calculateCatalogueMoneyV2({ ...input.money, fees }, { kind: "local", components });
    const positions = { tax, fees: feePositions };
    const fiscal = { scope: input.scope, destinationDigest: input.destination.digest, shipFromRef: input.shipFromRef,
      policyRevision: input.policyRevision, classMapRevision: input.classMapRevision, coverage, positions };
    const factsDigest = taxDigest("fiscal", {
      inputDigest: taxDigest("input", economicBinding(input)), coverageDigest: digest,
      rulesDigest: taxDigest("rate-table", { rules: [...new Set(facts)], rounding: table.rounding }),
    });
    return { kind: "assessed" as const, money, fiscal, factsDigest, intervals: [
      ...facts.map(row => row.effective),
      ...vector.flatMap(row => [row.declaration?.effective, row.registration?.effective]),
    ].filter(row => row !== undefined) };
  }

  function quote(request: TaxQuoteRequestV1): TaxQuoteResultV1 {
    if (typeof request !== "object" || request === null) {
      return refuse("tax_invalid_input", "", "Supply an ordinary quote request document.");
    }
    const invalidRequest = verifyTaxQuoteRequest(request);
    if (invalidRequest) {
      return /^\/input\/(?:lines|delivery|required)\/\d+\/(?:target\/)?taxClass$/.test(invalidRequest.field)
        ? refuse("tax_class_missing", invalidRequest.field, "Assign a valid tax class to the named component.") : invalidRequest;
    }
    const { input, key, inputDigest } = taxQuoteRequestV1Schema.parse(request);
    const mismatch = scopeMismatch(input);
    if (mismatch) return mismatch;
    const assessment = assess(input);
    if (assessment.kind !== "assessed") return assessment;
    const { money, fiscal, factsDigest } = assessment;
    const calculatedAt = instant(table.now(), "/now");
    const snapshot = { ...fiscal, requestKey: key, inputDigest, taxDate: input.taxDate, calculatedAt,
      expiresAt: deadline(calculatedAt, table.calculationLifetimeMs), fiscalDigest: taxFiscalDigest(fiscal) };
    function success<K extends Evidence["status"]>(kind: K) {
      const bound = { ...snapshot, status: kind };
      const evidence = { ...bound, calculationRef: calculationRef(tableDigest, factsDigest, bound) };
      return { kind, money, evidence, evidenceDigest: taxDigest("evidence", evidence) };
    }
    const result = input.purpose === "final" ? success("final") : success("estimate");
    return verifyTaxQuoteResult(request, result) ?? result;
  }

  return {
    contractVersion: TAX_CALCULATION_CONTRACT_VERSION,
    capabilities: () => ({ scope: { ...table.scope }, markets: [table.market], currencies: [table.currency], bases: ["exclusive"],
      sourcing: ["destination", "ship_from"], evidence: { lines: true, delivery: true, fees: true },
      registrations: "effective_intervals", validity: "read_only", calculationLifetimeMs: table.calculationLifetimeMs,
      posting: "unsupported", reversals: [], recovery: [] }),
    async quote(request) {
      try { return quote(request); }
      catch (error) { return quoteFailure(error); }
    },
    async readFiscalValidity(request) {
      try {
        if (verifyTaxQuoteRequest(request)) return unavailable();
        const { original, evidence, evidenceDigest, chargeAt, current } = taxFiscalValidityRequestV1Schema.parse(request);
        if (scopeMismatch(original.input) || scopeMismatch(current)) return unavailable();
        const [, originalTable, originalFacts] = evidence.calculationRef.split(".");
        if (!/^[a-f0-9]{64}$/.test(originalTable ?? "") || !/^[a-f0-9]{64}$/.test(originalFacts ?? "")
          || evidence.calculationRef !== calculationRef(originalTable, originalFacts, evidence)) return unavailable();
        const assessment = assess(current);
        if (assessment.kind !== "assessed") return unavailable();
        const observedAt = instant(table.now(), "/now");
        const windowEnd = deadline(observedAt, table.validityWindowMs);
        let until: string | undefined;
        let from = "0000-01-01T00:00:00.000Z";
        for (const effective of assessment.intervals) {
          if (effective.from > from) from = effective.from;
          if (effective.until !== undefined && (until === undefined || effective.until < until)) until = effective.until;
        }
        const dispatchBefore = until !== undefined && until < windowEnd ? until : windowEnd;
        if (dispatchBefore <= observedAt || dispatchBefore <= chargeAt) return unavailable();
        const unchanged = originalFacts === assessment.factsDigest;
        return { kind: unchanged ? "unchanged" : "changed", proof: {
          calculationRef: evidence.calculationRef, evidenceDigest, observedAt, effective: { from, ...(until !== undefined && { until }) },
          fiscalDigest: unchanged ? evidence.fiscalDigest : taxFiscalDigest(assessment.fiscal), dispatchBefore,
        } };
      } catch {
        return unavailable();
      }
    },
    async closeCalculation(ref, reason, key) {
      const close = taxCloseInputV1Schema.safeParse({ ref, reason, key });
      if (!close.success) return refuse(close.error.code, close.error.field, close.error.message);
      if (!isDeepStrictEqual(close.data.ref.scope, table.scope)) {
        return refuse("tax_scope_mismatch", "/ref/scope", "Close the calculation under its original tax binding.");
      }
      return { kind: "closed", ref: close.data.ref, key: close.data.key };
    },
    async commit() { return unsupported(); },
    async reverse() { return unsupported(); },
  };
}

function targetKey({ target }: Cell): string {
  return JSON.stringify([target.kind, target.key]);
}

function inputForCoverage({ scope, taxDate, coverage, required }: TaxQuoteInputV1) {
  return { scope, taxDate, coverage, required };
}
