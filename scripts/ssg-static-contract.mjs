import { loadSiteRouteManifest } from "./site-routes.mjs";

export const SITE_ORIGIN = loadSiteRouteManifest().siteOrigin;
export const SSG_MANIFEST_FILE = "ssg-manifest.json";
export const SPA_FALLBACK_FILE = "spa-fallback.html";
export const HOMEPAGE_CRITICAL_CSS_MAX_BYTES = 20 * 1024;

const HOMEPAGE_PATHS = new Set(["/", "/en"]);

const SCHEMA_TYPES_BY_KIND = {
  website: new Set(["WebSite"]),
  product: new Set(["Product"]),
  contact: new Set(["ContactPage"]),
  service: new Set(["Service"]),
  breadcrumb: new Set(["BreadcrumbList"]),
  faq: new Set(["FAQPage"]),
};

function schemaTypesForKind(kind, routeManifest) {
  if (kind === "organization") {
    return new Set([routeManifest?.siteLifecycle === "storefront" ? "OnlineStore" : "Organization"]);
  }
  return SCHEMA_TYPES_BY_KIND[kind];
}

function expectedEntityId(kind, route) {
  const canonical = canonicalForRoute(route).replace(/\/$/, "");
  if (kind === "organization") return `${SITE_ORIGIN}/#organization`;
  if (kind === "website") return `${SITE_ORIGIN}/#website`;
  if (kind === "product") return `${canonical}#product`;
  if (kind === "contact") return `${canonical}#webpage`;
  if (kind === "service") return `${canonical}#service`;
  if (kind === "breadcrumb") return `${canonical}#breadcrumb`;
  if (kind === "faq") return `${canonical}#faq`;
  return null;
}

function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
}

function hasAttribute(tag, name) {
  return new RegExp(`(?:\\s|<)${name}(?:\\s*=|\\s|/?>)`, "i").test(tag);
}

export function validateHomepageStyleDelivery(markup, route) {
  const criticalStyles = [...markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .filter((match) => hasAttribute(match[0].slice(0, match[0].indexOf(">") + 1), "data-critical-css"));
  const appStylesheets = (markup.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => hasAttribute(tag, "data-app-stylesheet"));
  const markupWithoutNoscript = markup.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  const blockingStylesheets = (markupWithoutNoscript.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => attributeValue(tag, "rel").toLowerCase() === "stylesheet");

  if (!HOMEPAGE_PATHS.has(route.path)) {
    if (criticalStyles.length > 0 || appStylesheets.length > 0) {
      throw new Error(`Critical CSS delivery leaked onto non-homepage route ${route.path}`);
    }
    if (blockingStylesheets.length !== 1 || !attributeValue(blockingStylesheets[0] ?? "", "href")) {
      throw new Error(`Non-homepage route ${route.path} must retain exactly one blocking stylesheet`);
    }
    return null;
  }

  const problems = [];
  if (criticalStyles.length !== 1) problems.push(`expected one Critical CSS block, found ${criticalStyles.length}`);
  if (appStylesheets.length !== 1) problems.push(`expected one deferred app stylesheet, found ${appStylesheets.length}`);

  const criticalCss = criticalStyles[0]?.[1] ?? "";
  const criticalCssBytes = Buffer.byteLength(criticalCss);
  if (criticalCssBytes === 0) problems.push("Critical CSS block is empty");
  if (criticalCssBytes > HOMEPAGE_CRITICAL_CSS_MAX_BYTES) {
    problems.push(`Critical CSS is ${criticalCssBytes} bytes; maximum is ${HOMEPAGE_CRITICAL_CSS_MAX_BYTES}`);
  }

  const stylesheetTag = appStylesheets[0] ?? "";
  const stylesheetHref = attributeValue(stylesheetTag, "href");
  if (attributeValue(stylesheetTag, "rel").toLowerCase() !== "preload") problems.push("app stylesheet is not a preload");
  if (attributeValue(stylesheetTag, "as").toLowerCase() !== "style") problems.push('app stylesheet preload is missing as="style"');
  if (!stylesheetHref) problems.push("app stylesheet preload has no href");
  if (hasAttribute(stylesheetTag, "onload")) problems.push("app stylesheet preload uses an inline onload handler");

  const noscriptStylesheets = [...markup.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)]
    .flatMap((match) => match[1].match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => attributeValue(tag, "rel").toLowerCase() === "stylesheet")
    .filter((tag) => attributeValue(tag, "href") === stylesheetHref);
  if (noscriptStylesheets.length !== 1) {
    problems.push(`expected one matching noscript stylesheet, found ${noscriptStylesheets.length}`);
  }
  if (blockingStylesheets.length !== 0) {
    problems.push(`expected no blocking stylesheet outside noscript, found ${blockingStylesheets.length}`);
  }

  if (problems.length > 0) {
    throw new Error(`Homepage style delivery invalid for ${route.path}: ${problems.join("; ")}`);
  }
  return { criticalCssBytes, stylesheetHref };
}

