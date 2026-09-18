import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest } from "../../_lib/types/vercel.js";
import {
  CustomerDiagnosticConfigurationError,
  CustomerDiagnosticDisabledError,
  CustomerDiagnosticOriginError,
  CustomerDiagnosticUnauthorizedError,
  closeCustomerDiagnosticRuntimeLanes,
  readCustomerDiagnosticRetentionDays,
  resolveCustomerDiagnosticHistoryBinding,
  resolveCustomerDiagnosticLane,
} from "./customerDiagnosticHistoryBinding.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const subjectId = "22222222-2222-4222-8222-222222222222";
const env = {
  COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
  CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "7",
  CUSTOMER_DIAGNOSTIC_INGRESS_KEY: "synthetic-ingress-key-that-is-long-enough",
  APP_BASE_URL: "https://shop.example.test",
};

describe("customer diagnostic history runtime binding", () => {
  afterEach(async () => { await closeCustomerDiagnosticRuntimeLanes(); });

  it("keeps support reads independent from public ingress configuration", async () => {
    const marker = {};
    const binding = resolveCustomerDiagnosticHistoryBinding(request(), {
      COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
      CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "7",
    }, {
      bindData: (() => ({ asService: async (work: (client: unknown) => unknown) => work(marker) })) as never,
      createPort: ((client: unknown, retention: number) => ({ client, retention })) as never,
    });
    await expect(binding.run(async (port) => port as unknown)).resolves.toEqual({ client: marker, retention: 7 });
  });

  it("reuses one portable owner transaction lane per process and closes it through the exported closer", async () => {
    const run = vi.fn(async (work: (client: unknown) => unknown) => work({ direct: true }));
    const close = vi.fn(async () => undefined);
    const createPostgresLane = vi.fn(() => ({ run, close }));
    const options = {
      createPostgresLane: createPostgresLane as never,
      createPort: ((client: unknown) => ({ client })) as never,
    };
    const postgresEnv = { ...env, PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local" };
    for (const _pass of [1, 2]) {
      await expect(resolveCustomerDiagnosticHistoryBinding(request(), postgresEnv, options)
        .run(async (port) => port as unknown)).resolves.toEqual({ client: { direct: true } });
    }
    expect(createPostgresLane).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    await closeCustomerDiagnosticRuntimeLanes();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("hands both runtime lanes a real port that carries the additive overview read", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const managed = resolveCustomerDiagnosticHistoryBinding(request(), env, {
      bindData: (() => ({ asService: async (work: (client: unknown) => unknown) => work({ rpc }) })) as never,
    });
    const postgres = resolveCustomerDiagnosticHistoryBinding(request(), {
      ...env, PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local",
    }, {
      createPostgresLane: (() => ({
        run: async (work: (client: unknown) => unknown) => work({ rpc }),
        close: async () => undefined,
      })) as never,
    });
    for (const binding of [managed, postgres]) {
      await expect(binding.run(async (port) => [
        typeof port.overview, typeof port.search, typeof port.readSegment, typeof port.ingest,
      ])).resolves.toEqual(["function", "function", "function", "function"]);
    }
    await expect(managed.run(async (port) => port.overview({
      contractVersion: "customer-diagnostic-history.v2", operatorId: principalId,
      windowStart: "2026-09-12T10:00:00.000Z", windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 10,
    }))).rejects.toThrow();
    expect(rpc).toHaveBeenCalledWith("customer_diagnostic_overview_v2", expect.objectContaining({
      p_operator_id: principalId, p_retention_days: 7,
    }));
  });

  it("refuses disabled or retention-misconfigured persistence", async () => {
    await expect(resolveCustomerDiagnosticHistoryBinding(request(), {}).run(async () => true))
      .rejects.toBeInstanceOf(CustomerDiagnosticDisabledError);
    await expect(resolveCustomerDiagnosticHistoryBinding(request(), {
      COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
    }).run(async () => true)).rejects.toBeInstanceOf(CustomerDiagnosticConfigurationError);
  });

  it("requires an exact non-null Origin and keys admission without a minute epoch", () => {
    const origin = "https://shop.example.test";
    const shared = createHmac("sha256", env.CUSTOMER_DIAGNOSTIC_INGRESS_KEY)
      .update("diagnostic-ingress:v1:unknown").digest("hex");
    const spoofed = ["203.0.113.7, 10.0.0.1", "198.51.100.4"].map((forwarded) =>
      resolveCustomerDiagnosticHistoryBinding(request({ origin, "x-forwarded-for": forwarded }), env).ingressAbuseKey());
    expect(spoofed).toEqual([shared, shared]);
    expect(() => resolveCustomerDiagnosticHistoryBinding(request({ origin }), {
      ...env, CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS: "not-a-number",
    }).ingressAbuseKey()).toThrow(CustomerDiagnosticConfigurationError);
    for (const value of [undefined, "", "null", "https://other.example.test", "https://shop.example.test/path"]) {
      expect(() => resolveCustomerDiagnosticHistoryBinding(request(value === undefined ? {} : { origin: value }), env).ingressAbuseKey())
        .toThrow(CustomerDiagnosticOriginError);
    }
  });

  it("accepts the deployment's own origin and the SITE_URL fallback, refusing everything else", () => {
    const shared = createHmac("sha256", env.CUSTOMER_DIAGNOSTIC_INGRESS_KEY)
      .update("diagnostic-ingress:v1:unknown").digest("hex");
    const own = { host: "candidate-123.vercel.app", "x-forwarded-proto": "https" };
    expect(resolveCustomerDiagnosticHistoryBinding(request({ ...own, origin: "https://candidate-123.vercel.app" }), env)
      .ingressAbuseKey()).toBe(shared);
    expect(() => resolveCustomerDiagnosticHistoryBinding(request({ ...own, origin: "https://other.example.test" }), env)
      .ingressAbuseKey()).toThrow(CustomerDiagnosticOriginError);
    const { APP_BASE_URL: _base, ...withoutBase } = env;
    expect(resolveCustomerDiagnosticHistoryBinding(request({ origin: "https://staging.example.test" }), {
      ...withoutBase, SITE_URL: "https://staging.example.test",
    }).ingressAbuseKey()).toBe(shared);
    expect(() => resolveCustomerDiagnosticHistoryBinding(request({ origin: "https://staging.example.test" }), withoutBase)
      .ingressAbuseKey()).toThrow(CustomerDiagnosticConfigurationError);
  });

  it("treats absent auth as anonymous but rejects every malformed supplied form", async () => {
    await expect(resolveCustomerDiagnosticHistoryBinding(request(), env).authenticateCustomer())
      .resolves.toEqual({ principalId: null, subjectId: null });
    for (const authorization of ["", "Basic value", [], ["Bearer one", "Bearer two"]]) {
      await expect(resolveCustomerDiagnosticHistoryBinding(request({ authorization }), env).authenticateCustomer())
        .rejects.toBeInstanceOf(CustomerDiagnosticUnauthorizedError);
    }
  });

  it("verifies once and resolves the distinct canonical customer subject", async () => {
    const authenticateUser = vi.fn(async () => ({ ok: true as const, userId: principalId }));
    const getCustomerMe = vi.fn(async () => ({ clientId: subjectId }));
    const binding = resolveCustomerDiagnosticHistoryBinding(request({ authorization: "Bearer valid" }), env, {
      createIdentity: (() => ({ authenticateUser, mePort: { getCustomerMe } })) as never,
    });
    await expect(binding.authenticateCustomer()).resolves.toEqual({ principalId, subjectId });
    expect(authenticateUser).toHaveBeenCalledTimes(1);
    expect(getCustomerMe).toHaveBeenCalledWith(principalId);
  });

  it("retains verified principal attribution when customer profile resolution fails", async () => {
    const binding = resolveCustomerDiagnosticHistoryBinding(request({ authorization: "Bearer valid" }), env, {
      createIdentity: (() => ({
        authenticateUser: vi.fn(async () => ({ ok: true as const, userId: principalId })),
        mePort: { getCustomerMe: vi.fn().mockRejectedValue(new Error("profile unavailable")) },
      })) as never,
    });
    await expect(binding.authenticateCustomer()).resolves.toEqual({ principalId, subjectId: null });
  });
});

describe("fail-closed coupling between collection and the retention drain", () => {
  afterEach(async () => { await closeCustomerDiagnosticRuntimeLanes(); });

  const ingressHeaders = { origin: "https://shop.example.test" };

  function controlClient(rows: Array<{ data: unknown; error: unknown }>) {
    const reads: Array<{ table: string; jobName: unknown }> = [];
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: null })),
      from(table: string) {
        return {
          select: () => ({
            eq: (_column: string, jobName: unknown) => ({
              maybeSingle: async () => {
                reads.push({ table, jobName });
                return rows[Math.min(reads.length - 1, rows.length - 1)]!;
              },
            }),
          }),
        };
      },
    };
    return { client, reads };
  }

  const ingestEnv = { ...env, COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: "true" };

  function ingestBinding(client: unknown, overrides: Record<string, unknown> = {}) {
    return resolveCustomerDiagnosticHistoryBinding(request(ingressHeaders), ingestEnv, {
      bindData: (() => ({ asService: (work: (c: unknown) => unknown) => work(client) })) as never,
      createPort: ((port: unknown) => port) as never,
      ...overrides,
    });
  }

  it("lets an enabled ingest through only when the prune control for the same policy is enabled", async () => {
    const { client, reads } = controlClient([{ data: { enabled: true }, error: null }]);
    const binding = ingestBinding(client);
    binding.ingressAbuseKey();

    await expect(binding.run(async () => "stored")).resolves.toBe("stored");
    expect(reads).toEqual([{ table: "platform_job_controls", jobName: "customer-diagnostic-prune" }]);
  });

  it("refuses collection closed when the drain is disabled, absent or unreadable", async () => {
    const closedRows = [
      { data: { enabled: false }, error: null },
      { data: null, error: null },
      { data: null, error: { message: "permission denied" } },
    ];
    for (const row of closedRows) {
      const binding = ingestBinding(controlClient([row]).client);
      binding.ingressAbuseKey();
      await expect(binding.run(async () => "stored")).rejects.toBeInstanceOf(CustomerDiagnosticConfigurationError);
    }

    const throwing = {
      rpc: vi.fn(),
      from() { throw new Error("platform_job_controls unavailable"); },
    };
    const binding = ingestBinding(throwing);
    binding.ingressAbuseKey();
    await expect(binding.run(async () => "stored")).rejects.toBeInstanceOf(CustomerDiagnosticConfigurationError);
  });

  it("refuses on the prune flag alone, before the control row is even read", async () => {
    // Both locks: an enabled control row does not license collection while the
    // drain's own flag is off.
    const { client, reads } = controlClient([{ data: { enabled: true }, error: null }]);
    for (const flag of [undefined, "false"]) {
      const binding = resolveCustomerDiagnosticHistoryBinding(request(ingressHeaders), {
        ...env, COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: flag,
      }, {
        bindData: (() => ({ asService: (work: (c: unknown) => unknown) => work(client) })) as never,
        createPort: ((port: unknown) => port) as never,
      });
      binding.ingressAbuseKey();
      await expect(binding.run(async () => "stored")).rejects.toBeInstanceOf(CustomerDiagnosticConfigurationError);
    }
    expect(reads).toEqual([]);
  });

  it("resolves the control once per binding lifetime across repeated ingests", async () => {
    const { client, reads } = controlClient([{ data: { enabled: true }, error: null }]);
    const binding = ingestBinding(client);
    binding.ingressAbuseKey();
    for (const _pass of [1, 2, 3]) await binding.run(async () => true);
    expect(reads).toHaveLength(1);
  });

  it("keeps the platform table out of the operator read paths, which take no ingress key", async () => {
    const { client, reads } = controlClient([{ data: { enabled: false }, error: null }]);
    await expect(ingestBinding(client).run(async () => "read")).resolves.toBe("read");
    expect(reads).toEqual([]);
  });

  it("closes both lanes on the same rule, portable included", async () => {
    const { client, reads } = controlClient([{ data: { enabled: false }, error: null }]);
    const binding = resolveCustomerDiagnosticHistoryBinding(request(ingressHeaders), {
      ...ingestEnv, PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local",
    }, {
      createPostgresLane: (() => ({
        run: async (work: (c: unknown) => unknown) => work(client), close: async () => undefined,
      })) as never,
      createPort: ((port: unknown) => port) as never,
    });
    binding.ingressAbuseKey();
    await expect(binding.run(async () => true)).rejects.toBeInstanceOf(CustomerDiagnosticConfigurationError);
    expect(reads).toEqual([{ table: "platform_job_controls", jobName: "customer-diagnostic-prune" }]);
  });
});

