import { expect, expectTypeOf, it } from "vitest";
import {
  absoluteSiteUrl, brandLd, breadcrumbLd, buildHeadDescriptor, canonicalUrlForRoute,
  contactContent, contactPageLd, entityIds, faqPageLd, hreflangLinksForRoute, jsonLdGraph,
  legalDocumentContent, normalizeSitePath, organizationLd, productLd, schemaWeight, serializeJsonLd,
  websiteLd,
  type HeadFacts, type SiteRoute,
} from "../../../src/marketing/index.js";
import type { ContactContent, LegalDocumentContent, PrivacyProcessorDisclosure } from "../../../src/marketing/contracts/index.js";

const origin = "https://shop.example";
const organization = `${origin}/#organization`;
const brand = `${origin}/#brand`;
const facts = {
  name: "Example Store", legalName: "Example Company", url: origin,
  logo: { url: `${origin}/logo.png`, contentUrl: `${origin}/logo.png`, width: 160, height: 60 },
  email: "contact@example.invalid", vatID: "VAT-1", taxID: "TAX-1", areaServed: "Region-A",
  sameAs: [`${origin}/social`],
  contactPoint: { email: "help@example.invalid", contactType: "support", availableLanguage: ["Language A"] },
  address: { streetAddress: "Example Lane 1", addressLocality: "Example Town", postalCode: "00000", addressRegion: "Region-A", addressCountry: "Territory-A" },
};

it("escapes hostile JSON-LD while preserving its parsed value", () => {
  const value = { name: "</script><script>probe</script>\u2028\u2029" };
  for (const serialized of [serializeJsonLd(value), buildHeadDescriptor({
    ...headFacts, jsonLd: value,
  }).jsonLd!]) {
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("\u2028");
    expect(serialized).not.toContain("\u2029");
    expect(serialized).toContain("\\u003c/script>");
    expect(serialized).toContain("\\u2028\\u2029");
  }
  expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  expect(JSON.parse(buildHeadDescriptor({ ...headFacts, jsonLd: value }).jsonLd!)).toEqual({
    "@context": "https://schema.org", "@graph": [value],
  });
});

it("strips node contexts and keeps the first occurrence of each id", () => {
  expect(jsonLdGraph(
    { "@context": "custom", "@id": "one", name: "first" },
    { "@context": "custom", "@id": "one", name: "later" },
    { "@context": "custom", name: "unidentified" },
  )).toEqual({ "@context": "https://schema.org", "@graph": [
    { "@id": "one", name: "first" }, { name: "unidentified" },
  ] });
});

it("builds both organization types with supplied identity", () => {
  for (const type of ["Organization", "OnlineStore"] as const) {
  expect(organizationLd(`${origin}/`, type, facts)).toEqual({
    "@context": "https://schema.org", "@id": organization, "@type": type,
    name: facts.name, legalName: facts.legalName, url: facts.url,
    logo: { "@type": "ImageObject", ...facts.logo }, email: facts.email,
    vatID: facts.vatID, taxID: facts.taxID, areaServed: facts.areaServed, sameAs: facts.sameAs,
    contactPoint: { "@type": "ContactPoint", ...facts.contactPoint },
    address: { "@type": "PostalAddress", ...facts.address },
  });
  }
});

it("selects only declared organization fields from caller facts", () => {
  const extended = {
    ...facts,
    logo: { ...facts.logo, internalAsset: "unused" },
    contactPoint: { ...facts.contactPoint, internalContact: "unused" },
    address: { ...facts.address, internalAddress: "unused" },
  };
  const result = organizationLd(origin, "Organization", extended);
  expect(result.logo).not.toHaveProperty("internalAsset");
  expect(result.contactPoint).not.toHaveProperty("internalContact");
  expect(result.address).not.toHaveProperty("internalAddress");
});

