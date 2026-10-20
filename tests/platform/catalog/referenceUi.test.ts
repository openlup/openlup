import ProductDetailsTabs from "../../../src/components/product/ProductDetailsTabs.js";
import ProductFAQ from "../../../src/components/product/ProductFAQ.js";
import { RenderRuntimeProvider } from "../../../src/app/renderMode.js";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { ReferenceCatalogRoutes } from "../../../src/routes/ReferenceCatalogRoutes.js";
import type { ReferenceCatalogSnapshot } from "../../../src/domains/catalog/referenceCatalogUi.js";
import { storefrontSsgCatalog, storefrontSsgDetails } from "../../../src/domains/catalog/exampleStorefrontSsgCatalog.js";
import { detailsFromStorefrontSsgCatalog, productFromStorefrontSsgCatalog, STOREFRONT_SSG_LOCALES } from "../../../src/domains/catalog/storefrontSsgCatalog.js";

it("server renders supplied catalog/product facts, media, details and locale links without activation", () => {
  const snapshot: ReferenceCatalogSnapshot = {
    profile: { id: "synthetic", brand: "Example", currency: "XXX", country: "ZZ", locale: "en", timezone: "UTC" }, catalogPath: "/x/items", builderPath: "/x/basket",
    products: [{ item: { sku: "UNIT-A", title: "Unit A", unitPrice: { amountMinor: 1234, currency: "XXX" }, permittedPurchaseModes: ["one_time", "subscription"] }, path: "/x/items/unit-a", description: "Supplied description", media: [{ src: "/media/unit-a.svg", alt: "Supplied asset", width: 240, height: 180 }], details: [{ heading: "Supplied facts", body: "Own detail bytes" }] }],
    copy: { catalog: "Items", builder: "Basket", quantity: "Quantity", mode: "Mode", oneTime: "Once", subscription: "Recurring", quote: "Quote", consent: "Accept quoted terms", secondDelivery: "Second delivery discount", continue: "Continue", refused: "Unavailable" },
  };
  function render(path: string) { return renderToString(createElement(StaticRouter, { location: path }, createElement(ReferenceCatalogRoutes, { input: { snapshots: [snapshot] } }))); }
  const catalog = render(snapshot.catalogPath), product = render(snapshot.products[0].path), builder = render(snapshot.builderPath);
  expect(catalog).toContain('href="/x/items/unit-a"'); expect(catalog).toContain("Unit A");
  for (const bytes of ["Supplied description", "/media/unit-a.svg", 'alt="Supplied asset"', 'width="240"', "Own detail bytes", 'href="/x/basket"', "12.34"]) expect(product).toContain(bytes);
  expect(builder).toContain("disabled"); expect(builder).not.toContain("Own detail bytes");
  // P5-01 inputs are additive: old snapshots and detail lookup keep their bytes.
  const locale = STOREFRONT_SSG_LOCALES[0], slug = storefrontSsgCatalog.productSlugs[0];
  const legacy = productFromStorefrontSsgCatalog(storefrontSsgCatalog, slug, locale)!;
  expect(legacy.media).toEqual([{ src: legacy.item.heroImage, alt: legacy.item.name }]);
  const originalDetails = detailsFromStorefrontSsgCatalog(storefrontSsgDetails, slug, locale)!;
  const suppliedDetails = { ...originalDetails, item: { ...originalDetails.item, ingredientCards: [{ name: "Component A", pct: "100%", role: "Declared", body: "Supplied detail composition", allergenSlugs: [] }] }, faq: [{ key: "own-faq", question: "Supplied question", answer: "Supplied answer" }] };
  const i18n = createInstance(); void i18n.init({ lng: "en", initAsync: false, resources: { en: { catalog: {} } } });
  function rich(details?: typeof originalDetails) {
    return renderToString(createElement(I18nextProvider, { i18n }, createElement(RenderRuntimeProvider, { mode: "ssg" }, [
      createElement(ProductDetailsTabs, { key: "tabs", product: legacy.item, locale, details }),
      createElement(ProductFAQ, { key: "faq", slug, locale, details }),
    ])));
  }
  expect(rich(suppliedDetails)).toContain("Supplied detail composition");
  expect(rich(suppliedDetails)).toContain("Supplied answer");
  expect(rich()).toContain(originalDetails.faq[0].question);
  expect(rich()).toContain(originalDetails.item.supplements.IU_kg);
  expect(rich()).not.toContain("Supplied detail composition");
  const noOptional = { ...snapshot, products: [{ ...snapshot.products[0], media: undefined, details: undefined }] };
  const without = renderToString(createElement(StaticRouter, { location: noOptional.products[0].path }, createElement(ReferenceCatalogRoutes, { input: { snapshots: [noOptional] } })));
  expect(without).toContain("Supplied description"); expect(without).not.toContain("/media/unit-a.svg");
});
