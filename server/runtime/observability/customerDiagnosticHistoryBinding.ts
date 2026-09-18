import { createHmac } from "node:crypto";

import type { VercelRequest } from "../../_lib/types/vercel.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
import { bindBundleDataPort } from "../dataBinding.js";
import { createCustomerIdentityBinding } from "../customers/customerIdentityBinding.js";
import { createCustomerDiagnosticHistoryPort } from "../../adapters/customerDiagnosticHistory.js";
import {
  createPostgresCustomerDiagnosticHistoryTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import { TRUSTED_PROXY_HOPS_ENV_KEY, resolveClientAddress } from "./clientAddressResolver.js";
import type {
  CustomerDiagnosticHistoryPort,
  CustomerDiagnosticOverviewPort,
} from "../../domains/observability/customerDiagnosticHistory.js";
import { CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME } from "../../domains/observability/customerDiagnosticPruneJob.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
type DataPort = NonNullable<ReturnType<typeof bindBundleDataPort>>;
type PostgresLane = ReturnType<typeof createPostgresCustomerDiagnosticHistoryTransactionLane>;

export class CustomerDiagnosticDisabledError extends Error {
  constructor() { super("customer_diagnostic_history_disabled"); }
}
export class CustomerDiagnosticConfigurationError extends Error {
  constructor() { super("customer_diagnostic_history_configuration_invalid"); }
}
export class CustomerDiagnosticOriginError extends Error {
  constructor() { super("customer_diagnostic_origin_invalid"); }
}
export class CustomerDiagnosticUnauthorizedError extends Error {
  constructor() { super("customer_diagnostic_auth_invalid"); }
}

export interface CustomerDiagnosticHistoryBinding {
  run<T>(work: (port: CustomerDiagnosticHistoryPort & CustomerDiagnosticOverviewPort) => Promise<T>): Promise<T>;
  authenticateCustomer(): Promise<{ principalId: string | null; subjectId: string | null }>;
  ingressAbuseKey(): string;
}

export interface CustomerDiagnosticLaneOptions {
  bindData?: (env: Env) => DataPort | null;
  createPostgresLane?: (env: { connectionString: string }) => PostgresLane;
}

interface Options extends CustomerDiagnosticLaneOptions {
  createIdentity?: typeof createCustomerIdentityBinding;
  createPort?: typeof createCustomerDiagnosticHistoryPort;
}

export type CustomerDiagnosticLaneKind = "postgres" | "managed";

/** One persistence lane for the diagnostic rail, chosen by the active bundle. */
export interface CustomerDiagnosticLane {
  kind: CustomerDiagnosticLaneKind;
  run<T>(work: (client: unknown) => Promise<T>): Promise<T>;
}

/**
 * Resolve the portable or managed lane. Shared by collection and by the
 * retention runtime, which must drain while collection is switched off and
 * therefore never passes through `readHistoryConfig`'s ingest gate.
 */
export function resolveCustomerDiagnosticLane(
  env: Env = process.env,
  options: CustomerDiagnosticLaneOptions = {},
): CustomerDiagnosticLane {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) throw new CustomerDiagnosticConfigurationError();
    const lane = postgresLane(connectionString, options.createPostgresLane);
    return { kind: "postgres", run: (work) => lane.run(work) };
  }
  const gateway = (options.bindData ?? bindBundleDataPort)(env);
  if (!gateway) throw new CustomerDiagnosticConfigurationError();
  return { kind: "managed", run: (work) => gateway.asService(work) };
}

export function resolveCustomerDiagnosticHistoryBinding(
  req: VercelRequest,
  env: Env = process.env,
  options: Options = {},
): CustomerDiagnosticHistoryBinding {
  const config = readHistoryConfig(env);
  const createPort = options.createPort ?? createCustomerDiagnosticHistoryPort;
  // The fail-closed coupling of the retention decision: an enabled ingest with
  // no proven drain — the prune flag off, or its control row disabled, absent
  // or unreadable — is a configuration error. Public ingest is the only caller
  // of `ingressAbuseKey()`, so taking the ingress key is what arms the gate for
  // this binding's `run()` — the operator read paths keep their behaviour and
  // the platform table stays out of them. Resolved at most once per binding.
  let ingressTaken = false;
  let drainEnabled: Promise<boolean> | null = null;
  return {
    async run(work) {
      if (!config.enabled) throw new CustomerDiagnosticDisabledError();
      if (!config.retentionDays) throw new CustomerDiagnosticConfigurationError();
      // Both locks, not either: the drain needs its flag AND its control row.
      if (ingressTaken && env.COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED !== "true") {
        throw new CustomerDiagnosticConfigurationError();
      }
      const lane = resolveCustomerDiagnosticLane(env, options);
      return lane.run(async (client) => {
        if (ingressTaken) {
          drainEnabled ??= readPruneControlEnabled(client);
          if (!await drainEnabled) throw new CustomerDiagnosticConfigurationError();
        }
        return work(createPort(client, config.retentionDays!));
      });
    },
    async authenticateCustomer() {
      if (!hasHeader(req, "authorization")) return { principalId: null, subjectId: null };
      const accessToken = readBearerToken(req);
      if (!accessToken) throw new CustomerDiagnosticUnauthorizedError();
      const identity = (options.createIdentity ?? createCustomerIdentityBinding)(req, env);
      if (!identity) throw new CustomerDiagnosticConfigurationError();
      let result;
      try {
        result = await identity.authenticateUser(req);
      } catch {
        throw new CustomerDiagnosticConfigurationError();
      }
      if (!result.ok) throw new CustomerDiagnosticUnauthorizedError();
      let subjectId: string | null = null;
      try {
        subjectId = (await identity.mePort.getCustomerMe(result.userId))?.clientId ?? null;
      } catch {
        // A verified principal remains observable when the customer profile is the failing dependency.
      }
      return { principalId: result.userId, subjectId };
    },
    ingressAbuseKey() {
      ingressTaken = true;
      if (!config.enabled) throw new CustomerDiagnosticDisabledError();
      if (!config.retentionDays || !config.ingressKey || !config.origin) {
        throw new CustomerDiagnosticConfigurationError();
      }
      // Strict origin: the configured public base or this deployment's own
      // origin. The SPA and the BFF are served from one host, so an immutable
      // staging candidate (`*.vercel.app`) ingests its own beacons while a
      // foreign or missing Origin is still refused.
      const requestOrigin = normalizeOrigin(header(req, "origin") ?? "");
      if (!requestOrigin || (requestOrigin !== config.origin && requestOrigin !== ownOrigin(req))) {
        throw new CustomerDiagnosticOriginError();
      }
      // No minute epoch: the sliding window belongs to the SQL admission check,
      // and a rotating key would hand every caller a fresh bucket each minute.
      const clientAddress = resolveClientAddress(req, {
        trustedProxyHops: readTrustedProxyHops(env),
        env,
      });
      return createHmac("sha256", config.ingressKey)
        .update(`diagnostic-ingress:v1:${clientAddress}`)
        .digest("hex");
    },
  };
}