it("builds entity ids, brand, website and contact page from supplied facts", () => {
  expect(entityIds(`${origin}/`)).toEqual({ organization, website: `${origin}/#website`, brand });
  expect(brandLd(origin, "Example Brand", origin)).toEqual({
    "@context": "https://schema.org", "@id": brand, "@type": "Brand", name: "Example Brand", url: origin,
  });
  expect(websiteLd(origin, "Example Site", origin, ["alpha", "beta"])).toEqual({
    "@context": "https://schema.org", "@id": `${origin}/#website`, "@type": "WebSite",
    name: "Example Site", url: origin, inLanguage: ["alpha", "beta"], publisher: { "@id": organization },
  });
  expect(contactPageLd(origin, `${origin}/contact/`)).toEqual({
    "@context": "https://schema.org", "@id": `${origin}/contact#webpage`, "@type": "ContactPage",
    url: `${origin}/contact/`, publisher: { "@id": organization }, mainEntity: { "@id": organization },
  });
});

it("converts gram aliases, other units and scaled net content", () => {
  for (const [input, expected] of [
    [{ unscaled: 1250, scale: 1, unit: "GRAM" }, { "@type": "QuantitativeValue", value: 125, unitCode: "GRM" }],
    [{ unscaled: 3, scale: 0, unit: "G" }, { "@type": "QuantitativeValue", value: 3, unitCode: "GRM" }],
    [{ unscaled: 12345, scale: 3, unit: "LITRE" }, { "@type": "QuantitativeValue", value: 12.345, unitCode: "LITRE" }],
  ] as const) {
    expect(schemaWeight(input)).toEqual(expected);
  }
});

it("builds a product with supplied optional facts and omits absent facts", () => {
  const base = { url: `${origin}/item/`, name: "Example Item", inLanguage: "alpha", brandName: "Example Brand", images: [`${origin}/item.png`] };
  const expected = {
    "@context": "https://schema.org", "@id": `${origin}/item#product`, "@type": "Product",
    name: base.name, inLanguage: "alpha", brand: { "@id": brand, "@type": "Brand", name: base.brandName },
    manufacturer: { "@id": organization }, image: base.images, url: base.url,
  };
  expect(productLd(origin, base)).toEqual(expected);
  expect(productLd(origin, { ...base, category: "" })).toEqual({ ...expected, category: "" });
  expect(productLd(origin, { ...base, category: "Example Category", sku: "SKU-1", gtin13: "1234567890123", netContent: { unscaled: 25, scale: 1, unit: "G" } })).toEqual({
    ...expected, category: "Example Category", sku: "SKU-1", gtin13: "1234567890123",
    weight: { "@type": "QuantitativeValue", value: 2.5, unitCode: "GRM" },
  });
});

it("builds FAQ and breadcrumb nodes with original ordering and optional item URLs", () => {
  expect(faqPageLd([{ question: "First?", answer: "First answer." }], `${origin}/help/`)).toEqual({
    "@context": "https://schema.org", "@id": `${origin}/help#faq`, "@type": "FAQPage",
    mainEntity: [{ "@type": "Question", name: "First?", acceptedAnswer: { "@type": "Answer", text: "First answer." } }],
  });
  expect(breadcrumbLd([{ name: "Start", url: `${origin}/` }, { name: "Help" }], `${origin}/help/`)).toEqual({
    "@context": "https://schema.org", "@id": `${origin}/help#breadcrumb`, "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Start", item: `${origin}/` },
      { "@type": "ListItem", position: 2, name: "Help" },
    ],
  });
});

const primary: SiteRoute = { id: "primary", locale: "beta", canonicalPath: "/help/", alternateRouteId: "alternate" };
const alternate: SiteRoute = { id: "alternate", locale: "alpha", canonicalPath: "/a/help" };
const routes = [primary, alternate];

it("normalizes root, relative and trailing-slash paths", () => {
  for (const [input, expected] of [
    ["", "/"], ["/", "/"], ["help", "/help"], ["/help/", "/help"], ["/help//", "/help/"],
  ]) {
    expect(normalizeSitePath(input)).toBe(expected);
  }
});

