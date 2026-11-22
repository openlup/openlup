import { isDeepStrictEqual } from "node:util";
import type { TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal } from "./contracts/index.js";
import { makeTaxQuoteRequest, verifyTaxQuoteResult } from "./digest.js";

type Final = Extract<TaxQuoteResultV1, { kind: "final" }>;
type Field = "positions" | "fees" | "payableMinor" | "currency";

function sorted<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function comparable(request: TaxQuoteRequestV1, result: Final) {
  return {
    positions: result.money.components.map(({ ref, initial, allocations, final }) => ({
      ref,
      states: [initial, ...allocations.map(row => row.after), final].map(state =>
        sorted(state.taxPositions, row => row.positionRef).map(({ rateDecimal, ...row }) => ({
          ...row, ...(rateDecimal === undefined ? {} : { rateDecimal: rateDecimal.replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "") }),
        }))),
    })),
    fees: sorted(result.evidence.positions.fees, row => row.feeKey).map(({ providerPositionRef: _ref, ...row }) => ({
      ...row, amountMinor: result.money.fees.find(fee => fee.feeKey === row.feeKey)?.amountMinor,
    })),
    payableMinor: result.money.payableMinor,
    currency: request.input.currency,
  };
}

/**
 * Compare a bound final quote with a fresh quote for the same logical key and frozen input
 * at a later tax instant. Both request/result pairs must pass the quote verifier.
 * The caller owns the renewal dispatch fence, append-only rebind and operator case.
 * Invoke the probe only after a definitive non-capturing outcome with no pending attempt.
 * @beta
 * @experimental
 */
export function compareTaxRecalculationProbe(
  boundRequest: TaxQuoteRequestV1, bound: TaxQuoteResultV1,
  probeRequest: TaxQuoteRequestV1, probe: TaxQuoteResultV1,
): { kind: "equal" } | { kind: "different"; field: Field } | TaxRefusal {
  const refusal = verifyTaxQuoteResult(boundRequest, bound) ?? verifyTaxQuoteResult(probeRequest, probe);
  if (refusal) return refusal;
  if (bound.kind !== "final" || probe.kind !== "final") {
    return { kind: "refused", code: "tax_calculation_unusable", field: "/kind", remedy: "Supply two verified final quotes." };
  }
  const rebasedInput = { ...boundRequest.input, taxDate: probeRequest.input.taxDate };
  if (probeRequest.key !== boundRequest.key || probeRequest.inputDigest !== makeTaxQuoteRequest(boundRequest.key, rebasedInput).inputDigest) {
    return { kind: "refused", code: "tax_reference_conflict", field: "/input",
      remedy: "Replay the original request and digest for the bound quote. Build the probe under the same key with only the tax instant changed." };
  }
  if (probeRequest.input.taxDate <= boundRequest.input.taxDate) {
    return { kind: "refused", code: "tax_calculation_unusable", field: "/input/taxDate",
      remedy: "Quote at a retry instant later than the bound tax instant." };
  }
  const original = comparable(boundRequest, bound);
  const current = comparable(probeRequest, probe);
  for (const field of ["positions", "fees", "payableMinor", "currency"] as const) {
    if (!isDeepStrictEqual(original[field], current[field])) return { kind: "different", field };
  }
  return { kind: "equal" };
}