export function canonicalForRoute(route) {
  return `${SITE_ORIGIN}${route.canonicalPath === "/" ? "/" : route.canonicalPath}`;
}

function jsonLdScripts(markup) {
  return [...markup.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
}

function normalizedVisibleText(markup) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (_, name) => namedEntities[name.toLowerCase()])
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function contentSentinelProblem(markup, route) {
  if (typeof route.contentSentinel !== "string"
    || !route.contentSentinel.trim()
    || route.contentSentinel === "main h1") {
    return "route is missing a route-specific content sentinel";
  }
  const main = markup.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) return "missing main content for route sentinel";
  if (!normalizedVisibleText(main).includes(normalizedVisibleText(route.contentSentinel))) {
    return `route content sentinel not found: ${route.contentSentinel}`;
  }
  return null;
}

function structuredDataProblems(markup, route, routeManifest) {
  const scripts = jsonLdScripts(markup);
  const expectedKinds = route.structuredData ?? [];
  if (expectedKinds.length === 0) {
    return scripts.length === 0 ? [] : [`expected no JSON-LD graph, found ${scripts.length}`];
  }
  if (scripts.length !== 1) return [`expected one JSON-LD graph, found ${scripts.length}`];

  let payload;
  try {
    payload = JSON.parse(scripts[0][1]);
  } catch {
    return ["JSON-LD graph is not valid JSON"];
  }
  if (payload?.["@context"] !== "https://schema.org" || !Array.isArray(payload?.["@graph"])) {
    return ["JSON-LD must be one schema.org @graph"];
  }
  const graphIds = new Set();
  const graphProblems = payload["@graph"].flatMap((node, index) => {
    const id = node?.["@id"];
    if (typeof id !== "string" || !id.startsWith(`${SITE_ORIGIN}/`)) {
      return [`JSON-LD top-level node ${index} has missing or foreign @id ${String(id ?? "<missing>")}`];
    }
    try {
      if (new URL(id).origin !== SITE_ORIGIN) {
        return [`JSON-LD top-level node ${index} has foreign @id ${id}`];
      }
    } catch {
      return [`JSON-LD top-level node ${index} has invalid @id ${id}`];
    }
    if (graphIds.has(id)) return [`JSON-LD graph has duplicate top-level @id ${id}`];
    graphIds.add(id);
    return [];
  });
  const expectedProblems = expectedKinds.flatMap((kind) => {
    const accepted = schemaTypesForKind(kind, routeManifest);
    if (!accepted) return [`unknown structured data kind ${kind}`];
    const node = payload["@graph"].find((candidate) => {
      const value = candidate?.["@type"];
      const types = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      return types.some((type) => accepted.has(type));
    });
    if (!node) return [`JSON-LD graph is missing ${kind}`];
    const expectedId = expectedEntityId(kind, route);
    return expectedId && node["@id"] !== expectedId
      ? [`JSON-LD ${kind} @id ${String(node["@id"] ?? "<missing>")} does not match ${expectedId}`]
      : [];
  });
  return [...graphProblems, ...expectedProblems];
}

function hreflangProblems(markup, route, routeManifest) {
  if (!routeManifest) return [];
  const alternates = (markup.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => attributeValue(tag, "rel").toLowerCase() === "alternate");
  if (!route.alternateRouteId) {
    return alternates.length === 0 ? [] : [`route without a translation emitted ${alternates.length} hreflang links`];
  }
  const alternate = routeManifest.routes.find((candidate) => candidate.id === route.alternateRouteId);
  if (!alternate) return [`alternate route ${route.alternateRouteId} is missing`];
  const polish = route.locale === "pl" ? route : alternate;
  const expected = new Map([
    [route.locale, canonicalForRoute(route)],
    [alternate.locale, canonicalForRoute(alternate)],
    ["x-default", canonicalForRoute(polish)],
  ]);
  const actual = new Map(alternates.map((tag) => [
    attributeValue(tag, "hreflang").toLowerCase(),
    attributeValue(tag, "href"),
  ]));
  const problems = alternates.length === expected.size
    ? []
    : [`expected ${expected.size} hreflang links, found ${alternates.length}`];
  for (const [language, href] of expected) {
    if (actual.get(language) !== href) problems.push(`hreflang ${language} does not match ${href}`);
  }
  return problems;
}

