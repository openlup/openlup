import type { CommunicationsReferenceMount } from "./communications.js";
import { readCustomerRouteEnv } from "../../bff/customers/shared.js";
import { enforceDeploymentRoutePolicy } from "#deployment-route-policy";
import { createReferenceBffDispatcher } from "../bffDispatch.js";
import { admitReferenceIdentity, type ReferenceIdentity, type ReferenceIdentityAdmission } from "../auth/referenceIdentity.js";
import type { admitReferenceOutbox } from "../outbox/candidateAdmission.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  normalizeRuntimeDeploymentUrl,
  normalizeRuntimeReleaseSha,
} from "../../_lib/observability/runtimeProvenance.ts";
import { loadSiteRouteManifest } from "../../../scripts/site-routes.mjs";
import { createSubscriptionProfile, SUBSCRIPTION_PAGES } from "./subscriptionProfile.js";

import { IDENTITY_PAGES, IDENTITY_ROUTES, identityLocalOrigin, withIdentityReferencePolicy, type IdentityReferenceProfile } from "../auth/referenceIdentityPolicy.js";
import { adaptRequest, decorateResponse } from "../../adapters/node/httpRequestAdapter.js";

/** The disposable profile augments the same admitted candidate used by other hosts. */
export type ReferenceIdentityRuntime = ReferenceIdentityAdmission & {
  profile: IdentityReferenceProfile;
  authOrigin?: string;
};

