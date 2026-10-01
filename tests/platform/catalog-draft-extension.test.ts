import { describe, expect, it } from "vitest";
import { catalogDraftPayloadSchema, canonicalCatalogDraftJson } from "../../src/domains/catalog/catalogDraftContracts.js";
import { createCatalogProductTypeRegistry } from "../../src/domains/catalog/catalogProductTypeContracts.js";
import { validateCatalogDraft } from "../../server/domains/catalog/catalogDraftValidation.js";

const productId = "30000000-0000-4000-8000-000000000001";
const registry = createCatalogProductTypeRegistry([{
  key: "example:piece", version: 1,
  units: [{ code: "item:piece", dimension: "count", integral: true }], netContentUnits: ["item:piece"],
  dimensions: [{ key: "size", kind: "choice", values: ["small", "large"] }, { key: "finish", kind: "choice", values: ["matte", "gloss"] }],
  validateContent: (content) => typeof content === "object" && content !== null && "title" in content && typeof content.title === "string" ? [] : [{ path: "title", code: "title_invalid" }],
}]);
const packRegistry = createCatalogProductTypeRegistry([{
  key: "example:piece", version: 2,
  units: [{ code: "item:piece", dimension: "count", integral: true }], netContentUnits: ["item:piece"],
  dimensions: [{ key: "pack", kind: "quantity", dimension: "count", units: ["item:piece"], role: "net_content" }],
  validateContent: (content) => typeof content === "object" && content !== null && "title" in content && typeof content.title === "string" ? [] : [{ path: "title", code: "title_invalid" }],
}]);

describe("neutral installed catalog extension fixture", () => {
  it("installs a count type with two explicit dimensions and only the declared combination", () => {
    const payload = catalogDraftPayloadSchema.parse({ schemaVersion: 1,
      product: { id: productId, type: { key: "example:piece", version: 1 }, dimensions: ["size", "finish"], sharedContent: { title: "Plain article" } },
      skus: [{ id: "40000000-0000-4000-8000-000000000001", productId,
        options: { size: { kind: "choice", value: "small" }, finish: { kind: "choice", value: "matte" } }, netContent: { dimension: "count", unscaled: "1", scale: 0, unit: "item:piece" } }],
    });
    expect(validateCatalogDraft(payload, registry).valid).toBe(true);
    expect(payload.skus).toHaveLength(1);
    expect(canonicalCatalogDraftJson(payload)).not.toContain("energy");
  });
  it("a neutral piece type adds a 60/120 count pack axis with the net-content role and no core change", () => {
    const pieces = (unscaled: string) => ({ dimension: "count" as const, unscaled, scale: 0, unit: "item:piece" });
    const payload = catalogDraftPayloadSchema.parse({ schemaVersion: 1,
      product: { id: productId, type: { key: "example:piece", version: 2 }, dimensions: ["pack"], sharedContent: { title: "Plain article" } },
      skus: ["60", "120"].map((unscaled, index) => ({ id: `40000000-0000-4000-8000-00000000000${index + 2}`, productId,
        options: { pack: { kind: "quantity", value: pieces(unscaled) } }, netContent: pieces(unscaled) })),
    });
    expect(validateCatalogDraft(payload, packRegistry).valid).toBe(true);
    payload.skus[1].netContent = pieces("60");
    expect(validateCatalogDraft(payload, packRegistry)).toEqual({ valid: false, issues: [{ path: "skus.1.options.pack", code: "net_content_option_mismatch" }] });
    expect(canonicalCatalogDraftJson(payload)).not.toContain("energy");
  });
});
