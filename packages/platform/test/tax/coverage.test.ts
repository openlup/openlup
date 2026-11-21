import { describe, expect, it } from "vitest";
import { reconcileTaxCoverage } from "../../src/tax/index.js";
import { active, cell, coverage, coverageInput, date, later, registered, taxable } from "./fixtures.js";

describe("tax coverage", () => {
  const input = coverageInput();
  const inactive = { ...active, state: "inactive" } as const;
  const exempt = { ...taxable, kind: "exempt" } as const;
  const acknowledged = (jurisdiction?: string) => ({
    ...registered(jurisdiction), status: "not_registered_acknowledged", acknowledgementRef: "ack-a",
  } as const);

  it("reports taxable zero and explicit exemptions", () => {
    expect(reconcileTaxCoverage(input)).toMatchObject({
      kind: "resolved", posting: "required", vector: [{ decision: "in_scope_taxed" }],
    });
    expect(reconcileTaxCoverage({ ...input, observations: [{ ...input.observations[0], treatment: exempt }] })).toMatchObject({
      kind: "resolved", posting: "required", vector: [{ decision: "in_scope_exempt", treatment: exempt }],
    });
  });

  it("skips only when every required cell is out of scope", () => {
    const skipped = { ...input, coverage: coverage(acknowledged()), observations: [{ cell: cell(), registration: inactive }] };
    expect(reconcileTaxCoverage(skipped)).toMatchObject({
      kind: "resolved", posting: "skip", vector: [{ decision: "out_of_scope", declaration: acknowledged() }],
    });
    const next = cell("item-a", "district-b");
    const mixed = {
      ...input, required: [cell(), next], coverage: coverage(registered(), acknowledged("district-b")),
      observations: [...input.observations, { cell: next, registration: inactive, assessedMinor: 0 }],
    };
    const result = reconcileTaxCoverage(mixed);
    expect(result).toMatchObject({ kind: "resolved", posting: "required",
      vector: [{ cell: next, decision: "out_of_scope" }, { cell: cell(), decision: "in_scope_taxed" }] });
    expect(reconcileTaxCoverage({ ...mixed, required: [...mixed.required].reverse(), observations: [...mixed.observations].reverse() }))
      .toEqual(result);
  });

  it("distinguishes undeclared, missing and stale evidence at the interval boundary", () => {
    const declaration = { ...registered(), effective: { from: date, until: later } };
    const registration = { ...active, effective: declaration.effective };
    const observations = [{ ...input.observations[0], registration }];
    expect(reconcileTaxCoverage({ ...input, coverage: coverage(declaration), observations })).toMatchObject({ kind: "resolved" });
    expect(reconcileTaxCoverage({ ...input, taxDate: later, coverage: coverage(declaration), observations })).toMatchObject({
      kind: "refused", code: "tax_coverage_undeclared", field: "/coverage/declarations", jurisdiction: "district-a", taxKind: "sale",
      vector: [{ decision: "undeclared" }],
    });
    for (const observation of [{ cell: cell(), registration }, { cell: cell() }, { ...input.observations[0], registration }]) {
      expect(reconcileTaxCoverage({ ...input, taxDate: later, observations: [observation] })).toMatchObject({
        kind: "unavailable", effect: "none", code: "tax_coverage_evidence_unavailable",
        vector: [{ decision: "unavailable_evidence" }],
      });
    }
    expect(reconcileTaxCoverage({ ...input, observations: [{ cell: cell(), registration: active, treatment: taxable }] }))
      .toMatchObject({ kind: "unavailable" });
  });

  it.each([
    [[{ cell: cell(), registration: inactive }]],
    [[{ cell: cell(), registration: active, treatment: { ...taxable, kind: "not_applicable" }, assessedMinor: 0 }]],
    [[{ cell: cell(), registration: active, treatment: exempt, assessedMinor: 1 }]],
    [[{ cell: { ...cell(), sourcing: "ship_from" } }]],
    [input.observations.concat(input.observations)],
  ] as const)("refuses contradictory evidence %j", observations => {
    expect(reconcileTaxCoverage({ ...input, observations })).toMatchObject({
      kind: "refused", code: "tax_coverage_inconsistent", field: "/observations", jurisdiction: "district-a",
      taxKind: "sale", vector: [{ decision: "inconsistent" }],
    });
  });

  it("refuses extra cells before undeclared or unavailable cells and keeps the required vector", () => {
    const missing = cell("item-a", "district-b");
    const inputWithMissing = {
      ...input, required: [cell(), missing], observations: [{ cell: cell("extra", "district-c") }],
    };
    expect(reconcileTaxCoverage(inputWithMissing)).toMatchObject({
      kind: "refused", code: "tax_coverage_inconsistent", jurisdiction: "district-c",
      vector: [{ cell: missing, decision: "undeclared" }, { cell: cell(), decision: "unavailable_evidence" }],
    });
  });

  it("refuses a coverage document from another account and duplicate required cells", () => {
    expect(reconcileTaxCoverage({ ...input, scope: { ...input.scope, accountRef: "other" } })).toMatchObject({
      kind: "refused", code: "tax_scope_mismatch", field: "/coverage/accountRef",
    });
    expect(reconcileTaxCoverage({ ...input, required: [cell(), cell()] })).toMatchObject({
      kind: "refused", code: "tax_invalid_input", field: "/required/1",
    });
  });
});
