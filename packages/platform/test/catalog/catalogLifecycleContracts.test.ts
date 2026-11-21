import { expect, expectTypeOf, it } from "vitest";
import type { CatalogPublicationReadResult, CatalogPublicationReceiptResult, CatalogHistoryResult, CatalogPublicationRefusal, CatalogPublishCommand } from "../../src/catalog/contracts/index.js";
import type { CatalogPublicationPort, VerifiedCatalogPublisher } from "../../src/catalog/publicationPorts.js";

import { catalogPublicationClaim, compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { revision } from "./fixtures/publicationInput.js";
import { lifecycleTransition, type CatalogDraftPayloadV4 } from "../../src/catalog/publicationIntent.js";

it("keeps absence separate from refusal and publication authority opaque", () => {
  type RefusalOutcome = "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  expectTypeOf<CatalogPublicationRefusal["outcome"]>().toEqualTypeOf<RefusalOutcome>();
  // Refusals are one named DTO; excluding its full outcome union leaves only successes.
  expectTypeOf<Exclude<CatalogPublicationReadResult, CatalogPublicationRefusal>["outcome"]>().toEqualTypeOf<"found" | "unpublished">();
  expectTypeOf<Exclude<CatalogPublicationReceiptResult, CatalogPublicationRefusal>["outcome"]>().toEqualTypeOf<"found" | "absent">();
  expectTypeOf<Exclude<CatalogHistoryResult, CatalogPublicationRefusal>["outcome"]>().toEqualTypeOf<"page">();
  expectTypeOf<CatalogPublishCommand["changes"][number]["state"]>().toEqualTypeOf<"active" | "withdrawn">();
  expectTypeOf<Parameters<CatalogPublicationPort["publish"]>[1]>().toEqualTypeOf<VerifiedCatalogPublisher>();
  expectTypeOf<{ actorId: string; role: "publisher" }>().not.toExtend<VerifiedCatalogPublisher>();
});

it("admits only the lifecycle matrix and never changes a terminal identity", () => {
  const states = ["draft", "active", "withdrawn", "archived"] as const;
  const ordinary = ["draft:active", "draft:archived", "active:active", "active:withdrawn", "withdrawn:archived"];
  for (const from of states) for (const to of states) {
    expect(lifecycleTransition(from, to, false)).toBe(ordinary.includes(`${from}:${to}`));
    expect(lifecycleTransition(from, to, true)).toBe(from === "withdrawn" && to === "active");
  }
});

it("requires the exact owned roster at the parent withdrawal prefix", async () => {
  const fixture = await revision();
  const sku = fixture.evidence.skus[0]!;
  const product = fixture.evidence.product!;
  product.status = "active";
  sku.status = "active";
  sku.sellableStandalone = true;
  fixture.evidence.lifecycle = { product: "active", skus: { [sku.code]: { state: "active" } } };
  for (const children of [[], [{ skuCode: "FOREIGN-SKU", expectedState: "active" as const }],
    [{ skuCode: sku.code, expectedState: "draft" as const }]]) {
    const payload: CatalogDraftPayloadV4 = { ...fixture.payload, schemaVersion: 4,
      publication: { kind: "release", evidence: {}, operations: [{
        op: "set_product_lifecycle", productSlug: product.slug, expectedState: "active", state: "withdrawn", children,
      }] } };
    const record = { ...fixture.record, payload };
    const evidence = { ...fixture.evidence, drafts: [{ ...fixture.evidence.drafts[0]!,
      record, receipt: catalogPublicationClaim(record) }, ...fixture.evidence.drafts.slice(1)] };
    await expect(compileCatalogPublication({ ...fixture, record, evidence }))
      .rejects.toMatchObject({ code: "catalog_lifecycle_child_effects_mismatch" });
  }
});
