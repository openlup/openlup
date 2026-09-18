import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const FORBIDDEN_PUBLIC_PATTERNS = [
  /hypoallerg|hipoalerg/i,
  /\binsect/i,
  /\bowad/i,
  /anti-inflammatory/i,
  /TNF[- ]?α|TLR receptor/i,
  /\b85%\b/i,
  /\bSpring 2026\b/i,
  /\b8 years\b/i,
  /free-samples/i,
];
const HTML_CHANNELS = new Set(["body", "meta", "jsonLd"]);
const AUDITED_HTML_CHANNELS = new Set(["jsonLd"]);

function assertSurface(surface, claimId) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new Error(`Public claim ${claimId} has an invalid surface`);
  }
  if (typeof surface.route !== "string" || !surface.route.startsWith("/")) {
    throw new Error(`Public claim ${claimId} surface needs a root-relative route`);
  }
  if (!["pl", "en"].includes(surface.locale)) {
    throw new Error(`Public claim ${claimId} surface has an invalid locale`);
  }
  if (![...HTML_CHANNELS, "llms"].includes(surface.channel)) {
    throw new Error(`Public claim ${claimId} surface has an invalid channel`);
  }
  if (surface.markers !== undefined
    && (!Array.isArray(surface.markers) || surface.markers.length === 0
      || surface.markers.some((marker) => typeof marker !== "string" || !marker.trim()))) {
    throw new Error(`Public claim ${claimId} surface has invalid markers`);
  }
}

function routeMatches(pattern, route) {
  return pattern.endsWith("*") ? route.startsWith(pattern.slice(0, -1)) : route === pattern;
}

function surfaceMarkers(claim, surface) {
  return surface.markers ?? [claim.text[surface.locale]];
}

function isCurrentApproved(claim, now) {
  return claim.status === "approved" && new Date(`${claim.reviewBy}T23:59:59Z`) >= now;
}

function extractPublicHtmlSurfaces(html) {
  const jsonLd = [...html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )].map((match) => match[1]).join("\n");
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const meta = (html.match(/<meta\b[^>]*>/gi) ?? [])
    .map((tag) => tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "")
    .join("\n");
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return { body, meta: `${title}\n${meta}`, jsonLd };
}

export function validatePublicClaims(registry, root = DEFAULT_ROOT, now = new Date()) {
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.claims)) {
    throw new Error("Invalid public claims registry shape");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registry.lastReviewed ?? "")) {
    throw new Error("Public claims registry needs a review date");
  }
  const byId = new Map();
  for (const claim of registry.claims) {
    if (!claim.id || byId.has(claim.id)) throw new Error(`Duplicate or missing claim id: ${claim.id}`);
    if (!["draft", "pending", "approved", "rejected"].includes(claim.status)) {
      throw new Error(`Public claim ${claim.id} has an invalid status`);
    }
    if (!claim.owner || !Array.isArray(claim.surfaces) || claim.surfaces.length === 0) {
      throw new Error(`Public claim ${claim.id} is missing governance metadata or surfaces`);
    }
    for (const surface of claim.surfaces) assertSurface(surface, claim.id);
    if (claim.status === "approved" && (!claim.approvedAt || !claim.reviewBy)) {
      throw new Error(`Approved public claim ${claim.id} is missing approval metadata`);
    }
    if (!Array.isArray(claim.sources) || claim.sources.length === 0) {
      throw new Error(`Public claim ${claim.id} has no sources`);
    }
    for (const source of claim.sources.filter((item) => !item.startsWith("https://"))) {
      if (!existsSync(resolve(root, source))) throw new Error(`Claim ${claim.id} source is missing: ${source}`);
    }
    for (const locale of ["pl", "en"]) {
      const value = claim.text?.[locale];
      if (!value) throw new Error(`Public claim ${claim.id} is missing ${locale} copy`);
    }
    byId.set(claim.id, claim);
  }
  const publishedIds = registry.llms?.claimIds ?? [];
  if (new Set(publishedIds).size !== publishedIds.length) {
    throw new Error("llms.txt claim ids must be unique");
  }
  for (const id of publishedIds) {
    const claim = byId.get(id);
    if (!claim) throw new Error(`llms.txt references unknown claim ${id}`);
    if (claim.status !== "approved") throw new Error(`Public claim ${id} is not approved`);
    if (new Date(`${claim.reviewBy}T23:59:59Z`) < now) {
      throw new Error(`Public claim ${id} expired on ${claim.reviewBy}`);
    }
    for (const locale of ["pl", "en"]) {
      for (const forbidden of FORBIDDEN_PUBLIC_PATTERNS) {
        if (forbidden.test(claim.text[locale])) {
          throw new Error(`Public claim ${id} contains forbidden copy: ${forbidden}`);
        }
      }
    }
  }
  return { ...registry, byId };
}

