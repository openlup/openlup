import type { OrganizationFacts } from "../contracts/contactLegal.js";

export type JsonLdNode = Record<string, unknown> & { "@context"?: string; "@id"?: string };

export function jsonLdGraph(...nodes: JsonLdNode[]) {
  const seen = new Set<string>();
  const graph = nodes.flatMap(({ "@context": _context, ...node }) => {
    if (node["@id"] && seen.has(node["@id"] as string)) return [];
    if (node["@id"]) seen.add(node["@id"] as string);
    return [node];
  });
  return { "@context": "https://schema.org", "@graph": graph };
}

export function entityIds(origin: string) {
  const site = origin.replace(/\/$/, "");
  return {
    organization: `${site}/#organization`,
    website: `${site}/#website`,
    brand: `${site}/#brand`,
  };
}

export function organizationLd(origin: string, type: "Organization" | "OnlineStore", facts: OrganizationFacts) {
  return {
    "@context": "https://schema.org",
    "@id": entityIds(origin).organization,
    "@type": type,
    name: facts.name,
    legalName: facts.legalName,
    url: facts.url,
    logo: {
      "@type": "ImageObject",
      url: facts.logo.url,
      contentUrl: facts.logo.contentUrl,
      width: facts.logo.width,
      height: facts.logo.height,
    },
    email: facts.email,
    vatID: facts.vatID,
    taxID: facts.taxID,
    areaServed: facts.areaServed,
    sameAs: facts.sameAs,
    contactPoint: {
      "@type": "ContactPoint",
      email: facts.contactPoint.email,
      contactType: facts.contactPoint.contactType,
      availableLanguage: facts.contactPoint.availableLanguage,
    },
    address: {
      "@type": "PostalAddress",
      streetAddress: facts.address.streetAddress,
      addressLocality: facts.address.addressLocality,
      postalCode: facts.address.postalCode,
      addressRegion: facts.address.addressRegion,
      addressCountry: facts.address.addressCountry,
    },
  };
}

export function brandLd(origin: string, name: string, url: string) {
  return { "@context": "https://schema.org", "@id": entityIds(origin).brand, "@type": "Brand", name, url };
}

export function websiteLd(origin: string, name: string, url: string, inLanguage: string[]) {
  return {
    "@context": "https://schema.org",
    "@id": entityIds(origin).website,
    "@type": "WebSite",
    name,
    url,
    inLanguage,
    publisher: { "@id": entityIds(origin).organization },
  };
}

export function contactPageLd(origin: string, pageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@id": `${pageUrl.replace(/\/$/, "")}#webpage`,
    "@type": "ContactPage",
    url: pageUrl,
    publisher: { "@id": entityIds(origin).organization },
    mainEntity: { "@id": entityIds(origin).organization },
  };
}

export interface NetContent { unscaled: number; scale: number; unit: string }

export function schemaWeight(netContent: NetContent) {
  const { unscaled, scale, unit } = netContent;
  const unitCode = unit === "GRAM" || unit === "G" ? "GRM" : unit;
  return { "@type": "QuantitativeValue", value: unscaled / 10 ** scale, unitCode };
}

export interface ProductFacts {
  url: string;
  name: string;
  inLanguage: string;
  brandName: string;
  category?: string;
  images: string[];
  sku?: string;
  gtin13?: string;
  netContent?: NetContent;
}

export function productLd(origin: string, product: ProductFacts) {
  return {
    "@context": "https://schema.org",
    "@id": `${product.url.replace(/\/$/, "")}#product`,
    "@type": "Product",
    name: product.name,
    inLanguage: product.inLanguage,
    brand: { "@id": entityIds(origin).brand, "@type": "Brand", name: product.brandName },
    manufacturer: { "@id": entityIds(origin).organization },
    ...(product.category !== undefined ? { category: product.category } : {}),
    image: product.images,
    ...(product.sku !== undefined ? { sku: product.sku } : {}),
    ...(product.gtin13 !== undefined ? { gtin13: product.gtin13 } : {}),
    ...(product.netContent ? { weight: schemaWeight(product.netContent) } : {}),
    url: product.url,
  };
}

const pageEntityId = (pageUrl: string, fragment: string) => `${pageUrl.replace(/\/$/, "")}#${fragment}`;

export function faqPageLd(faqs: { question: string; answer: string }[], pageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@id": pageEntityId(pageUrl, "faq"),
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };
}

export function breadcrumbLd(items: { name: string; url?: string }[], pageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@id": pageEntityId(pageUrl, "breadcrumb"),
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}