const postgresLanes = new Map<string, PostgresLane>();

/** Close app-lifetime diagnostic pools during a graceful shutdown or a live proof. */
export async function closeCustomerDiagnosticRuntimeLanes(): Promise<void> {
  const lanes = [...postgresLanes.values()];
  postgresLanes.clear();
  await Promise.all(lanes.map((lane) => lane.close()));
}

function postgresLane(
  connectionString: string,
  create: Options["createPostgresLane"],
): PostgresLane {
  let lane = postgresLanes.get(connectionString);
  if (!lane) {
    lane = (create ?? createPostgresCustomerDiagnosticHistoryTransactionLane)({ connectionString });
    postgresLanes.set(connectionString, lane);
  }
  return lane;
}

type ControlRowReader = {
  from(table: "platform_job_controls"): {
    select(columns: "enabled"): {
      eq(column: "job_name", value: string): {
        maybeSingle(): PromiseLike<{
          data: { enabled?: boolean | null } | null;
          error: unknown;
        }>;
      };
    };
  };
};

/**
 * Read `platform_job_controls.enabled` for the retention job on the lane the
 * ingest is already using. Honestly a platform-table read inside the collection
 * path — cached for the binding's lifetime, and closed on any read failure or
 * missing row, because an unproven drain must never leave collection open.
 */
async function readPruneControlEnabled(client: unknown): Promise<boolean> {
  try {
    const result = await (client as ControlRowReader)
      .from("platform_job_controls")
      .select("enabled")
      .eq("job_name", CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME)
      .maybeSingle();
    return !result.error && result.data?.enabled === true;
  } catch {
    return false;
  }
}

/** The one retention policy: collection, reads and the retention drain share it. */
export function readCustomerDiagnosticRetentionDays(env: Env = process.env): number | null {
  const retention = Number(env.CUSTOMER_DIAGNOSTIC_RETENTION_DAYS);
  return Number.isInteger(retention) && retention >= 1 && retention <= 90 ? retention : null;
}

function readHistoryConfig(env: Env): {
  enabled: boolean;
  retentionDays: number | null;
  ingressKey: string | null;
  origin: string | null;
} {
  const ingressKey = env.CUSTOMER_DIAGNOSTIC_INGRESS_KEY?.trim() ?? "";
  return {
    enabled: env.COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED === "true",
    retentionDays: readCustomerDiagnosticRetentionDays(env),
    ingressKey: ingressKey.length >= 32 ? ingressKey : null,
    // Production sets APP_BASE_URL; staging sets only SITE_URL, the registered
    // fallback "consulted when APP_BASE_URL is absent". Without either the ingest fails closed.
    origin: normalizeOrigin(env.APP_BASE_URL?.trim() || env.SITE_URL?.trim() || ""),
  };
}

/**
 * A non-integer or negative hop count is a misconfiguration, not a reason to
 * silently fall through to a weaker address rung: it refuses public ingest the
 * way a bad retention refuses storage. Parsed here, beside the other env reads,
 * so the neutral resolver never has to know this runtime's failure vocabulary.
 */
function readTrustedProxyHops(env: Env): number | null {
  const declared = env[TRUSTED_PROXY_HOPS_ENV_KEY]?.trim() ?? "";
  if (!declared) return null;
  if (!/^\d+$/.test(declared)) throw new CustomerDiagnosticConfigurationError();
  return Number(declared);
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The origin this request was served from (`x-forwarded-*` on a proxy, else `host`). */
function ownOrigin(req: VercelRequest): string | null {
  const host = header(req, "x-forwarded-host") ?? header(req, "host");
  if (!host) return null;
  const proto = header(req, "x-forwarded-proto") ?? "https";
  return normalizeOrigin(`${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`);
}

function header(req: VercelRequest, name: string): string | null {
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) return value[0].trim();
  return null;
}

function hasHeader(req: VercelRequest, name: string): boolean {
  return Object.keys(req.headers ?? {}).some((key) => key.toLowerCase() === name);
}
