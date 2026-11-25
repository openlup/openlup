import type { TaxCalculationPortV1 } from "../../tax/index.js";
import type { DestinationPortV2 } from "./destinations/index.js";

type AdapterFailure = Extract<Awaited<ReturnType<TaxCalculationPortV1["quote"]>>, { kind: "refused" | "unavailable" }>;
type DestinationFailure = Extract<Awaited<ReturnType<DestinationPortV2["read"]>>, { outcome: "refused" }>;

export const refused = (code: string, field: string, remedy: string) => ({ kind: "refused" as const, code, field, remedy });
export const pending = () => refused("tax_claim_pending", "/claim", "Read the original evaluation outcome.");
export const expired = () => refused("tax_calculation_expired", "/taxEvidence/expiresAt", "Select the destination again and obtain a fresh quote.");
export const integrity = () => refused("tax_evaluation_integrity_invalid", "/taxEvidence", "Recover the original evaluation from its authoritative owner.");

export function infrastructure(field: string, cause: unknown) {
  return Object.assign(new Error("commerce_quote_v2_unavailable", { cause }), {
    code: "commerce_quote_v2_unavailable", field,
    remedy: "Check the native app binding, driver setup, database connection and TLS, operation-role privileges, and installed migrations. Then retry the same operation.",
  });
}

export function destinationRefusal(value: DestinationFailure) {
  const { code, field, fix } = value;
  if (code === "destination_evidence_unavailable" && field === "destination.snapshotRef")
    return refused("commerce_destination_owner_mismatch", "/destination/snapshotRef", "Re-obtain evidence through the authenticated owner.");
  if (code === "destination_digest_mismatch")
    return refused(code, "/destination/destinationDigest", "Replay the original document and its digest.");
  if (code === "destination_version_changed")
    return refused(code, field === "destination.policyRevision" ? "/destination/policyRevision" : "/destination/snapshotRef", expired().remedy);
  return refused(code, code === "destination_binding_invalid" && field === "destination" ? "/destination" : field, fix);
}