export function auditPublicHtmlClaims(html, route, registry, now = new Date()) {
  if (typeof html !== "string" || !route?.path || !route?.locale) {
    throw new Error("Public HTML claim audit needs HTML and a route with path/locale");
  }
  const surfaces = extractPublicHtmlSurfaces(html);
  const applicable = registry.claims.flatMap((claim) => claim.surfaces
    .filter((surface) => AUDITED_HTML_CHANNELS.has(surface.channel)
      && surface.locale === route.locale
      && routeMatches(surface.route, route.path))
    .map((surface) => ({ claim, surface, markers: surfaceMarkers(claim, surface) })));
  const problems = [];

  for (const entry of applicable) {
    const surfaceText = surfaces[entry.surface.channel];
    const presentMarkers = entry.markers.filter((marker) =>
      surfaceText.toLocaleLowerCase().includes(marker.toLocaleLowerCase()));
    if (presentMarkers.length === 0) continue;
    if (entry.claim.status !== "approved") {
      problems.push(`${entry.surface.channel} publishes ${entry.claim.status} claim ${entry.claim.id}`);
    } else if (!isCurrentApproved(entry.claim, now)) {
      problems.push(`${entry.surface.channel} publishes expired claim ${entry.claim.id}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Public claim audit failed for ${route.path} (${route.locale}): ${problems.join("; ")}`);
  }
  return true;
}

/**
 * Where this checkout's claim registry lives.
 *
 * A deployment's claims are its own: they name its brand, its catalogue and its
 * legal pages, and their `sources` point at files only it has. So the registry
 * is an overlay-owned file, and `config/public-claims.json` is the neutral
 * default the platform publishes — the same public/private owner pair the
 * `imports` seams use, expressed for a JSON file that plain `node` reads during
 * the prebuild chain, where a package-import condition is not available.
 *
 * Selection is by PHYSICAL PRESENCE, not by env var, flag or JSON switch: the
 * published artifact ships with `src/overlays/**` absent, so it cannot resolve
 * anything but the neutral file, and no build command has to remember to say so.
 * Exactly one overlay may claim the slot; two would make the answer depend on
 * directory order, so that is an error rather than a coin toss.
 */
export function deploymentClaimsPath(root = DEFAULT_ROOT) {
  const overlayRoot = resolve(root, "src", "overlays");
  if (!existsSync(overlayRoot)) return null;
  const owned = readdirSync(overlayRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(overlayRoot, entry.name, "publicClaims.json"))
    .filter((candidate) => existsSync(candidate));
  if (owned.length > 1) {
    throw new Error(`Multiple deployment overlays declare publicClaims.json: ${owned.join(", ")}`);
  }
  return owned[0] ?? null;
}

export function loadPublicClaims(root = DEFAULT_ROOT, now = new Date()) {
  const path = deploymentClaimsPath(root) ?? resolve(root, "config", "public-claims.json");
  const registry = JSON.parse(readFileSync(path, "utf8"));
  return validatePublicClaims(registry, root, now);
}
