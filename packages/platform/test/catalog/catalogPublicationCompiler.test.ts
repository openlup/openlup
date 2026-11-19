import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { compileCatalogPublication, type CatalogPublicationCompileInput } from "../../src/catalog/publicationValidation.js";
import { input } from "./fixtures/publicationInput.js";

it("CD-CAT-43 delegates opaque document decoding and SKU facts to the installed rules", () => {
  const source = input();
  const decodeDocument = vi.fn((canonicalText: string) => ({ ...JSON.parse(canonicalText), installed: true }));
  const canonicalizeDocument = (value: unknown) => {
    const { installed: _installed, ...document } = value as Record<string, unknown>;
    return source.rules.canonicalizeDocument(document);
  };
  const deriveSkuFacts = vi.fn((value: unknown) => {
    expect(value).toMatchObject({ installed: true, derived: 12 });
    return source.rules.deriveSkuFacts(value);
  });
  // The installed decoder adds the same marker carried by the authored object.
  const prepared = { ...source, rules: { ...source.rules, decodeDocument, canonicalizeDocument, deriveSkuFacts } };
  source.payload.product.sharedContent.document!.installed = true;
  expect(compileCatalogPublication(prepared).skus).toHaveLength(1);
  expect(deriveSkuFacts).toHaveBeenCalled();
});