it("builds absolute and canonical URLs with root and trailing slash handling", () => {
  expect(absoluteSiteUrl(`${origin}/`, "/")).toBe(`${origin}/`);
  expect(absoluteSiteUrl(`${origin}/`, "help/")).toBe(`${origin}/help`);
  expect(canonicalUrlForRoute(origin, primary)).toBe(`${origin}/help`);
});

it("selects either member as x-default and falls back to the first sorted member", () => {
  for (const [preferred, expected] of [
    ["alpha", `${origin}/a/help`], ["beta", `${origin}/help`], ["missing", `${origin}/a/help`],
  ]) {
    expect(hreflangLinksForRoute(origin, primary, routes, preferred)).toEqual([
      { hrefLang: "alpha", href: `${origin}/a/help` },
      { hrefLang: "beta", href: `${origin}/help` },
      { hrefLang: "x-default", href: expected },
    ]);
  }
});

it("omits hreflang without a linked alternate", () => {
  expect(hreflangLinksForRoute(origin, { ...primary, alternateRouteId: undefined }, routes, "alpha")).toEqual([]);
});

const headFacts = {
  origin, route: primary, routes, xDefaultLocale: "alpha", htmlLang: "beta",
  title: "Example title", description: "Example description", siteName: "Example Site",
  ogImage: `${origin}/social.png`, ogImageWidth: 1200, ogImageHeight: 630,
  ogLocale: "beta-REGION", alternateOgLocale: "alpha-REGION",
  twitterImage: `${origin}/card.png`, twitterHandle: "@example", noindex: true,
};

it("keeps the donor head tag order with all optional tags", () => {
  expect(buildHeadDescriptor(headFacts)).toEqual({
    htmlLang: "beta", title: "Example title", jsonLd: null,
    tags: [
      { kind: "meta", name: "description", content: "Example description" },
      { kind: "link", rel: "canonical", href: `${origin}/help` },
      { kind: "meta", name: "robots", content: "noindex, nofollow" },
      { kind: "meta", property: "og:title", content: "Example title" },
      { kind: "meta", property: "og:description", content: "Example description" },
      { kind: "meta", property: "og:image", content: `${origin}/social.png` },
      { kind: "meta", property: "og:image:width", content: "1200" },
      { kind: "meta", property: "og:image:height", content: "630" },
      { kind: "meta", property: "og:type", content: "website" },
      { kind: "meta", property: "og:site_name", content: "Example Site" },
      { kind: "meta", property: "og:url", content: `${origin}/help` },
      { kind: "meta", property: "og:locale", content: "beta-REGION" },
      { kind: "meta", property: "og:locale:alternate", content: "alpha-REGION" },
      { kind: "meta", name: "twitter:card", content: "summary_large_image" },
      { kind: "meta", name: "twitter:site", content: "@example" },
      { kind: "meta", name: "twitter:title", content: "Example title" },
      { kind: "meta", name: "twitter:description", content: "Example description" },
      { kind: "meta", name: "twitter:image", content: `${origin}/card.png` },
      { kind: "link", rel: "alternate", hrefLang: "alpha", href: `${origin}/a/help` },
      { kind: "link", rel: "alternate", hrefLang: "beta", href: `${origin}/help` },
      { kind: "link", rel: "alternate", hrefLang: "x-default", href: `${origin}/a/help` },
    ],
  });
});

it("keeps required social tags while omitting absent optional head facts", () => {
  const { alternateOgLocale: _alternateLocale, noindex: _noindex, ...required } = headFacts;
  const descriptor = buildHeadDescriptor({
    ...required, ogImageWidth: 0, ogImageHeight: 0, twitterHandle: "",
    route: { ...primary, alternateRouteId: undefined },
  });
  expectTypeOf<Omit<HeadFacts, "ogImageWidth">>().not.toExtend<HeadFacts>();
  expectTypeOf<Omit<HeadFacts, "ogImageHeight">>().not.toExtend<HeadFacts>();
  expectTypeOf<Omit<HeadFacts, "twitterHandle">>().not.toExtend<HeadFacts>();
  expect(descriptor.jsonLd).toBeNull();
  expect(descriptor.tags.map((tag) => tag.kind === "meta" ? ("name" in tag ? tag.name : tag.property) : tag.rel)).toEqual([
    "description", "canonical", "og:title", "og:description", "og:image", "og:image:width", "og:image:height", "og:type",
    "og:site_name", "og:url", "og:locale", "twitter:card", "twitter:site", "twitter:title",
    "twitter:description", "twitter:image",
  ]);
  expect(descriptor.tags).toContainEqual({ kind: "meta", property: "og:image:width", content: "0" });
  expect(descriptor.tags).toContainEqual({ kind: "meta", property: "og:image:height", content: "0" });
  expect(descriptor.tags).toContainEqual({ kind: "meta", name: "twitter:site", content: "" });
});

