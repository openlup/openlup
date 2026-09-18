import { describe, expect, it, vi } from "vitest";
import type { AdminAuthorization } from "../admin/commerce/shared.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
  type RunLocalReferenceRenewalTickResponse,
} from "../../../src/domains/subscription/runtimeContracts.js";
import { runLocalReferenceRenewalTick } from "../../../src/domains/subscription/runtimePorts.js";
import { BffClientError } from "../../../src/lib/bff/client.js";
import {
  createLocalReferenceRenewalTickHandler,
  createLocalReferenceRenewalTickRunner,
  LOCAL_REFERENCE_RENEWAL_TICK_DRIVER,
  LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
} from "./renewal-ticks.js";

const SUCCESS: RunLocalReferenceRenewalTickResponse = {
  contractVersion: SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
  renewalTick: {
    asOf: "2026-08-01T10:00:00.000Z",
    scanned: 0,
    startedRows: 0,
    deferredByBudget: 0,
    errors: 0,
    results: [],
  },
};

function response() {
  const output: { status: number; body: unknown; allow?: string } = {
    status: 200,
    body: null,
  };
  const res = {
    status(code: number) {
      output.status = code;
      return res;
    },
    json(body: unknown) {
      output.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      if (name === "Allow") output.allow = value;
      return res;
    },
  } as unknown as HttpResponse;
  return { res, output };
}

function request(method = "POST", body: unknown = {}): HttpRequest {
  return { method, body, headers: {}, query: {} } as unknown as HttpRequest;
}

function dependencies(auth: AdminAuthorization = {
  ok: true,
  userId: "00000000-0000-4000-8000-000000000001",
  role: "admin",
  isMachineActor: false,
}) {
  return {
    profileEnabled: vi.fn(() => true),
    authorizeAdmin: vi.fn(async () => auth),
    runTick: vi.fn(async () => SUCCESS),
  };
}

describe("local reference subscription renewal tick", () => {
  it("returns 404 before method, auth, or service work outside the local profile", async () => {
    const deps = dependencies();
    deps.profileEnabled.mockReturnValue(false);
    const handler = createLocalReferenceRenewalTickHandler(deps);
    const { res, output } = response();

    await handler(request("GET"), res);

    expect(output.status).toBe(404);
    expect(deps.authorizeAdmin).not.toHaveBeenCalled();
    expect(deps.runTick).not.toHaveBeenCalled();
  });

  it("accepts POST only once the local profile is active", async () => {
    const deps = dependencies();
    const handler = createLocalReferenceRenewalTickHandler(deps);
    const { res, output } = response();

    await handler(request("GET"), res);

    expect(output.status).toBe(405);
    expect(output.allow).toBe("POST");
    expect(deps.authorizeAdmin).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }, 401],
    [{ ok: false, code: "FORBIDDEN", message: "Admin role required" }, 403],
  ] as const)("rejects a denied operator session", async (authorization, status) => {
    const deps = dependencies(authorization);
    const handler = createLocalReferenceRenewalTickHandler(deps);
    const { res, output } = response();

    await handler(request(), res);

    expect(output.status).toBe(status);
    expect(deps.runTick).not.toHaveBeenCalled();
  });

  it.each([null, { asOf: "2099-01-01T00:00:00.000Z" }])("rejects caller-controlled or null bodies", async (body) => {
    const deps = dependencies();
    const handler = createLocalReferenceRenewalTickHandler(deps);
    const { res, output } = response();

    await handler(request("POST", body), res);

    expect(output.status).toBe(400);
    expect(deps.runTick).not.toHaveBeenCalled();
  });

  it("returns the validated fixed-clock tick result in the BFF envelope", async () => {
    const deps = dependencies();
    const handler = createLocalReferenceRenewalTickHandler(deps);
    const { res, output } = response();

    await handler(request(), res);

    expect(output.status).toBe(200);
    expect(output.body).toEqual({ ok: true, data: SUCCESS });
    expect(deps.runTick).toHaveBeenCalledOnce();
  });

  it("exposes a typed client that sends no server-owned composition choice", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, data: SUCCESS }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(runLocalReferenceRenewalTick({ fetcher })).resolves.toEqual(SUCCESS);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/subscriptions/renewal-ticks",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("rejects a malformed renewal response at the typed client boundary", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, data: { renewalTick: { asOf: "caller-owned" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(runLocalReferenceRenewalTick({ fetcher })).rejects.toBeInstanceOf(BffClientError);
  });
});

describe("renewal tick runner — platform-job lease", () => {
  const BATCH = {
    kind: "completed",
    rows: [{ subscriptionId: "sub-1" }],
    startedRows: 1,
    deferredByBudget: 0,
    errors: [],
    results: [],
  };

  function runnerDependencies(overrides: {
    acquired?: boolean;
    reason?: string;
    runBatch?: () => Promise<unknown>;
  } = {}) {
    const claim = vi.fn(async () => ({
      acquired: overrides.acquired ?? true,
      runId: (overrides.acquired ?? true) ? "run-1" : null,
      reason: overrides.reason ?? "unknown",
    }));
    const finish = vi.fn(async () => true);
    const runBatch = vi.fn(overrides.runBatch ?? (async () => BATCH));
    const readGateway = vi.fn(() => ({
      asService: async (work: (client: unknown) => Promise<unknown>) => work({}),
    }));
    return { claim, finish, runBatch, readGateway };
  }

  function runner(deps: ReturnType<typeof runnerDependencies>) {
    return createLocalReferenceRenewalTickRunner(
      deps as unknown as Parameters<typeof createLocalReferenceRenewalTickRunner>[0],
    );
  }

  it("claims the renewal job lease before touching the batch", async () => {
    const deps = runnerDependencies();

    await runner(deps)();

    expect(deps.claim).toHaveBeenCalledWith(
      expect.anything(),
      LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
      LOCAL_REFERENCE_RENEWAL_TICK_DRIVER,
      expect.any(Number),
    );
    expect(deps.claim.mock.invocationCallOrder[0]).toBeLessThan(deps.runBatch.mock.invocationCallOrder[0]);
  });

  it("refuses a concurrent tick instead of starting a second overlapping batch", async () => {
    const deps = runnerDependencies({ acquired: false, reason: "lease_held" });

    await expect(runner(deps)()).rejects.toThrow(/lease unavailable \(lease_held\)/);
    expect(deps.runBatch).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("releases the lease as success with the batch counts", async () => {
    const deps = runnerDependencies();

    await runner(deps)();

    expect(deps.finish).toHaveBeenCalledWith(
      expect.anything(),
      LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
      "run-1",
      "success",
      expect.objectContaining({ checked: 1, updated: 1, failures: 0, skipped: false }),
    );
  });

  it("releases the lease as failed rather than holding it for the whole window", async () => {
    const deps = runnerDependencies({
      runBatch: async () => {
        throw new Error("batch exploded");
      },
    });

    await expect(runner(deps)()).rejects.toThrow("batch exploded");
    expect(deps.finish).toHaveBeenCalledWith(
      expect.anything(),
      LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
      "run-1",
      "failed",
      expect.objectContaining({ reason: "batch exploded" }),
    );
  });

  it("releases the lease when the due-list RPC fails", async () => {
    const deps = runnerDependencies({
      runBatch: async () => ({ kind: "due_list_failed", reason: "rpc_failed" }),
    });

    await expect(runner(deps)()).rejects.toThrow("rpc_failed");
    expect(deps.finish).toHaveBeenCalledWith(
      expect.anything(),
      LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
      "run-1",
      "failed",
      expect.objectContaining({ reason: "rpc_failed" }),
    );
  });
});