function assertAttributeString(value, label) {
  if (typeof value !== "string" || /[<>]/.test(value)) {
    throw new Error(`renderRoute ${label} must be a safe attribute string`);
  }
}

export function assertRenderResult(result, route, routeManifest) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`renderRoute(${route.path}) must return the SSG result object`);
  }
  if (result.statusCode !== 200) {
    throw new Error(`renderRoute(${route.path}) returned status ${String(result.statusCode)}, expected 200`);
  }
  if (result.locale !== route.locale || !["pl", "en"].includes(result.locale)) {
    throw new Error(`renderRoute(${route.path}) locale ${String(result.locale)} does not match ${route.locale}`);
  }
  if (typeof result.appHtml !== "string" || !result.appHtml.trim()) {
    throw new Error(`renderRoute(${route.path}) returned empty appHtml`);
  }
  if (!/<main(?:\s|>)/i.test(result.appHtml) || !/<h1(?:\s|>)/i.test(result.appHtml)) {
    throw new Error(`renderRoute(${route.path}) appHtml is missing the main/h1 content sentinel`);
  }
  const sentinelProblem = contentSentinelProblem(result.appHtml, route);
  if (sentinelProblem) throw new Error(`renderRoute(${route.path}) ${sentinelProblem}`);
  if (!result.head || typeof result.head !== "object" || Array.isArray(result.head)) {
    throw new Error(`renderRoute(${route.path}) returned an invalid head object`);
  }
  for (const field of ["title", "meta", "link"]) {
    if (typeof result.head[field] !== "string" || !result.head[field].trim()) {
      throw new Error(`renderRoute(${route.path}) returned empty head.${field}`);
    }
    if (/<\/?(?:html|head|body)(?:\s|>)/i.test(result.head[field])) {
      throw new Error(`renderRoute(${route.path}) head.${field} escapes the document head`);
    }
  }
  if (typeof result.head.script !== "string") {
    throw new Error(`renderRoute(${route.path}) returned invalid head.script`);
  }
  if (/<\/?(?:html|head|body)(?:\s|>)/i.test(result.head.script)) {
    throw new Error(`renderRoute(${route.path}) head.script escapes the document head`);
  }
  assertAttributeString(result.htmlAttributes, "htmlAttributes");
  assertAttributeString(result.bodyAttributes, "bodyAttributes");
  const htmlLang = attributeValue(`<html ${result.htmlAttributes}>`, "lang");
  if (htmlLang !== route.htmlLang || htmlLang !== result.locale) {
    throw new Error(
      `renderRoute(${route.path}) html lang ${htmlLang || "<missing>"} does not match ${route.htmlLang}`,
    );
  }

  const linkTags = result.head.link.match(/<link\b[^>]*>/gi) ?? [];
  const canonicals = linkTags.filter((tag) => attributeValue(tag, "rel") === "canonical");
  if (canonicals.length !== 1) {
    throw new Error(`renderRoute(${route.path}) expected one head canonical, found ${canonicals.length}`);
  }
  const canonical = attributeValue(canonicals[0], "href");
  const expectedCanonical = canonicalForRoute(route);
  if (canonical !== expectedCanonical) {
    throw new Error(
      `renderRoute(${route.path}) canonical ${canonical || "<missing>"} does not match ${expectedCanonical}`,
    );
  }
  const metadataProblems = [
    ...structuredDataProblems(result.head.script, route, routeManifest),
    ...hreflangProblems(result.head.link, route, routeManifest),
  ];
  if (metadataProblems.length > 0) {
    throw new Error(`renderRoute(${route.path}) metadata invalid: ${metadataProblems.join("; ")}`);
  }
  return result;
}

