import { jsonLdGraph, type JsonLdNode } from "./jsonLd.js";
import { serializeJsonLd } from "./serializeJsonLd.js";
import { canonicalUrlForRoute, hreflangLinksForRoute, type SiteRoute } from "./urls.js";

export type HeadTag =
  | { kind: "meta"; name: string; content: string }
  | { kind: "meta"; property: string; content: string }
  | { kind: "link"; rel: "canonical" | "alternate"; href: string; hrefLang?: string };

export interface HeadFacts {
  origin: string;
  route: SiteRoute;
  routes: readonly SiteRoute[];
  xDefaultLocale: string;
  htmlLang: string;
  title: string;
  description: string;
  siteName: string;
  ogImage: string;
  ogImageWidth: number;
  ogImageHeight: number;
  ogLocale: string;
  alternateOgLocale?: string;
  twitterImage: string;
  twitterHandle: string;
  noindex?: boolean;
  jsonLd?: JsonLdNode | JsonLdNode[];
}

export function buildHeadDescriptor(facts: HeadFacts): { htmlLang: string; title: string; tags: HeadTag[]; jsonLd: string | null } {
  const canonicalUrl = canonicalUrlForRoute(facts.origin, facts.route);
  const nodes = facts.jsonLd ? (Array.isArray(facts.jsonLd) ? facts.jsonLd : [facts.jsonLd]) : [];
  const tags: HeadTag[] = [
    { kind: "meta", name: "description", content: facts.description },
    { kind: "link", rel: "canonical", href: canonicalUrl },
    ...(facts.noindex ? [{ kind: "meta" as const, name: "robots", content: "noindex, nofollow" }] : []),
    { kind: "meta", property: "og:title", content: facts.title },
    { kind: "meta", property: "og:description", content: facts.description },
    { kind: "meta", property: "og:image", content: facts.ogImage },
    { kind: "meta", property: "og:image:width", content: String(facts.ogImageWidth) },
    { kind: "meta", property: "og:image:height", content: String(facts.ogImageHeight) },
    { kind: "meta", property: "og:type", content: "website" },
    { kind: "meta", property: "og:site_name", content: facts.siteName },
    { kind: "meta", property: "og:url", content: canonicalUrl },
    { kind: "meta", property: "og:locale", content: facts.ogLocale },
    ...(facts.alternateOgLocale ? [{ kind: "meta" as const, property: "og:locale:alternate", content: facts.alternateOgLocale }] : []),
    { kind: "meta", name: "twitter:card", content: "summary_large_image" },
    { kind: "meta", name: "twitter:site", content: facts.twitterHandle },
    { kind: "meta", name: "twitter:title", content: facts.title },
    { kind: "meta", name: "twitter:description", content: facts.description },
    { kind: "meta", name: "twitter:image", content: facts.twitterImage },
    ...hreflangLinksForRoute(facts.origin, facts.route, facts.routes, facts.xDefaultLocale).map((link) => ({
      kind: "link" as const, rel: "alternate" as const, hrefLang: link.hrefLang, href: link.href,
    })),
  ];
  return {
    htmlLang: facts.htmlLang,
    title: facts.title,
    tags,
    jsonLd: nodes.length > 0 ? serializeJsonLd(jsonLdGraph(...nodes)) : null,
  };
}
