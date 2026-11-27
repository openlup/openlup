import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as server from "../../src/commerce/server/index.js";
import * as commerce from "@openlup/platform/commerce";

it.each(["commerce", "commerce/contracts", "pricing/browser"].flatMap(entry =>
  ["src", "dist"].map(tree => ({ entry, tree })),
))("bundles the complete $tree/$entry entry for browsers without Node imports", async ({ entry, tree }) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../${tree}/${entry}/index.${tree === "src" ? "ts" : "js"}`, import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports);
  expect(imports.filter(input => input.external || input.path.startsWith("node:") || builtinModules.includes(input.path))).toEqual([]);
  expect(Object.keys(result.metafile.inputs).some(path => /commerce\/server\//.test(path))).toBe(false);
  expect(Object.keys(result.metafile.inputs).some(path => /pricing\/index\.(?:ts|js)$/.test(path))).toBe(false);
  expect(result.outputFiles).toHaveLength(1);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const closure = Object.keys(result.metafile.inputs).map(path => relative(root, resolve(path)).replaceAll("\\", "/"))
    .filter(path => path.startsWith("packages/platform/"))
    .map(path => path.replace("/src/", "/dist/").replace(/\.ts$/, ".js"));
  for (const profile of ["identity", "subscription"]) {
    const { files } = JSON.parse(readFileSync(new URL(`../../../../config/public-reference-${profile}-imports.json`, import.meta.url), "utf8")) as { files: string[] };
    expect(files).toEqual(expect.arrayContaining(closure));
  }
});

it("exposes OMS handlers only through the server entry", () => {
  expect(server.createAdminCommerceOrdersListHandler).toBeTypeOf("function");
  expect(commerce).not.toHaveProperty("createAdminCommerceOrdersListHandler");
});

it("exposes checkout compensation only through the server entry", () => {
  expect(server.tryCompensate).toBeTypeOf("function");
  expect(commerce).not.toHaveProperty("tryCompensate");
});

it("exposes native quote composition only through the server entry", async () => {
  expect(server.createDbBackedCommerceQuotePortV2).toBeTypeOf("function");
  expect(commerce).not.toHaveProperty("createDbBackedCommerceQuotePortV2");
  expect(await import("@openlup/platform/commerce/contracts")).not.toHaveProperty("createDbBackedCommerceQuotePortV2");
});

it("exposes the checkout engine only through the server entry", () => {
  for (const name of ["createCommerceCheckoutHandler", "createCommerceRuntimeService", "createPaidOrderOrchestration", "createOfferAvailabilityPort"]) {
    expect(server).toHaveProperty(name, expect.any(Function));
    expect(commerce).not.toHaveProperty(name);
  }
});

it("exposes exactly the seven pricing browser symbols with their original identity", async () => {
  const browser = await import("../../src/pricing/browser/index.js");
  const primitives = await import("../../src/pricing/quotePrimitives.js");
  const acquisition = await import("../../src/pricing/acquisitionTermsSchemas.js");
  const subscription = await import("../../src/pricing/subscriptionPricePolicy.js");
  const shipping = await import("../../src/shipping/thresholdPolicy.js");
  expect(Object.keys(browser).sort()).toEqual([
    "acquisitionCapabilitySchema", "acquisitionTermsExpectationSchema", "acquisitionTermsSchema", "createCommerceQuotePrimitives",
    "deriveSubscriptionUnitPrice", "resolvedAcquisitionTermsSchema", "shippingTermsSchema",
  ]);
  expect(browser.createCommerceQuotePrimitives).toBe(primitives.createCommerceQuotePrimitives);
  expect(browser.acquisitionCapabilitySchema).toBe(acquisition.acquisitionCapabilitySchema);
  expect(browser.acquisitionTermsExpectationSchema).toBe(acquisition.acquisitionTermsExpectationSchema);
  expect(browser.acquisitionTermsSchema).toBe(acquisition.acquisitionTermsSchema);
  expect(browser.resolvedAcquisitionTermsSchema).toBe(acquisition.resolvedAcquisitionTermsSchema);
  expect(browser.deriveSubscriptionUnitPrice).toBe(subscription.deriveSubscriptionUnitPrice);
  expect(browser.shippingTermsSchema).toBe(shipping.shippingTermsSchema);
});

it("keeps the structural money schemas on the pricing server entry", async () => {
  const pricing = await import("../../src/pricing/index.js");
  const owner = await import("../../src/pricing/quoteMoneyValidationV2.js");
  const browser = await import("../../src/pricing/browser/index.js");
  const contracts = await import("../../src/pricing/contracts/index.js");
  const schemas = {
    commerceMoneyV2CurrencySchema: owner.currency, commerceMoneyV2DeliveryBucketSchema: owner.bucket,
    commerceMoneyV2DigestSchema: owner.digest, commerceMoneyV2FactsSchema: owner.factsShape,
    commerceMoneyV2FeeLineSchema: owner.feeLine, commerceMoneyV2LineSchema: owner.line,
    commerceMoneyV2MinorSchema: owner.minor, commerceMoneyV2PriceSchema: owner.price,
    commerceMoneyV2PromotionEngineSchema: owner.engine, commerceMoneyV2ReferenceSchema: owner.ref,
    commerceMoneyV2TaxEvidenceShape: owner.evidence, commerceMoneyV2UuidSchema: owner.uuid,
  } as const;
  for (const [name, schema] of Object.entries(schemas)) {
    expect(pricing[name as keyof typeof schemas]).toBe(schema);
    expect(browser).not.toHaveProperty(name);
    expect(contracts).not.toHaveProperty(name);
  }
});

it("admits exactly the built pricing browser closure without its server root", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../dist/pricing/browser/index.js", import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const closure = Object.keys(result.metafile.inputs).map(path => relative(root, resolve(path)).replaceAll("\\", "/"))
    .filter(path => path.startsWith("packages/platform/")).sort();
  expect(closure).toEqual([
    "packages/platform/dist/pricing/acquisitionTermsSchemas.js",
    "packages/platform/dist/pricing/browser/index.js",
    "packages/platform/dist/pricing/contracts/acquisitionTerms.js",
    "packages/platform/dist/pricing/contracts/index.js",
    "packages/platform/dist/pricing/contracts/offer.js",
    "packages/platform/dist/pricing/contracts/offerPolicy.js",
    "packages/platform/dist/pricing/contracts/policy.js",
    "packages/platform/dist/pricing/contracts/provenance.js",
    "packages/platform/dist/pricing/contracts/quote.js",
    "packages/platform/dist/pricing/quotePrimitives.js",
    "packages/platform/dist/pricing/subscriptionPricePolicy.js",
    "packages/platform/dist/pricing/validation.js",
    "packages/platform/dist/shipping/thresholdPolicy.js",
  ]);
  for (const profile of ["identity", "subscription"]) {
    const { files } = JSON.parse(readFileSync(new URL(`../../../../config/public-reference-${profile}-imports.json`, import.meta.url), "utf8")) as { files: string[] };
    expect(files).toEqual(expect.arrayContaining(closure));
    expect(files).not.toContain("packages/platform/dist/pricing/index.js");
    expect(files).not.toContain("packages/platform/dist/commerce/server/index.js");
  }
});

it("a consumer of the existing pricing browser symbols bundles no zod configuration call", async () => {
  // zod's own source contains the word `jitless`; the witness is the configuration call that
  // pricing/validation.ts makes. `deriveSubscriptionUnitPrice` reaches that module, so the
  // negative control below imports it and finds the call.
  const entry = fileURLToPath(new URL("../../dist/pricing/browser/index.js", import.meta.url));
  const bundleOf = async (symbol: string) => (await build({
    stdin: { contents: `import { ${symbol} } from ${JSON.stringify(entry)};\nconsole.log(${symbol});\n`, resolveDir: fileURLToPath(new URL("../..", import.meta.url)), loader: "js" },
    bundle: true, platform: "browser", format: "esm", write: false, minify: false, logLevel: "silent",
  })).outputFiles[0]!.text;
  const configurationCall = /\.config\(\{\s*jitless:\s*true/;
  expect(await bundleOf("shippingTermsSchema")).not.toMatch(configurationCall);
  expect(await bundleOf("deriveSubscriptionUnitPrice")).toMatch(configurationCall);
});

it("bundles the built commerce entry and its complete module graph for browsers", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../dist/commerce/index.js", import.meta.url))], bundle: true, platform: "browser", format: "esm", treeShaking: false, write: false, metafile: true, logLevel: "silent" });
  expect(result.outputFiles[0]!.text).not.toMatch(/(?:from|import\s*\(|require\s*\()\s*["']node:/);
  expect(Object.keys(result.metafile!.inputs).filter(path => /commerce\/(?:server|adapters)\/|platform\/dist\/(?:pricing|shipping)\/index\.js$/.test(path))).toEqual([]);
});

it("keeps locale label helpers and tables out of the commerce runtime export list", () => {
  const names = Object.keys(commerce);
  expect(names).not.toContain("timelineLabelForStep");
  expect(names).not.toContain("FULFILLMENT_STATUS_MAP");
});

it('exports browser-safe recovery start schemas through the commerce entry', () => {
  expect(commerce.CHECKOUT_RECOVERY_START_CONTRACT_VERSION).toBe('commerce.checkout-recovery.v1');
  expect(commerce.checkoutRecoveryStartRequestSchema.safeParse({orderId:'11111111-1111-4111-8111-111111111111'}).success).toBe(true);
  expect(commerce.checkoutRecoveryStartResponseSchema.safeParse({contractVersion:'commerce.checkout-recovery.v1',recoverable:false,fallback:'customer_account'}).success).toBe(true);
});
