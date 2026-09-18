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
});