describe("shared diagnostic lane resolution", () => {
  afterEach(async () => { await closeCustomerDiagnosticRuntimeLanes(); });

  it("resolves both lanes for collection and for the retention drain, and refuses an unconfigured one", async () => {
    const managed = resolveCustomerDiagnosticLane({}, {
      bindData: (() => ({ asService: (work: (c: unknown) => unknown) => work("managed-client") })) as never,
    });
    expect(managed.kind).toBe("managed");
    await expect(managed.run(async (client) => client)).resolves.toBe("managed-client");

    const postgres = resolveCustomerDiagnosticLane({
      PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local",
    }, {
      createPostgresLane: (() => ({
        run: async (work: (c: unknown) => unknown) => work("postgres-client"), close: async () => undefined,
      })) as never,
    });
    expect(postgres.kind).toBe("postgres");
    await expect(postgres.run(async (client) => client)).resolves.toBe("postgres-client");

    expect(() => resolveCustomerDiagnosticLane({ PLATFORM_BUNDLE: "node-postgres" }))
      .toThrow(CustomerDiagnosticConfigurationError);
    expect(() => resolveCustomerDiagnosticLane({}, { bindData: (() => null) as never }))
      .toThrow(CustomerDiagnosticConfigurationError);
  });

  it("keeps one retention policy for collection and the drain", () => {
    expect(readCustomerDiagnosticRetentionDays({ CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "14" })).toBe(14);
    for (const value of [undefined, "", "0", "91", "7.5", "seven"]) {
      expect(readCustomerDiagnosticRetentionDays({ CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: value })).toBeNull();
    }
  });
});

function request(headers: Record<string, string | string[] | undefined> = {}): VercelRequest {
  return { method: "POST", headers, query: {} } as unknown as VercelRequest;
}
