import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  normalizeRuntimeDeploymentUrl,
  normalizeRuntimeReleaseSha,
} from "../../_lib/observability/runtimeProvenance.ts";
import { loadSiteRouteManifest } from "../../../scripts/site-routes.mjs";
import { createSubscriptionProfile, SUBSCRIPTION_CSP, SUBSCRIPTION_PAGES } from "./subscriptionProfile.js";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type PublicReferenceServerOptions = {
  root?: string;
  distDir?: string;
  env?: NodeJS.ProcessEnv;
};

type Runtime = {
  pages: Map<string, string>;
  dist: string;
  env: NodeJS.ProcessEnv;
};

type PublicReferenceRouteManifest = {
  siteLifecycle: string;
  routes: Array<{ path: string }>;
};

function runtime(options: PublicReferenceServerOptions = {}): Runtime {
  const root = resolve(options.root ?? process.cwd());
  const manifest = loadSiteRouteManifest(root) as PublicReferenceRouteManifest;
  if (manifest.siteLifecycle !== "public-reference") {
    throw new Error("Public reference server requires the projected public reference route manifest");
  }
  const dist = resolve(root, options.distDir ?? process.env.OPENLUP_BUILD_OUT_DIR ?? "dist");
  const pages = new Map<string, string>(manifest.routes.map((route) => [route.path, route.path === "/"
    ? resolve(dist, "index.html")
    : resolve(dist, route.path.slice(1), "index.html")]));
  return { pages, dist, env: options.env ?? process.env };
}

function response(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  headOnly = false,
) {
  res.writeHead(status, { ...SECURITY_HEADERS, "cache-control": "no-store", ...headers, "content-length": String(Buffer.byteLength(body)) });
  res.end(headOnly ? undefined : body);
}

function requestPath(request: IncomingMessage): string | null {
  const raw = request.url ?? "/";
  const rawPath = raw.split("?", 1)[0];
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("%")
    || raw.includes("\\") || raw.includes("#")
    || rawPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  try {
    return new URL(raw, "http://public-reference.invalid").pathname;
  } catch {
    return null;
  }
}

function staticAsset(dist: string, pathname: string): string | null {
  if (!pathname.startsWith("/assets/")) return null;
  const candidate = resolve(dist, pathname.slice(1));
  if (!candidate.startsWith(`${dist}${sep}`) || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function health(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    status: "ok",
    releaseSha: normalizeRuntimeReleaseSha(env.APP_RELEASE_SHA),
    deploymentUrl: normalizeRuntimeDeploymentUrl(env.APP_DEPLOYMENT_URL),
  });
}

export function createPublicReferenceServer(options: PublicReferenceServerOptions = {}) {
  const current = runtime(options);
  const profileName = current.env.OPENLUP_REFERENCE_PROFILE;
  if (profileName && profileName !== "subscription") throw new Error("Unknown public reference profile");
  const subscription = profileName === "subscription" ? createSubscriptionProfile(current.env) : null;
  return createServer((request, res) => {
    const pathname = requestPath(request);
    if (!pathname) return response(res, 404, "Not found\n", { "content-type": "text/plain; charset=utf-8" });
    if (subscription?.hasRoute(pathname)) {
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      void subscription.handle(request, res, pathname);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response(res, 405, "Method not allowed\n", { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    }
    if (pathname === "/healthz") {
      const body = health(current.env);
      return response(res, 200, body, { "content-type": "application/json; charset=utf-8" }, request.method === "HEAD");
    }

    if (subscription && SUBSCRIPTION_PAGES.has(pathname)) {
      if (request.headers.host !== new URL(subscription.origin).host) return response(res, 403, "Reference host mismatch\n");
      const index = current.pages.get("/");
      if (!index || !existsSync(index)) return response(res, 503, "Build the subscription reference first\n");
      const document = readFileSync(index, "utf8");
      if (!document.includes('data-openlup-profile="subscription"')) return response(res, 503, "Build the subscription reference first\n");
      const shell = document.replace(/<div id="root">[\s\S]*<\/div>/, '<div id="root"></div>');
      return response(res, 200, shell, { "content-type": "text/html; charset=utf-8", "content-security-policy": SUBSCRIPTION_CSP }, request.method === "HEAD");
    }

    const page = current.pages.get(pathname);
    const asset = page ? null : staticAsset(current.dist, pathname);
    const file = page ?? asset;
    if (!file || !existsSync(file)) return response(res, 404, "Not found\n", { "content-type": "text/plain; charset=utf-8" });
    const body = readFileSync(file);
    return response(res, 200, body, {
      "cache-control": asset ? "public, max-age=31536000, immutable" : "no-store",
      "content-type": contentType(file),
    }, request.method === "HEAD");
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const port = Number(process.env.PORT ?? "8080");
  createPublicReferenceServer().listen(Number.isSafeInteger(port) && port > 0 ? port : 8080, process.env.OPENLUP_REFERENCE_PROFILE === "subscription" ? "127.0.0.1" : "0.0.0.0");
}