const witnesses = [
  "W32_V5-0306_predicate_precedence_boundary",
  "W32_V5-0565_predicate_precedence_boundary",
  "W32_V5-0576_predicate_precedence_boundary",
  "W32_V5-0577_predicate_precedence_boundary",
  "W32_V5-0578_predicate_precedence_boundary",
  "W32_V5-0579_predicate_precedence_boundary",
  "W32_V5-0581_predicate_precedence_boundary",
  "W32_V5-0583_predicate_precedence_boundary",
  "W32_V5-0584_predicate_precedence_boundary",
  "W32_V5-0586_predicate_precedence_boundary",
  "W32_V5-0588_predicate_precedence_boundary",
  "W32_V5-0589_predicate_precedence_boundary",
  "W32_V5-0590_predicate_precedence_boundary",
  "W32_V5-0592_predicate_precedence_boundary",
  "W32_V5-0594_predicate_precedence_boundary",
  "W32_V5-0595_predicate_precedence_boundary",
  "W32_V5-0599_predicate_precedence_boundary",
  "W32_V5-0601_predicate_precedence_boundary",
  "W32_V5-0603_predicate_precedence_boundary",
  "W32_V5-0605_predicate_precedence_boundary",
  "W32_V5-0607_predicate_precedence_boundary",
  "W32_V5-0608_predicate_precedence_boundary",
  "W32_V5-0609_predicate_precedence_boundary",
  "W33_V5-0610_predicate_precedence_boundary",
  "W32_V5-0611_predicate_precedence_boundary",
  "W32_V5-0612_predicate_precedence_boundary",
  "W32_V5-0613_predicate_precedence_boundary",
  "W32_V5-0614_predicate_precedence_boundary",
  "W32_V5-0615_predicate_precedence_boundary",
  "W32_V5-0616_predicate_precedence_boundary",
  "W32_V5-0617_predicate_precedence_boundary",
  "W15_V5-1851_predicate_precedence_boundary",
  "W17_V5-1852_predicate_precedence_boundary",
  "W15_V5-1956_predicate_precedence_boundary",
  "W15_V5-1957_predicate_precedence_boundary",
  "W15_V5-1960_predicate_precedence_boundary",
  "W15_V5-1961_predicate_precedence_boundary",
  "W15_V5-1962_predicate_precedence_boundary",
  "W15_V5-1963_predicate_precedence_boundary",
  "W15_V5-1966_predicate_precedence_boundary",
  "W15_V5-1967_predicate_precedence_boundary",
  "W16_V5-1972_predicate_precedence_boundary",
  "W16_V5-1973_predicate_precedence_boundary",
  "W16_V5-1974_predicate_precedence_boundary",
  "W16_V5-1975_predicate_precedence_boundary",
  "W16_V5-1977_predicate_precedence_boundary",
  "W16_V5-1978_predicate_precedence_boundary",
  "W16_V5-1980_predicate_precedence_boundary",
  "W16_V5-1981_predicate_precedence_boundary",
  "W16_V5-1983_predicate_precedence_boundary",
  "W16_V5-1984_predicate_precedence_boundary",
  "W16_V5-1986_predicate_precedence_boundary",
  "W16_V5-1987_predicate_precedence_boundary",
  "W16_V5-1989_predicate_precedence_boundary",
  "W16_V5-1990_predicate_precedence_boundary",
  "W16_V5-1992_predicate_precedence_boundary",
  "W16_V5-1993_predicate_precedence_boundary",
  "W16_V5-1995_predicate_precedence_boundary",
  "W16_V5-1996_predicate_precedence_boundary",
  "W16_V5-1998_predicate_precedence_boundary",
  "W16_V5-1999_predicate_precedence_boundary",
  "W16_V5-2001_predicate_precedence_boundary",
  "W16_V5-2002_predicate_precedence_boundary",
  "W16_V5-2005_predicate_precedence_boundary",
  "W16_V5-2006_predicate_precedence_boundary",
  "W16_V5-2007_predicate_precedence_boundary",
  "W16_V5-2008_predicate_precedence_boundary",
  "W16_V5-2013_predicate_precedence_boundary",
  "W16_V5-2014_predicate_precedence_boundary",
  "W16_V5-2015_predicate_precedence_boundary",
  "W16_V5-2017_predicate_precedence_boundary",
  "W16_V5-2018_predicate_precedence_boundary",
  "W26_V5-2077_predicate_precedence_boundary",
  "W26_V5-2078_predicate_precedence_boundary",
  "W26_V5-2079_predicate_precedence_boundary",
  "W26_V5-2080_predicate_precedence_boundary",
  "W26_V5-2081_predicate_precedence_boundary",
  "W26_V5-2082_predicate_precedence_boundary",
  "W26_V5-2084_predicate_precedence_boundary",
  "W26_V5-2085_predicate_precedence_boundary",
  "W26_V5-2086_predicate_precedence_boundary",
  "W26_V5-2087_predicate_precedence_boundary",
  "W28_V5-2112_predicate_precedence_boundary",
  "W28_V5-2113_predicate_precedence_boundary",
  "W28_V5-2114_predicate_precedence_boundary",
  "W28_V5-2115_predicate_precedence_boundary",
  "W28_V5-2117_predicate_precedence_boundary",
  "W28_V5-2118_predicate_precedence_boundary",
  "W28_V5-2120_predicate_precedence_boundary",
  "W28_V5-2124_predicate_precedence_boundary",
  "W28_V5-2125_predicate_precedence_boundary",
  "W29_V5-2131_predicate_precedence_boundary",
  "W29_V5-2132_predicate_precedence_boundary",
  "W29_V5-2133_predicate_precedence_boundary",
  "W29_V5-2135_predicate_precedence_boundary",
  "W29_V5-2136_predicate_precedence_boundary",
  "W29_V5-2137_predicate_precedence_boundary",
  "W29_V5-2138_predicate_precedence_boundary",
  "W29_V5-2140_predicate_precedence_boundary",
  "W29_V5-2141_predicate_precedence_boundary",
  "W29_V5-2142_predicate_precedence_boundary",
  "W29_V5-2143_predicate_precedence_boundary",
  "W29_V5-2144_predicate_precedence_boundary",
  "W29_V5-2145_predicate_precedence_boundary",
  "W33_V5-2146_predicate_precedence_boundary"
] as const;
it.each(witnesses)("%s", () => {
  const mutate = (data: CatalogPublicationCompileInput, name: string, patch: Record<string, unknown>) =>
    Object.assign(data.payload.publication.operations.find(operation => operation.op === name)!, patch);
  const cases: [string, (data: CatalogPublicationCompileInput) => void][] = [
    ["catalog_publication_v3_active_primary_required", data => { data.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" }); }],
    ["duplicate_combination", data => {
      const second = structuredClone(data.payload.skus[0]); second.id = "20000000-0000-4000-8000-000000000002"; second.code = "SECOND";
      second.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }]; data.payload.skus.push(second);
      const facts = { ...data.payload.product.sharedContent.publicationSkus[0], skuCode: "SECOND" }; data.payload.product.sharedContent.publicationSkus.push(facts);
      data.payload.publication.operations.push({ op: "create_sku", skuId: second.id, productSlug: "article", documentRevisionNo: 1, ...facts },
        { op: "create_identifier", skuCode: "SECOND", scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null });
    }],
    ["catalog_publication_source_invalid", data => { data.record.status = "abandoned"; }],
    ["catalog_publication_scope_expansion", data => { mutate(data, "create_product", { productSlug: "other" }); }],
    ["catalog_publication_v3_compile_product_conflict", data => { mutate(data, "create_product", { productId: "10000000-0000-4000-8000-000000000002" }); }],
    ["catalog_publication_operation_source_mismatch", data => { mutate(data, "create_sku", { title: "Other title" }); }],
    ["catalog_publication_operation_source_mismatch", data => { mutate(data, "create_sku", { facts: { derived: 13 } }); }],
    ["catalog_publication_identifier_source_mismatch", data => { mutate(data, "create_identifier", { issuer: "other" }); }],
    ["catalog_publication_logistics_source_mismatch", data => { data.payload.publication.operations.push({ op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: "other" }); }],
    ["catalog_publication_membership_source_mismatch", data => { data.payload.publication.operations.push({ op: "set_offer_membership", skuCode: "ARTICLE", offerVersion: "example:offer", admitted: true }); }],
    ["catalog_publication_eligibility_source_mismatch", data => { data.payload.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false }); }],
    ["catalog_publication_presentation_source_mismatch", data => { mutate(data, "set_product_presentation", { presentation: { wrong: true } }); }],
    ["catalog_publication_document_source_mismatch", data => { mutate(data, "register_document_revision", { sourceRef: "example:other" }); }],
    ["catalog_publication_v3_document_digest_mismatch", data => { mutate(data, "register_document_revision", { canonicalText: "not JSON" }); }],
    ["catalog_publication_v3_document_invalid", data => {
      const text = '{ "derived":12,"schemaVersion":1 }', digest = createHash("sha256").update(text).digest("hex");
      data.payload.product.documentRevision!.digest = digest; mutate(data, "register_document_revision", { canonicalText: text, digest });
    }],
    ["catalog_publication_document_revision_sequence", data => {
      const document = { ...data.payload.product.sharedContent.document, revisionNo: 2 };
      const text = JSON.stringify(document, Object.keys(document).sort()), digest = createHash("sha256").update(text).digest("hex");
      data.payload.product.sharedContent.document = document;
      Object.assign(data.payload.product.documentRevision!, { revisionNo: 2, digest });
      mutate(data, "register_document_revision", { revisionNo: 2, canonicalText: text, digest });
      mutate(data, "move_document_pointer", { documentRevisionNo: 2 }); mutate(data, "create_sku", { documentRevisionNo: 2 });
    }],
    ["catalog_publication_v3_compile_document_stale", data => { mutate(data, "create_sku", { documentRevisionNo: 2 }); }],
    ["catalog_publication_v3_compile_primary_foreign", data => { mutate(data, "set_primary_sku", { skuCode: "MISSING" }); }],
  ];
  for (const [reason, change] of cases) {
    const data = input(); change(data);
    if (reason === "catalog_publication_v3_compile_primary_foreign") expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_sku_absent");
    else expect(() => compileCatalogPublication(data), reason).toThrow(reason);
  }
  const data = input(), first = compileCatalogPublication(data);
  const old = structuredClone(data.record);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents; data.retainedSources = [old];
  data.record = { ...data.record, draftId: "30000000-0000-4000-8000-000000000002", fingerprint: "c".repeat(64), payload: data.payload };
  data.payload.product.sharedContent.catalogAction = "revise"; data.payload.skus = []; delete data.payload.product.primarySkuId;
  Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
  data.payload.publication.kind = "compensation";
  const operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
  if (operation.op !== "register_document_revision") throw new Error("Fixture lacks document");
  operation.provenance = { source: "retained_draft", draftId: old.draftId, draftRevision: old.revision, draftCommandKey: old.commandKey, draftFingerprint: old.fingerprint };
  data.payload.publication.evidence.drafts = [{ draftId: old.draftId, revision: old.revision, commandKey: old.commandKey, fingerprint: old.fingerprint }];
  data.payload.publication.operations = [operation];
  expect(compileCatalogPublication(data).documents).toEqual(first.documents);
  data.payload.publication.operations = []; expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_change_noop");
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  expect(compileCatalogPublication(data).changed).toBe(false);
  data.payload.publication.kind = "release"; expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_change_noop");
});
