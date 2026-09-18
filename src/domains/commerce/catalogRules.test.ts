import { describe, expect, it } from "vitest";

import { evaluateCatalogWriteRules } from "./catalogRules.js";
import { CATALOG_RULE_CODES, CATALOG_RULE_ENFORCEMENT } from "./catalogRuleCodes.js";

describe("catalog rule codes registry", () => {
  it("every rule code has an enforcement classification", () => {
    expect(CATALOG_RULE_CODES.length).toBeGreaterThan(0);
    for (const code of CATALOG_RULE_CODES) {
      expect(CATALOG_RULE_ENFORCEMENT[code]).toMatch(/^(request|rpc)$/);
    }
  });
});

describe("evaluateCatalogWriteRules", () => {
  it("blocks a machine actor from activating (draft-only)", () => {
    const r = evaluateCatalogWriteRules({ operation: "activate", actorKind: "machine" });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["DRAFT_ONLY_FOR_MACHINE"]);
  });

  it("allows a human actor to activate", () => {
    expect(evaluateCatalogWriteRules({ operation: "activate", actorKind: "human" }).ok).toBe(true);
  });

  it("allows a machine actor to create/update drafts, set price, archive", () => {
    for (const operation of ["create_draft", "update_draft", "set_price", "archive"] as const) {
      expect(evaluateCatalogWriteRules({ operation, actorKind: "machine" }).ok).toBe(true);
    }
  });
});
