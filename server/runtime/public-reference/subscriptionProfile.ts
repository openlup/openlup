import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adaptRequest, decorateResponse, NodeRequestBodyTooLargeError } from "../../adapters/node/httpRequestAdapter.js";
import { readSupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseDataGateway } from "../../adapters/supabase/dataGateway.js";
import { createLocalReferenceDemoSellableCatalogPort, localReferenceDemoProfileEnabled } from "../../adapters/localReferenceStoreAdapter.js";
import { createReferenceCatalogItemsHandler } from "../../domains/catalog/referenceCatalogHandler.js";
import { sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { createReferenceAccountHandlers, type ReferenceHandler } from "./subscriptionAccount.js";
import { createCapturedReferenceCheckoutHandler } from "./capturedCheckout.js";
import { createReferenceOperatorHandler } from "./subscriptionOperator.js";

export const SUBSCRIPTION_PAGES = new Set(["/subscribe", "/account", "/account/auth/callback"]);
export const SUBSCRIPTION_CSP = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'";
const INSTANCE_KEY = "public_reference_subscription_instance";
const BASELINE = new URL("../../../supabase/migrations/00000000000000_platform_schema_baseline.sql", import.meta.url);
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function localOrigin(value: string | undefined): URL {
  const url = new URL(value ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Reference profile requires a loopback HTTP origin");
  return url;
}

/** Read only scalar fields in the CLI-generated configuration; ambiguity refuses. */
function scalar(config: string, section: string, key: string): string | undefined {
  let current = "";
  const values: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) current = heading[1];
    if (current !== section) continue;
    const assignment = line.match(/^\s*([A-Za-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|[0-9]+)\s*(?:#.*)?$/);
    if (assignment?.[1] === key) values.push(assignment[2]);
  }
  if (values.length > 1) throw new Error("Ambiguous reference configuration");
  return values[0];
}

export function validateSubscriptionProfile(env: NodeJS.ProcessEnv) {
  if (!localReferenceDemoProfileEnabled(env) || env.LOCAL_BFF !== "1"
    || env.NODE_ENV === "production" || env.APP_ENVIRONMENT || env.openlup_ENVIRONMENT
    || ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "RAILWAY_ENVIRONMENT"].some((key) => Boolean(env[key]))
    || env.OPENLUP_REFERENCE_DISPOSABLE !== "1") {
    throw new Error("Subscription reference is restricted to an owned disposable local setup");
  }
  const data = readSupabaseDataGatewayEnv(env);
  if (!data?.anonKey || !data.serviceRoleKey) throw new Error("Reference Supabase is not configured");
  const database = localOrigin(data.url);
  const origin = localOrigin(env.APP_BASE_URL);
  const directory = env.OPENLUP_REFERENCE_SUPABASE_DIR;
  const project = env.OPENLUP_REFERENCE_PROJECT_ID;
  if (!directory || !project || !/^[a-z0-9][a-z0-9-]{2,70}$/.test(project)) throw new Error("Reference project ownership is required");
  const configPath = resolve(directory, "supabase/config.toml");
  const markerPath = resolve(directory, "subscription-owner.json");
  const validateConfig = () => {
    const config = readFileSync(configPath, "utf8");
    if (scalar(config, "", "project_id") !== JSON.stringify(project)
      || scalar(config, "api", "port") !== database.port
      || scalar(config, "auth", "site_url") !== JSON.stringify(origin.origin)
      || scalar(config, "auth.email", "enable_confirmations") !== "true"
      || scalar(config, "auth.email.smtp", "enabled") === "true"
      || scalar(config, "inbucket", "enabled") !== "true") throw new Error("Reference setup must use confirmed email and local captured SMTP");
    for (const section of config.matchAll(/^\s*\[(auth\.external\.[^\]]+)\]/gm)) {
      if (scalar(config, section[1], "enabled") === "true") throw new Error("External Auth providers are unavailable in the captured profile");
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    if (marker.version !== 2 || marker.phase !== "sealed" || marker.projectId !== project
      || !Number.isSafeInteger(marker.portBase) || Number(marker.portBase) + 1 !== Number(database.port)
      || Number(marker.portBase) + 10 !== Number(origin.port)
      || marker.configSha256 !== sha256(config) || marker.baselineSha256 !== sha256(readFileSync(BASELINE))
      || typeof marker.instanceId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.instanceId)
      || typeof marker.boundContainerId !== "string" || !/^[0-9a-f]{64}$/.test(marker.boundContainerId)) {
      throw new Error("Reference setup marker does not identify this sealed installation");
    }
    return marker.instanceId;
  };
  validateConfig();
  const readLiveInstance = () => createSupabaseDataGateway(data).asService(async (service) => {
    const client = service as { from(table: string): { select(columns: string): { eq(column: string, value: string): { limit(count: number): PromiseLike<{ data: unknown; error: unknown }> } } } };
    const { data: rows, error } = await client.from("commerce_settings").select("value_text").eq("key", INSTANCE_KEY).limit(2);
    if (error || !Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.value_text !== "string") {
      throw new Error("Live database reference instance is unavailable");
    }
    return rows[0].value_text as string;
  });
  const assertDisposable = async (readInstance: () => Promise<string> = readLiveInstance) => {
    const instanceId = validateConfig();
    if (await readInstance() !== instanceId) throw new Error("Live database does not match the owned reference setup");
    const response = await fetch(`${database.origin}/auth/v1/settings`, {
      headers: { apikey: data.anonKey }, redirect: "error", signal: AbortSignal.timeout(3000),
    });
    const settings = await response.json() as { mailer_autoconfirm?: unknown; external?: Record<string, unknown> };
    if (!response.ok || settings.mailer_autoconfirm !== false || settings.external?.email !== true
      || Object.entries(settings.external ?? {}).some(([provider, enabled]) => provider !== "email" && enabled === true)) {
      throw new Error("Local Auth must require captured email confirmation");
    }
  };
  const outcome = env.OSS_REFERENCE_PAYMENT_OUTCOME;
  if (outcome !== "captured" && outcome !== "refused") throw new Error("An explicit captured payment outcome is required");
  return { data, origin: origin.origin, outcome, assertDisposable } as const;
}

export function createSubscriptionProfile(env: NodeJS.ProcessEnv) {
  const config = validateSubscriptionProfile(env);
  const gateway = createSupabaseDataGateway(config.data);
  const assertDisposable = () => config.assertDisposable();
  const account = createReferenceAccountHandlers(config.data, config.origin);
  const routes = new Map<string, { method: string; handler: ReferenceHandler }>([
    ["/api/bff/catalog/items", { method: "GET", handler: createReferenceCatalogItemsHandler({ catalogPort: createLocalReferenceDemoSellableCatalogPort() }) }],
    ["/api/bff/commerce/checkouts", { method: "POST", handler: createCapturedReferenceCheckoutHandler({ gateway, outcome: config.outcome, assertDisposable }) }],
    ["/api/bff/customers/magic-link", { method: "POST", handler: account.requestSignIn }],
    ["/api/bff/customers/reconcile-account", { method: "POST", handler: account.reconcile }],
    ["/api/bff/customers/account", { method: "GET", handler: account.account }],
    ["/api/bff/customers/subscriptions/action", { method: "POST", handler: account.renewal }],
    ["/api/bff/reference-journey/operator/subscription-readback", { method: "GET", handler: createReferenceOperatorHandler(config.data) }],
  ]);
  return {
    origin: config.origin,
    hasRoute: (pathname: string) => routes.has(pathname),
    async handle(request: IncomingMessage, response: ServerResponse, pathname: string) {
      const res = decorateResponse(response);
      response.setHeader("content-security-policy", SUBSCRIPTION_CSP);
      const route = routes.get(pathname);
      if (!route) return sendBffError(res, "NOT_FOUND", "Reference route not found");
      if (request.headers.host !== new URL(config.origin).host) return sendBffError(res, "FORBIDDEN", "Reference host mismatch");
      if (request.method !== route.method) return sendMethodNotAllowed(res, [route.method]);
      // All writes are same-origin JSON; credentials alone do not grant cross-site access.
      if (route.method !== "GET" && (request.headers.origin !== config.origin
        || request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json")) return sendBffError(res, "FORBIDDEN", "Same-origin JSON required");
      try {
        await assertDisposable();
        await route.handler(await adaptRequest(request, pathname, false, 32768), res);
      } catch (error) {
        if (!response.headersSent) sendBffError(res, error instanceof NodeRequestBodyTooLargeError ? "BAD_REQUEST" : "UPSTREAM_UNAVAILABLE", "Reference request could not be completed");
      }
    },
  };
}
