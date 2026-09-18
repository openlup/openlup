import { describe, expect, it } from "vitest";
import type { OmnipackReconciliationResult } from "./omnipackReconciliationContracts.js";

describe("OmniPack reconciliation result contract", () => {
  it("carries a dedicated accounting failure counter and a separate refusal counter", () => {
    const result = { invoiceIssueFailures: 1, invoiceIssueRefused: 1 } as OmnipackReconciliationResult;
    expect(result.invoiceIssueFailures).toBe(1);
    expect(result.invoiceIssueRefused).toBe(1);
  });
});
