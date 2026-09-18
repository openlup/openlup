import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseOmnipackCronGateway,
  defaultPlatformJobDriver,
  platformJobInvocation,
} from "./omnipackCronGateway.js";

describe("supabase OmniPack cron gateway", () => {
  it.each([
    ["manual_admin", { triggerKind: "operator", invocationSource: "manual_admin" }],
    ["pg_cron", { triggerKind: "scheduler", invocationSource: "pg_cron" }],
    ["vercel_cron", { triggerKind: "scheduler", invocationSource: "vercel_cron" }],
    ["worker", { triggerKind: "worker", invocationSource: "worker" }],
  ] as const)("maps the physical %s driver to one neutral invocation", (driver, expected) => {
    expect(platformJobInvocation(driver)).toEqual(expected);
  });

  it("uses node_cron as the direct PostgreSQL scheduler evidence and preserves the managed default", () => {
    expect(defaultPlatformJobDriver({ PLATFORM_BUNDLE: "node-postgres" })).toBe("node_cron");
    expect(defaultPlatformJobDriver({ PLATFORM_BUNDLE: "managed" })).toBe("vercel_cron");
  });

  it("binds the node-postgres bundle to v3 with the actual default scheduler source", async () => {
    const executor = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("platform_claim_job_run_v3")
          ? [{ acquired: true, run_id: "57a99fd4-cee2-4c91-8097-3b25cc01a153", reason: "acquired" }]
          : [{ released: true }],
      })),
    };
    const gateway = createSupabaseOmnipackCronGateway(
      {
        PLATFORM_BUNDLE: "node-postgres",
        DATABASE_URL: "postgresql://local.invalid/platform",
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service",
      },
      vi.fn(() => fakeClient({ acquired: true })) as never,
      { postgresJobRunExecutor: executor },
    );

    await expect(gateway?.runJob({
      jobName: "omnipack-dispatch",
      operation: async () => ({ checked: 1, updated: 1, failures: 0, skipped: false }),
      finish: (result) => ({ status: "success", result }),
    })).resolves.toMatchObject({ acquired: true });

    expect(executor.query).toHaveBeenNthCalledWith(1, expect.stringContaining("platform_claim_job_run_v3"), [
      "omnipack-dispatch",
      "scheduler",
      "node_cron",
      900,
      expect.objectContaining({ triggerKind: "scheduler", invocationSource: "node_cron" }),
    ]);
    expect(executor.query).toHaveBeenNthCalledWith(2, expect.stringContaining("platform_finish_job_run_v3"), [
      "omnipack-dispatch",
      "57a99fd4-cee2-4c91-8097-3b25cc01a153",
      "success",
      1,
      1,
      null,
      null,
      expect.objectContaining({ driver: "node_cron", invocationSource: "node_cron" }),
    ]);
  });

  it("returns null before constructing a DB client when service-role env is missing", () => {
    const clientFactory = vi.fn();

    expect(createSupabaseOmnipackCronGateway({ SUPABASE_URL: "https://supabase.test" }, clientFactory as never)).toBeNull();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("reads the stock-sync backstop state from the existing control row", async () => {
    const { client, query } = controlClient({
      last_status: "failed",
      last_success_at: "2026-07-16T10:00:00.000Z",
    });
    const gateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => client) as never,
    );

    await expect(gateway?.readJobBackstopState?.("omnipack-stock-sync")).resolves.toEqual({
      lastStatus: "failed",
      lastSuccessAt: "2026-07-16T10:00:00.000Z",
    });
    expect(client.from).toHaveBeenCalledWith("platform_job_controls");
    expect(query.select).toHaveBeenCalledWith("last_status,last_success_at");
    expect(query.eq).toHaveBeenCalledWith("job_name", "omnipack-stock-sync");
  });

  it.each(["success", "failed"] as const)(
    "reads metadata from the latest %s terminal run using the checkpoint query contract",
    async (terminalStatus) => {
      const metadata = { nextPage: 3, terminalStatus };
      const { client, query } = metadataClient({ metadata });
      const gateway = createSupabaseOmnipackCronGateway(
        { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
        vi.fn(() => client) as never,
      );

      await expect(gateway?.readLatestTerminalRunMetadata("omnipack-reconciliation"))
        .resolves.toEqual(metadata);

      expect(client.from).toHaveBeenCalledWith("platform_job_runs");
      expect(query.select).toHaveBeenCalledWith("metadata");
      expect(query.eq).toHaveBeenCalledWith("job_name", "omnipack-reconciliation");
      expect(query.in).toHaveBeenCalledWith("status", ["success", "failed"]);
      expect(query.not).not.toHaveBeenCalled();
      expect(query.order).toHaveBeenCalledWith("started_at", { ascending: false });
      expect(query.limit).toHaveBeenCalledWith(1);
      expect(query.maybeSingle).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["no matching terminal run", null],
    ["missing metadata", {}],
    ["non-object metadata", { metadata: ["not", "a", "checkpoint"] }],
  ] as const)("returns null for %s", async (_case, data) => {
    const { client } = metadataClient(data);
    const gateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => client) as never,
    );

    await expect(gateway?.readLatestTerminalRunMetadata("omnipack-reconciliation"))
      .resolves.toBeNull();
  });

  it("throws a stable safe error when checkpoint lookup fails", async () => {
    const { client } = metadataClient(null, { message: "password leaked by database" });
    const gateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => client) as never,
    );

    await expect(gateway?.readLatestTerminalRunMetadata("omnipack-reconciliation"))
      .rejects.toThrow("omnipack_cron_checkpoint_read_failed");
  });

  it.each(["vercel_cron", "pg_cron", "worker", "manual_admin"] as const)(
    "preserves the %s driver from claim through finish for the same run identity",
    async (driver) => {
      const client = fakeClient({ acquired: true, runId: `run-${driver}` });
      const clientFactory = vi.fn(() => client);
      const gateway = createSupabaseOmnipackCronGateway(
        { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
        clientFactory as never,
      );

      await expect(gateway?.runJob({
        jobName: "omnipack-dispatch",
        driver,
        operation: async (ports) => {
          expect(ports.dispatch).toBeTruthy();
          expect(ports.productSync).toBeTruthy();
          expect(ports.reconciliation).toBeTruthy();
          expect(ports.stockSync).toBeTruthy();
          return { checked: 1, updated: 0, failures: 0, skipped: false };
        },
        finish: (result) => ({
          status: "success",
          result,
          extraMetadata: { driver: "stale-caller-value" },
        }),
      })).resolves.toEqual({
        acquired: true,
        result: { checked: 1, updated: 0, failures: 0, skipped: false },
      });

      expect(clientFactory).toHaveBeenCalledWith("https://supabase.test", "service", {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      expect(client.rpc).toHaveBeenCalledWith("platform_claim_job_run", expect.objectContaining({
        p_job_name: "omnipack-dispatch",
        p_driver: driver,
        p_metadata: expect.objectContaining({
          driver,
          triggerSource: {
            vercel_cron: "vercel_cron",
            pg_cron: "pg_cron_scheduler",
            worker: "worker",
            manual_admin: "manual_admin",
          }[driver],
        }),
      }));
      expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({
        p_job_name: "omnipack-dispatch",
        p_run_id: `run-${driver}`,
        p_status: "success",
        p_metadata: expect.objectContaining({ driver }),
      }));
    },
  );

  it("does not run the worker or finish the job when the lease is not acquired", async () => {
    const client = fakeClient({ acquired: false, reason: "already_running" });
    const gateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => client) as never,
    );
    const operation = vi.fn();

    await expect(gateway?.runJob({
      jobName: "omnipack-stock-sync",
      operation,
      finish: () => ({ status: "success", result: { checked: 0, updated: 0, failures: 0, skipped: true } }),
    })).resolves.toEqual({ acquired: false, reason: "already_running" });

    expect(operation).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("platform_finish_job_run_v2", expect.anything());
  });

  it("wires the reconciliation accounting port only when handoff accounting is enabled", async () => {
    const client = fakeClient({ acquired: true });
    const accountingPort = {
      requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => accountingIssueResponse()),
      requestInvoiceIssueFromPaidOrder: vi.fn(async () => accountingIssueResponse()),
    };
    const accountingPortFactory = vi.fn(() => accountingPort);
    const gateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => client) as never,
      {
        reconciliationAccountingEnabled: true,
        accountingPortFactory,
        accountingProviderKind: "fakturownia_test",
      },
    );

    await gateway?.runJob({
      jobName: "omnipack-reconciliation",
      operation: async ({ reconciliation }) => {
        await reconciliation.issueAccountingInvoice?.({
          idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
          fulfillmentOrderId: "ful-1",
        });
        return { checked: 1, updated: 1, failures: 0, skipped: false };
      },
      finish: (result) => ({ status: "success", result }),
    });

    expect(accountingPortFactory).toHaveBeenCalledWith(client);
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
      providerKind: "fakturownia_test",
    });

    const disabledFactory = vi.fn();
    const disabledGateway = createSupabaseOmnipackCronGateway(
      { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service" },
      vi.fn(() => fakeClient({ acquired: true })) as never,
      { reconciliationAccountingEnabled: false, accountingPortFactory: disabledFactory },
    );
    await disabledGateway?.runJob({
      jobName: "omnipack-reconciliation",
      operation: async ({ reconciliation }) => {
        expect(reconciliation.issueAccountingInvoice).toBeUndefined();
        return { checked: 0, updated: 0, failures: 0, skipped: false };
      },
      finish: (result) => ({ status: "success", result }),
    });
    expect(disabledFactory).not.toHaveBeenCalled();
  });
});

function fakeClient(lease: { acquired: boolean; reason?: string; runId?: string }) {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "platform_claim_job_run") {
        return { data: { acquired: lease.acquired, run_id: lease.acquired ? lease.runId ?? "run-1" : null, reason: lease.reason ?? "claimed" }, error: null };
      }
      return { data: true, error: null };
    }),
    from: vi.fn(),
  };
}

function metadataClient(
  data: { metadata?: unknown } | null,
  error: { message?: string } | null = null,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return {
    client: {
      rpc: vi.fn(async () => ({ data: true, error: null })),
      from: vi.fn(() => query),
    },
    query,
  };
}

function controlClient(data: { last_status?: string | null; last_success_at?: string | null } | null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return {
    client: {
      rpc: vi.fn(async () => ({ data: true, error: null })),
      from: vi.fn(() => query),
    },
    query,
  };
}

function accountingIssueResponse() {
  return {
    invoice: {
      id: "invoice-1",
      invoiceRef: "order-1:base",
      status: "requested",
      replayed: false,
    },
  };
}
