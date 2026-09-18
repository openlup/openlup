import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const LOCALES = new Set(["pl", "en"]);
const DELIVERIES = new Set(["ssg", "csr"]);
const LIFECYCLES = new Set(["prelaunch", "storefront", "public-reference"]);
const PUBLIC_REFERENCE_PATHS = ["/", "/items/field-notes"];

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid site route ${label}`);
  }
}

function assertPathList(paths, label, allowEmpty = false) {
  if (!Array.isArray(paths) || (!allowEmpty && !paths.length)
    || new Set(paths).size !== paths.length
    || paths.some((path) => typeof path !== "string" || !path.startsWith("/") || path === "/"
      || path.endsWith("/") || /[:*]/u.test(path))) {
    throw new Error(`Site route manifest ${label} must be unique non-root canonical paths`);
  }
}

function assertRoute(route, ids, paths, canonicalPaths, contentSentinels) {
  assertString(route.id, "id");
  assertString(route.path, "path");
  assertString(route.canonicalPath, "canonicalPath");
  assertString(route.seoKey, "seoKey");
  assertString(route.contentSentinel, "contentSentinel");
  const normalizedSentinel = route.contentSentinel.trim().toLocaleLowerCase();
  if (normalizedSentinel === "main h1" || contentSentinels.has(normalizedSentinel)) {
    throw new Error(`Route ${route.id} must have a unique route-specific content sentinel`);
  }
  contentSentinels.add(normalizedSentinel);
  if (!route.path.startsWith("/") || !route.canonicalPath.startsWith("/")) {
    throw new Error(`Route ${route.id} paths must be root-relative`);
  }
  if ((route.path.length > 1 && route.path.endsWith("/")) || route.canonicalPath !== route.path) {
    throw new Error(`Route ${route.id} must own one normalized canonical path`);
  }
  if (!LOCALES.has(route.locale) || !DELIVERIES.has(route.delivery)) {
    throw new Error(`Route ${route.id} has an unsupported locale or delivery`);
  }
  if (typeof route.indexable !== "boolean" || typeof route.sitemap !== "boolean") {
    throw new Error(`Route ${route.id} is missing crawl flags`);
  }
  if (!Array.isArray(route.structuredData) || !Array.isArray(route.seoPath)) {
    throw new Error(`Route ${route.id} is missing SEO metadata`);
  }
  if (route.lcpAssetWide !== undefined) {
    assertString(route.lcpAsset, `${route.id} lcpAsset`);
    assertString(route.lcpAssetWide, `${route.id} lcpAssetWide`);
  }
  if (route.id !== `${route.locale}:${route.path}` || route.seoKey !== route.seoPath.join(".")) {
    throw new Error(`Route ${route.id} has derived metadata drift`);
  }
  if (route.htmlLang !== route.locale || (route.sitemap && !route.indexable)) {
    throw new Error(`Route ${route.id} has inconsistent language or crawl flags`);
  }
  if (ids.has(route.id) || paths.has(route.path) || canonicalPaths.has(route.canonicalPath)) {
    throw new Error(`Site route ids and paths must be unique: ${route.id}`);
  }
  ids.add(route.id);
  paths.add(route.path);
  canonicalPaths.add(route.canonicalPath);
}

export function validateSiteRouteManifest(manifest) {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported site route schema");
  assertString(manifest.siteOrigin, "siteOrigin");
  if (!LIFECYCLES.has(manifest.siteLifecycle)) throw new Error("Invalid site lifecycle");
  if (!Array.isArray(manifest.productionHosts) || !manifest.productionHosts.length) {
    throw new Error("Site route manifest needs production hosts");
  }
  if (!Array.isArray(manifest.routes) || !Array.isArray(manifest.legacyRedirects)) {
    throw new Error("Invalid site route manifest shape");
  }
  if (!manifest.csrFallback || typeof manifest.csrFallback !== "object") {
    throw new Error("Site route manifest needs a CSR fallback policy");
  }
  if (!Array.isArray(manifest.crawlPolicy?.privatePrefixes)) {
    throw new Error("Site route manifest needs a private crawl policy");
  }
  const origin = new URL(manifest.siteOrigin);
  if (origin.protocol !== "https:" || !manifest.productionHosts.includes(origin.hostname)) {
    throw new Error("Site origin must be a canonical HTTPS production host");
  }
  const privatePrefixes = manifest.crawlPolicy.privatePrefixes;
  if (new Set(privatePrefixes).size !== privatePrefixes.length
    || privatePrefixes.some((prefix) => !prefix.startsWith("/"))) {
    throw new Error("Private crawl prefixes must be unique root-relative paths");
  }
  const publicReference = manifest.siteLifecycle === "public-reference";
  assertPathList(manifest.csrFallback.exactPaths, "CSR fallback exact paths", publicReference);
  assertPathList(manifest.csrFallback.routeFamilies, "CSR fallback route families", publicReference);
  const csrExactPaths = manifest.csrFallback.exactPaths;
  const csrRouteFamilies = manifest.csrFallback.routeFamilies;
  const csrPaths = [...csrExactPaths, ...csrRouteFamilies];
  const insideCsrFamily = (path) => csrRouteFamilies.some((family) =>
    path === family || path.startsWith(`${family}/`));
  const nestedCsrFamily = csrRouteFamilies.some((family, index) =>
    csrRouteFamilies.some((other, otherIndex) => index !== otherIndex && family.startsWith(`${other}/`)));
  if (new Set(csrPaths).size !== csrPaths.length
    || csrExactPaths.some(insideCsrFamily)
    || nestedCsrFamily) {
    throw new Error("CSR fallback exact paths and route families must not overlap");
  }

  const ids = new Set();
  const paths = new Set();
  const canonicalPaths = new Set();
  const contentSentinels = new Set();
  for (const route of manifest.routes) {
    assertRoute(route, ids, paths, canonicalPaths, contentSentinels);
  }
  if ([...paths].some((path) => csrExactPaths.includes(path) || insideCsrFamily(path))) {
    throw new Error("CSR fallback paths must not overlap canonical routes");
  }
  const redirectSources = new Set();
  for (const redirect of manifest.legacyRedirects) {
    assertString(redirect.source, "redirect source");
    assertString(redirect.destination, "redirect destination");
    if (!redirect.source.startsWith("/") || !redirect.destination.startsWith("/")) {
      throw new Error(`Redirect ${redirect.source} must use root-relative paths`);
    }
    if (redirect.source === redirect.destination || redirectSources.has(redirect.source)
      || paths.has(redirect.source)) {
      throw new Error(`Redirect source is duplicated, self-referential or canonical: ${redirect.source}`);
    }
    if (redirect.permanent !== true) {
      throw new Error(`Public legacy redirect must be permanent: ${redirect.source}`);
    }
    redirectSources.add(redirect.source);
  }
  if ([...redirectSources].some((source) => csrExactPaths.includes(source) || insideCsrFamily(source))) {
    throw new Error("CSR fallback paths must not overlap legacy redirect sources");
  }
  for (const route of manifest.routes) {
    if (!route.alternateRouteId) continue;
    const alternate = manifest.routes.find((candidate) => candidate.id === route.alternateRouteId);
    if (!alternate || alternate.alternateRouteId !== route.id
      || alternate.locale === route.locale || alternate.seoKey !== route.seoKey) {
      throw new Error(`Route ${route.id} has a non-reciprocal alternate`);
    }
  }
  if (publicReference) {
    if (manifest.siteOrigin !== "https://reference.invalid"
      || manifest.productionHosts.length !== 1 || manifest.productionHosts[0] !== "reference.invalid") {
      throw new Error("Public reference manifest must use the neutral reference origin");
    }
    if (manifest.legacyRedirects.length !== 0 || csrExactPaths.length !== 0 || csrRouteFamilies.length !== 0
      || privatePrefixes.length !== 0) {
      throw new Error("Public reference manifest must not declare redirects, CSR fallback, or private crawl paths");
    }
    if (manifest.routes.length !== PUBLIC_REFERENCE_PATHS.length
      || PUBLIC_REFERENCE_PATHS.some((path) => !paths.has(path))) {
      throw new Error(`Expected exactly the declared public reference routes: ${PUBLIC_REFERENCE_PATHS.join(", ")}`);
    }
    for (const route of manifest.routes) {
      if (route.locale !== "en" || route.delivery !== "ssg" || route.indexable !== false || route.sitemap !== false
        || route.alternateRouteId !== undefined || route.structuredData.length !== 0) {
        throw new Error(`Public reference route ${route.id} must remain a noindex English SSG document`);
      }
    }
  } else {
    // Tripwire na przypadkowe zgubienie tras: 29 tras bazowych + hub /rasy
    // + 49 stron ras (docs/SEO_CONTENT_PLAN.md §4.1). Podnoś świadomie razem
    // z rejestrem, nigdy "żeby przeszło".
    if (manifest.routes.length !== 79) {
      throw new Error(`Expected 79 public routes, found ${manifest.routes.length}`);
    }
    if (manifest.routes.filter((route) => route.path === "/" && route.locale === "pl").length !== 1) {
      throw new Error("Site route manifest must contain exactly one Polish root");
    }
  }
  return manifest;
}

export function loadSiteRouteManifest(root = DEFAULT_ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, "config", "site-routes.json"), "utf8"));
  return validateSiteRouteManifest(manifest);
}

function main(argv) {
  const manifest = loadSiteRouteManifest();
  if (argv.includes("--public-reference") && manifest.siteLifecycle !== "public-reference") {
    throw new Error("Public reference build requires the projected public reference route manifest");
  }
  process.stdout.write(`site routes hold: ${manifest.siteLifecycle}, ${manifest.routes.length} route(s)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