const runtimeEnvironment = process.env;
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
  communications?: CommunicationsReferenceMount;
  identity?: ReferenceIdentityAdmission & { profile?: IdentityReferenceProfile; authOrigin?: string };
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
  const dist = resolve(root, options.distDir ?? runtimeEnvironment.OPENLUP_BUILD_OUT_DIR ?? "dist");
  const pages = new Map<string, string>(manifest.routes.map((route) => [route.path, route.path === "/"
    ? resolve(dist, "index.html")
    : resolve(dist, route.path.slice(1), "index.html")]));
  return { pages, dist, env: options.env ?? runtimeEnvironment };
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
  if (!raw.startsWith("/") || raw.startsWith("//") || rawPath.includes("%")
    || raw.includes("\\") || raw.includes("#")
    || rawPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  try {
    // Validate once without rewriting the query used by downstream handlers.
    decodeURIComponent(raw.slice(rawPath.length));
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

function createServerForCandidate(options: PublicReferenceServerOptions, identityRuntime?: ReferenceIdentity) {
  const current = runtime(options);
  if (identityRuntime && identityRuntime.bundle !== (current.env.PLATFORM_BUNDLE ?? "node-supabase")) throw new Error("Identity candidate bundle does not match the reference host");
  const profileName = current.env.OPENLUP_REFERENCE_PROFILE;
  if (profileName && !["subscription", "identity", "communications"].includes(profileName)) throw new Error("Unknown public reference profile");
  const communications=profileName==="communications"?options.communications:undefined;
  if(profileName==="communications"&&!communications)throw new Error("Communications reference requires startup admission");
  const identity = profileName === "identity" ? options.identity : undefined;
  if (profileName === "identity" && !identity?.profile) throw new Error("Identity reference requires composed routes and admission");
  if (identity && (identity.profile!.bundle !== current.env.PLATFORM_BUNDLE || identity.profile!.origin !== identityLocalOrigin(current.env.APP_BASE_URL ?? ""))) throw new Error("Identity composition does not match selected installation");
  const identityCsp = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'" + (identity?.authOrigin ? ` ${identityLocalOrigin(identity.authOrigin)}` : "");
  const subscription = profileName === "subscription" ? createSubscriptionProfile(current.env) : null;
  const dispatch = createReferenceBffDispatcher(() => identityRuntime?.env ?? current.env, identityRuntime?.preflight);
  return createServer((request, res) => {
    const pathname = requestPath(request);
    if (!pathname) return response(res, 404, "Not found\n", { "content-type": "text/plain; charset=utf-8" });
    if(communications&&(pathname.startsWith("/api/")||pathname===communications.page)) {
      try{communications.admission.assertCurrent();}catch{return response(res,503,"Communications admission stale\n");}
      if(request.headers.host!==new URL(communications.origin).host)return response(res,403,"Reference host mismatch\n");
      const csp="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'";
      for(const [key,value] of Object.entries(SECURITY_HEADERS))res.setHeader(key,value);
      res.setHeader("content-security-policy",csp);
      if(pathname===communications.page){
        if(!["GET","HEAD"].includes(request.method??""))return response(res,405,"Method not allowed\n");
        const file=resolve(current.dist,"index.html");
        if(!existsSync(file))return response(res,503,"Build the communications reference first\n");
        const document=readFileSync(file,"utf8");
        if(!document.includes('data-openlup-profile="communications"'))return response(res,503,"Build the communications reference first\n");
        return response(res,200,document,{"content-type":"text/html; charset=utf-8","content-security-policy":csp},request.method==="HEAD");
      }
      if(!communications.admission.runtime.routes.some(route=>route.id===pathname))return response(res,404,"Not found\n");
      if(request.headers.origin&&request.headers.origin!==communications.origin)return response(res,403,"Reference origin mismatch\n");
      void adaptRequest(request,pathname,communications.rawStreamRoutes.includes(pathname),32768).then(req=>communications.admission.route(pathname,req,decorateResponse(res))).catch(()=>{if(!res.headersSent)response(res,503,"Communications unavailable\n");else res.destroy();});
      return;
    }
    if (identity && pathname.startsWith("/api/")) {
      const route = identityRuntime?.routes.find(entry => entry.route === pathname);
      const method = IDENTITY_ROUTES.get(pathname);
      if (!route || !method) return response(res, 404, "Not found\n");
      if (request.headers.host !== new URL(identity.profile!.origin).host || request.method !== method
        || (method !== "GET" && (request.headers.origin !== identity.profile!.origin
          || request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json"))) return response(res, 403, "Identity reference request refused\n");
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      res.setHeader("content-security-policy", identityCsp);
      void withIdentityReferencePolicy(identity.profile!, async () => {
        await dispatch(identityRuntime!.routes, await adaptRequest(request, pathname, false, 32768), decorateResponse(res));
      }).catch(() => { if (!res.headersSent) response(res, 503, "Identity reference unavailable\n"); else res.destroy(); });
      return;
    }
    if (identityRuntime?.routes.some(route => route.pattern.test(pathname))) {
      const decorated = decorateResponse(res);
      if (!enforceDeploymentRoutePolicy({ route: pathname, domain: "identity", surface: pathname.startsWith("/api/bff/admin/") ? "admin" : "customer", risk: "mutation" }, request, decorated)) return;
      void adaptRequest(request, pathname, false, 32768).then(req => dispatch(identityRuntime.routes, req, decorateResponse(res))).catch(() => {
        if (!res.headersSent) response(res, 503, "Identity request unavailable\n");
      });
      return;
    }
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

    if (identity && IDENTITY_PAGES.has(pathname)) {
      if (request.headers.host !== new URL(identity.profile!.origin).host) return response(res, 403, "Reference host mismatch\n");
      const index = resolve(current.dist, "index.html");
      if (!existsSync(index)) return response(res, 503, "Build the identity reference first\n");
      const document = readFileSync(index, "utf8");
      if (!document.includes('data-openlup-profile="identity"')) return response(res, 503, "Build the identity reference first\n");
      return response(res, 200, document, { "content-type": "text/html; charset=utf-8", "content-security-policy": identityCsp }, request.method === "HEAD");
    }
    if (subscription && SUBSCRIPTION_PAGES.has(pathname)) {
      if (request.headers.host !== new URL(subscription.origin).host) return response(res, 403, "Reference host mismatch\n");
      const index = current.pages.get("/");
      if (!index || !existsSync(index)) return response(res, 503, "Build the subscription reference first\n");
      const document = readFileSync(index, "utf8");
      if (!document.includes('data-openlup-profile="subscription"')) return response(res, 503, "Build the subscription reference first\n");
      const shell = document.replace(/<div id="root">[\s\S]*<\/div>/, '<div id="root"></div>');
      return response(res, 200, shell, { "content-type": "text/html; charset=utf-8", "content-security-policy": subscription.csp }, request.method === "HEAD");
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

export function createPublicReferenceServer(options: PublicReferenceServerOptions = {}) {
  if ((options.env ?? runtimeEnvironment).OPENLUP_REFERENCE_PROFILE === "communications") throw new Error("Communications profile requires startup admission");
  if ((options.env ?? runtimeEnvironment).OPENLUP_REFERENCE_PROFILE === "identity") throw new Error("Identity profile requires startup admission");
  return createServerForCandidate(options);
}

/** Start the selected candidate only after its composed rail has been admitted. */
export async function startPublicReferenceServer(options: PublicReferenceServerOptions & {
  outbox?: Awaited<ReturnType<typeof admitReferenceOutbox>>;
  bindSchedule?: (id: string, cadenceSeconds: number, run: () => Promise<unknown>) => void;
  port?: number;
  host?: string;
} = {}) {
  const communicationsSelected=(options.env??runtimeEnvironment).OPENLUP_REFERENCE_PROFILE==="communications";
  if(communicationsSelected&&!options.communications)throw new Error("Communications reference requires startup admission");
  if(options.communications){
    if(!communicationsSelected||options.identity||options.outbox)throw new Error("Compose selected modules in one communications admission before listener");
    options.communications.admission.assertCurrent();
    if(options.communications.admission.runtime.bundle!==((options.env??runtimeEnvironment).PLATFORM_BUNDLE??"node-supabase"))throw new Error("Communications bundle mismatch");
    if(options.host&&!["127.0.0.1","localhost","::1"].includes(options.host))throw new Error("Communications listener must be loopback");
    const port=Number(new URL(options.communications.origin).port||"80");
    if(options.port!==undefined&&options.port!==port)throw new Error("Communications listener must match origin");
    if(options.communications.admission.runtime.schedules.length&&!options.bindSchedule)throw new Error("Communications schedule binding required before listener");
  }
  if (options.outbox && (!options.outbox.admitted || !options.bindSchedule)) throw new Error("Public reference outbox candidate refused before listener");
  if ((options.env ?? runtimeEnvironment).OPENLUP_REFERENCE_PROFILE === "identity") {
    if (!options.identity?.profile) throw new Error("Identity reference composition required before listener");
    if (options.host && !["127.0.0.1", "localhost", "::1"].includes(options.host)) throw new Error("Identity reference listener must be loopback");
    const port = Number(new URL(options.identity.profile!.origin).port || "80");
    if (options.port !== undefined && options.port !== port) throw new Error("Identity reference listener must match its owned origin");
    await options.identity.profile!.assertOwned();
  }
  if (options.identity && options.outbox) throw new Error("Compose selected module contributions together before combining identity and outbox");
  const assertIdentityEnvironment = () => {
    if (!options.identity) return;
    const ambient = readCustomerRouteEnv();
    const selected = options.env ?? ambient;
    const composed = options.identity.runtime.env;
    if (options.identity.runtime.bundle !== (selected.PLATFORM_BUNDLE ?? "node-supabase")) throw new Error("Identity candidate bundle does not match the reference host");
    // Mounted application handlers also read the ambient environment. Refuse a split composition.
    for (const key of new Set([...Object.keys(selected), ...Object.keys(composed), ...Object.keys(ambient)])) {
      if (selected[key] !== composed[key] || selected[key] !== ambient[key]) throw new Error("Identity candidate environment does not match the reference host");
    }
  };
  assertIdentityEnvironment();
  const identity = options.identity ? await admitReferenceIdentity(options.identity) : undefined;
  if (identity && !identity.admitted) throw new Error(`Public reference identity candidate refused before listener: ${identity.report.state}`);
  identity?.assertCurrent();
  assertIdentityEnvironment();
  const server = createServerForCandidate(options, options.identity?.runtime);
  const listen = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? (options.communications ? Number(new URL(options.communications.origin).port || "80") : options.identity?.profile ? Number(new URL(options.identity.profile!.origin).port || "80") : 8080), options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  if (options.outbox?.admitted) await options.outbox.start({ listen, bind: options.bindSchedule! });
  else {
    if(options.communications){
      const admission=options.communications.admission;admission.assertCurrent();
      for(const schedule of admission.runtime.schedules)options.bindSchedule!(schedule.id,schedule.cadenceSeconds,()=>admission.run(schedule.id));
    }
    await listen();
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const port = Number(runtimeEnvironment.PORT ?? "8080");
  await startPublicReferenceServer({ port: Number.isSafeInteger(port) && port > 0 ? port : 8080, host: runtimeEnvironment.OPENLUP_REFERENCE_PROFILE === "subscription" ? "127.0.0.1" : "0.0.0.0" });
}