type Rule = readonly [field: string, remedy: string, source: RegExp];
const undeclared = "Have the coverage owner supply the required effective declarations under /coverage/declarations, then obtain a fresh quote.";
export const missingCoverage = () => refused("tax_coverage_undeclared", "/coverage/declarations", undeclared);
const classRemedy = (field: string) => "Have the coverage owner supply the required tax class mapping for " + field + ", then obtain a fresh quote.";
const routeRemedy = "Use a qualified calculation route for this tax breakdown.";
const rules: Partial<Record<AdapterFailure["code"], readonly Rule[]>> = {
  tax_invalid_input: [
    ["/coverage/declarations", "Have the coverage owner correct the declarations under /coverage/declarations, then obtain a fresh quote.", /^(?:\/input)?\/coverage\/declarations(?:\/|$)/u],
    ["/required", "Have the coverage owner supply valid required coverage within the evidence limit under /required, then obtain a fresh quote.", /^(?:\/input)?\/required(?:\/|$)/u],
    ["/now", "Have the quote host supply a supported tax clock and obtain a fresh quote.", /^\/now$/u],
    ["/input", "Correct the documented quote input and obtain a fresh quote.", /^(?:|\/key|\/inputDigest|\/input(?:\/.*)?)$/u],
  ],
  tax_scope_mismatch: [
    ["/input/scope", "Use the authorized tax binding for the original scope, market and currency.", /^(?:\/input)?\/(?:scope(?:\/(?:adapter|adapterVersion|accountRef|mode))?|market|currency)$/u],
    ["/input/money/amountBasis", "Use the inclusive quote path for an inclusive price list or obtain an exclusive quote on the published exclusive basis.", /^(?:\/input)?\/money\/amountBasis$/u],
    ["/coverage/accountRef", "Recover the original coverage history for the authorized tax account.", /^(?:\/input)?\/coverage\/accountRef$/u],
    ["/taxEvidence", "Have the tax adapter owner reconcile the calculation account, mode and sourcing with the authorized tax binding, then obtain a fresh quote.", /^\/(?:calculation|line_items|registrations)(?:\/[^/]+)*\/(?:account|livemode|sourcing)$/u],
  ],
  tax_class_missing: [
    ["/input/lines", classRemedy("/input/lines"), /^\/input\/lines\/\d+\/taxClass$/u],
    ["/input/delivery", classRemedy("/input/delivery"), /^\/input\/delivery\/\d+\/taxClass$/u],
    ["/input/required", classRemedy("/input/required"), /^\/input\/required\/\d+\/target\/taxClass$/u],
  ],
  tax_rule_missing: [
    ["/input/required", "Have the coverage owner supply an effective rule or explicit exemption for /input/required, then obtain a fresh quote.", /^\/input\/required\/\d+$/u],
    ["/input/policyRevision", "Have the coverage owner recover the rules for the original policy revision before requesting another quote.", /^\/input\/policyRevision$/u],
    ["/input/classMapRevision", "Have the coverage owner recover the original class map before requesting another quote.", /^\/input\/classMapRevision$/u],
    ["/input/shipFromRef", "Have the coverage owner qualify the original shipping origin for /input/shipFromRef, then obtain a fresh quote.", /^\/input\/shipFromRef(?:\/subdivisionCode)?$/u],
    ["/input/destination/address/subdivisionCode", "Have the coverage owner qualify the destination subdivision for /input/destination/address/subdivisionCode, then obtain a fresh quote.", /^\/input\/destination\/address\/subdivisionCode$/u],
    ["/calculation/tax_breakdown", "Have the coverage owner qualify the fee and jurisdiction rules for /calculation/tax_breakdown, then obtain a fresh quote.", /^\/calculation\/tax_breakdown(?:\/|$)/u],
    ["/calculation/shipping_cost/tax_breakdown", "Have the coverage owner qualify the shipping jurisdiction and tax rule for /calculation/shipping_cost/tax_breakdown, then obtain a fresh quote.", /^\/calculation\/shipping_cost\/tax_breakdown(?:\/|$)/u],
    ["/line_items", "Have the coverage owner qualify the merchandise jurisdiction and tax rules for /line_items, then obtain a fresh quote.", /^\/line_items(?:\/|$)/u],
  ],
  tax_coverage_undeclared: [["/coverage/declarations", undeclared, /^\/coverage\/declarations$/u]],
  tax_coverage_inconsistent: [["/observations", "Have the coverage owner reconcile registration, treatment and assessment for /observations, then obtain a fresh quote.", /^\/observations(?:\/\d+)?$/u]],
  tax_breakdown_incomplete: [["/taxEvidence", "Have the tax adapter owner resolve the incomplete calculation breakdown, then obtain a fresh quote.", /^\/(?:calculation|line_items|registrations|money|evidence|positions)(?:\/|$)/u]],
  tax_amount_out_of_range: [
    ["/input/money", "Use supported basket amounts, including the combined basis, and obtain a fresh quote.", /^\/input\/money(?:\/|$)/u],
    ["/taxEvidence", "Recover the original calculation with authoritative amounts within the supported range before requesting another quote.", /^\/(?:calculation|line_items|money|evidence|positions)(?:\/|$)/u],
  ],
  tax_reference_conflict: [["/taxEvidence", "Have the tax adapter owner resolve the conflicting request or response binding, then obtain a fresh quote.", /^(?:|\/(?:key|scope|inputDigest|original|calculation|line_items|result|evidence)(?:\/.*)?)$/u]],
  tax_calculation_unusable: [["/taxEvidence", "Have the tax coverage owner supply coverage supported by effective observations, then obtain a fresh quote.", /^\/(?:evidence|coverage|calculation|result)(?:\/|$)/u]],
  tax_calculation_expired: [["/taxEvidence/expiresAt", expired().remedy, /^\/calculation\/expires_at$/u]],
  tax_operation_unsupported: [
    ["/input/taxDate", "Use a whole-second UTC tax instant on or after the Unix epoch.", /^\/input\/taxDate$/u],
    ["/input/money/sources", "Use at least one merchandise line and keep every merchandise amount positive before and after discounts.", /^\/input\/money\/sources(?:\/\d+)?$/u],
    ["/input/money/delivery", "Use at most one shipping bucket and no handling buckets.", /^\/input\/money\/delivery$/u],
    ["/input/delivery/0", "Use a qualified delivery service and matching cost currency.", /^\/input\/delivery\/0$/u],
    ["/input/money/delivery/0", "Use a qualified zero-shipping route, supply independent inactivity evidence, or use a supported positive shipping charge.", /^\/input\/money\/delivery\/0$/u],
    ["/input/money/adjustments", "Use the undiscounted basket or a qualified promotion that fits the selected tax route.", /^\/input\/money\/adjustments(?:\/|$)/u],
    ["/calculation/tax_breakdown", routeRemedy, /^\/calculation\/tax_breakdown(?:\/|$)/u],
    ["/calculation/shipping_cost/tax_breakdown", "Use a qualified calculation route for the shipping breakdown.", /^\/calculation\/shipping_cost\/tax_breakdown(?:\/|$)/u],
    ["/line_items", "Use a qualified calculation route for the merchandise breakdown.", /^\/line_items(?:\/|$)/u],
  ],
};

export function projectAdapterFailure(failure: AdapterFailure) {
  if (failure.kind === "unavailable") {
    if (failure.effect !== "none") return { kind: "indeterminate" as const };
    if (failure.code === "tax_adapter_unavailable" || failure.code === "tax_coverage_evidence_unavailable")
      return { kind: "unavailable" as const, code: failure.code };
  } else {
    const rule = Object.hasOwn(rules, failure.code) ? rules[failure.code]?.find(([, , source]) => source.test(failure.field)) : undefined;
    if (rule) return refused(failure.code, rule[0], rule[1]);
  }
  return refused("tax_adapter_response_invalid", "/taxEvidence", "Resolve the unrecognised response with the tax adapter owner before requesting a new quote.");
}
