import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { createHash } from "node:crypto";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { input, setupRules } from "./fixtures/publicationInput.js";
import { beforeAll, expect, it } from "vitest";
import { categoryDocument } from "./fixtures/categoryDocumentInput.js";
import { analysisKeys } from "./fixtures/categoryDocument.js";

let installed: ReturnType<typeof setupRules>;
beforeAll(async () => {
  const bundle = await rolldown({ input: fileURLToPath(new URL("./fixtures/categoryPublicationRules.ts", import.meta.url)),
    platform: "browser", resolve: { extensionAlias: { ".js": [".ts", ".js"] } } });
  try {
    const { output } = await bundle.generate({ format: "cjs", exports: "default", codeSplitting: false });
    if (output.length !== 1 || output[0].type !== "chunk") throw new Error("Expected one closed rules module");
    installed = setupRules(output[0].code);
  } finally { await bundle.close(); }
});

it.each([
  ["healthy", null],
  ["net ceiling", "catalog_publication_authored_amounts_invalid"],
  ["add-on", "package_unsupported"],
  ["net ceiling and add-on", "catalog_publication_authored_amounts_invalid"],
  ["additive scale", "catalog_publication_v3_document_invalid"],
  ...analysisKeys.map(key => [key, "catalog_publication_v3_document_invalid"] as const),
] as const)("ordered publication enforces the installed category predicate for %s", async (mode, refusal) => {
  const fixture = categoryDocument(), source = input(), sku = source.payload.skus[0], product = source.payload.product;
  const document = { ...fixture, productSlug: product.slug!,
    additions: [{ quantity: { ...fixture.additions[0]!.quantity, scale: mode === "additive scale" ? 5 : 4 } }],
    analysis: { ...fixture.analysis } as Partial<typeof fixture.analysis> };
  if ((analysisKeys as readonly string[]).includes(mode)) delete document.analysis[mode as typeof analysisKeys[number]];
  const addon = mode === "add-on" || mode === "net ceiling and add-on";
  const grams = mode.startsWith("net ceiling") ? "10000000" : "9999999";
  sku.netContent = { dimension: "mass", unit: "openlup:g", unscaled: grams, scale: 0 };
  product.sharedContent.publicationSkus[0].isAddon = addon;
  product.sharedContent.document = document;
  const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  Object.assign(product.documentRevision!, { schemaId: document.schemaVersion, documentRef: document.id, digest });
  for (const op of source.payload.publication.operations) {
    if (op.op === "create_sku") op.isAddon = addon;
    if (op.op === "register_document_revision") Object.assign(op, { documentRef: document.id, canonicalText, digest });
  }
  Object.assign(source, installed);
  if (refusal) await expect(compileCatalogPublication(source)).rejects.toMatchObject({ code: refusal });
  else expect((await compileCatalogPublication(source)).skus).toMatchObject([{ isAddon: false, netContent: sku.netContent }]);
});