function stripTemplateSeo(head) {
  let cleaned = head.replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, "");
  cleaned = cleaned.replace(/<meta\b[^>]*>\s*/gi, (tag) => {
    const name = attributeValue(tag, "name").toLowerCase();
    const property = attributeValue(tag, "property").toLowerCase();
    return name === "description" || name === "twitter:card" || name === "robots" || property.startsWith("og:")
      ? ""
      : tag;
  });
  cleaned = cleaned.replace(/<link\b[^>]*>\s*/gi, (tag) => {
    const rel = attributeValue(tag, "rel").toLowerCase();
    return rel === "canonical" || rel === "alternate" ? "" : tag;
  });
  return cleaned.replace(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/gi,
    "",
  );
}

export function composeSsgDocument(template, rawResult, route, routeManifest) {
  const result = assertRenderResult(rawResult, route, routeManifest);
  const headOpen = template.match(/<head\b[^>]*>/i);
  const headCloseIndex = template.search(/<\/head>/i);
  if (!headOpen || headOpen.index === undefined || headCloseIndex < 0) {
    throw new Error("Client template is missing a complete <head>");
  }
  const beforeHead = template.slice(0, headOpen.index + headOpen[0].length);
  const existingHead = template.slice(headOpen.index + headOpen[0].length, headCloseIndex);
  const afterHead = template.slice(headCloseIndex);
  const renderedHead = [result.head.title, result.head.meta, result.head.link, result.head.script].join("\n");
  let html = `${beforeHead}${stripTemplateSeo(existingHead).trimEnd()}\n${renderedHead}\n${afterHead}`;

  html = html.replace(/<html\b[^>]*>/i, `<html ${result.htmlAttributes.trim()}>`);
  html = html.replace(
    /<body\b[^>]*>/i,
    result.bodyAttributes.trim() ? `<body ${result.bodyAttributes.trim()}>` : "<body>",
  );
  const rootPattern = /<div\s+id=["']root["'][^>]*>\s*<\/div>/i;
  if (!rootPattern.test(html)) throw new Error("Client template is missing an empty #root mount point");
  return html.replace(rootPattern, `<div id="root" data-render-mode="ssg">${result.appHtml}</div>`);
}

export function composeSpaFallback(template) {
  let html = template.replace(/<link\b[^>]*>\s*/gi, (tag) =>
    attributeValue(tag, "rel").toLowerCase() === "canonical" ? "" : tag,
  );
  html = html.replace(/<meta\b[^>]*>\s*/gi, (tag) =>
    attributeValue(tag, "name").toLowerCase() === "robots" ? "" : tag,
  );
  html = html.replace(
    /<\/head>/i,
    '    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />\n  </head>',
  );
  return html.replace(/\sdata-render-mode=["'][^"']*["']/i, "");
}

export function validateSsgDocument(html, route, routeManifest) {
  const problems = [];
  if (html.includes("\0")) problems.push("contains NUL bytes");
  if (html.includes("\uFFFD")) problems.push("contains Unicode replacement characters");
  if (!/<div\s+id=["']root["'][^>]*data-render-mode=["']ssg["'][^>]*>[\s\S]*?<main(?:\s|>)/i.test(html)) {
    problems.push("missing SSG root/main marker");
  }
  if (!/<h1(?:\s|>)/i.test(html)) problems.push("missing h1");
  const sentinelProblem = contentSentinelProblem(html, route);
  if (sentinelProblem) problems.push(sentinelProblem);
  const hiddenContent = (html.match(/<[^>]+\bstyle=["'][^"']*\bopacity\s*:\s*0(?:[;"'])[^>]*>/gi) ?? [])
    .filter((tag) => attributeValue(tag, "aria-hidden").toLowerCase() !== "true");
  if (hiddenContent.length > 0) {
    problems.push(`contains ${hiddenContent.length} zero-opacity content nodes without aria-hidden`);
  }
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  if (attributeValue(htmlTag, "lang") !== route.htmlLang) problems.push("html lang mismatch");
  if (/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) {
    problems.push("public SSG document is noindex");
  }
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const canonicals = links.filter((tag) => attributeValue(tag, "rel").toLowerCase() === "canonical");
  const canonical = canonicals.length === 1 ? attributeValue(canonicals[0], "href") : "";
  if (canonicals.length !== 1) problems.push(`expected one canonical, found ${canonicals.length}`);
  if (canonical !== canonicalForRoute(route)) problems.push(`canonical mismatch: ${canonical || "<missing>"}`);
  problems.push(...structuredDataProblems(html, route, routeManifest));
  problems.push(...hreflangProblems(html, route, routeManifest));
  if (problems.length > 0) throw new Error(`SSG validation failed for ${route.path}: ${problems.join("; ")}`);
  return true;
}