const contact: ContactContent = {
  organization: facts, supportEmail: "support@example.invalid", addressLine: "Example Lane 1, Example Town",
  registrationIdentifiers: [{ label: "Registry A", value: "A-1" }, { label: "Registry B", value: "B-2" }],
};
const legal: LegalDocumentContent = {
  title: "Example document", intro: "Example introduction.",
  sections: [{ title: "First section", body: "First body." }, { title: "Second section", body: "Second body." }],
};

it("projects the support email and ordered company lines with an optional authority", () => {
  const expected = { supportEmail: contact.supportEmail, companyLines: [
    facts.legalName, contact.addressLine, "Registry A A-1 · Registry B B-2",
  ] };
  expect(contactContent(contact)).toEqual(expected);
  expect(contactContent({ ...contact, registrationAuthority: "Example Authority" })).toEqual({
    ...expected, companyLines: [...expected.companyLines, "Example Authority"],
  });
});

it("preserves empty supplied company lines and identifier values", () => {
  expect(contactContent({
    ...contact, organization: { ...facts, legalName: "" }, addressLine: "",
    registrationIdentifiers: [], registrationAuthority: "",
  })).toEqual({ supportEmail: contact.supportEmail, companyLines: ["", "", "", ""] });
  expect(contactContent({ ...contact, registrationIdentifiers: [{ label: "Registry", value: "" }] }).companyLines[2]).toBe("Registry ");
});

it("projects legal text and ordered sections with optional last-updated text", () => {
  expect(legalDocumentContent({ ...legal, lastUpdated: "Example revision" })).toEqual({
    ...legal, lastUpdated: "Example revision",
  });
  expect(legalDocumentContent(legal)).toEqual(legal);
});

it("preserves empty legal text and section bodies without filtering", () => {
  expect(legalDocumentContent({ title: "", intro: "", sections: [{ title: "", body: "" }], lastUpdated: "" })).toEqual({
    title: "", intro: "", sections: [{ title: "", body: "" }], lastUpdated: "",
  });
});

it("keeps content contracts structural and requires application-supplied fields", () => {
  const processor: PrivacyProcessorDisclosure = { processorName: "Example Processor", purpose: "Example purpose", dataCategories: ["Example data"] };
  expectTypeOf<typeof contact>().toExtend<ContactContent>();
  expectTypeOf<typeof legal>().toExtend<LegalDocumentContent>();
  expectTypeOf<typeof processor>().toExtend<PrivacyProcessorDisclosure>();
  expectTypeOf<Omit<ContactContent, "organization">>().not.toExtend<ContactContent>();
  expectTypeOf<Omit<LegalDocumentContent, "sections">>().not.toExtend<LegalDocumentContent>();
  expectTypeOf<Omit<PrivacyProcessorDisclosure, "dataCategories">>().not.toExtend<PrivacyProcessorDisclosure>();
  // @ts-expect-error contact identity is required
  const missingContact: ContactContent = { supportEmail: "support@example.invalid", addressLine: "", registrationIdentifiers: [] };
  // @ts-expect-error ordered sections are required
  const missingSections: LegalDocumentContent = { title: "Example", intro: "Example introduction." };
  // @ts-expect-error processor data categories are required
  const missingCategories: PrivacyProcessorDisclosure = { processorName: "Example", purpose: "Example purpose" };
  expect([missingContact, missingSections, missingCategories]).toHaveLength(3);
});
