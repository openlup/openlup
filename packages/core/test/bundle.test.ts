import { describe, expect, it } from "vitest";
import type { Bundle, CompositionRulesPort } from "../src/bundle/contracts.js";

const bundle: Bundle = {
  coreLines: [{ variantId: "variant-alpha", qty: 2, isAddon: false }],
  addonLines: [{ variantId: "addon-beta", qty: 1, isAddon: true }],
  constraint: { kind: "fixed.catalog", version: 1, data: { expectedCoreQty: 2 } },
};

describe("bundle contracts", () => {
  it("keeps composition validation and resizing provider-neutral", async () => {
    const port: CompositionRulesPort = {
      async validateComposition(input) {
        const expected = Number(input.constraint.data.expectedCoreQty);
        const actual = input.coreLines.reduce((total, line) => total + line.qty, 0);
        return actual === expected ? { ok: true } : { ok: false, code: "quantity_mismatch" };
      },
      async resizeComposition(input) {
        if (input.lever.kind !== "coreQty") return null;
        return {
          constraint: input.constraint,
          coreLines: input.coreLines.map((line) => ({ ...line, qty: Number(input.lever.value) })),
        };
      },
    };

    await expect(port.validateComposition(bundle)).resolves.toEqual({ ok: true });
    await expect(port.resizeComposition({
      coreLines: bundle.coreLines,
      constraint: bundle.constraint,
      lever: { kind: "coreQty", value: 3 },
    })).resolves.toMatchObject({ coreLines: [{ variantId: "variant-alpha", qty: 3 }] });
  });
});
