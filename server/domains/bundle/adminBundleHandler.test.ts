/**
 * Companion test for the bundle write handlers.
 *
 * The handler layer owns exactly three things the port contract cannot see: the
 * DB-derived actor-kind gate on the two publish transitions, the pure rule passes
 * that run BEFORE the write, and the envelope shape. Those are what this file
 * asserts. Everything about what the boundary does with a request once it gets
 * there lives in the write-port contract table and is not re-proved here.
 */
import { describe, expect, it, vi } from "vitest";

import type { AdminBundleWritePort } from "./adminBundleWritePort.js";
import {
  createAdminBundleActivateHandler,
  createAdminBundleCreateDraftHandler,
  createAdminBundleSetCompositionHandler,
  type AdminBundleHandlerDeps,
} from "./adminBundleHandler.js";

// Request/response types are DERIVED from the handler the factory returns rather
// than imported from the hosting SDK: the thing under test is the handler's own
// signature, so if that signature moves these follow it, and the file names no
// runtime it does not depend on.
type BundleRouteHandler = ReturnType<typeof createAdminBundleActivateHandler>;
type RouteRequest = Parameters<BundleRouteHandler>[0];
type RouteResponse = Parameters<BundleRouteHandler>[1];

const OK_RESULT = { idempotent: false, dryRun: false, code: "starter-set" };

function createPort(overrides: Partial<AdminBundleWritePort> = {}): AdminBundleWritePort {
  const stub = vi.fn(async () => OK_RESULT);
  return {
    loadCompositionConstraint: vi.fn(async () => null),
    upsertDraft: stub,
    updateDraft: stub,
    setComposition: stub,
    setTargetPrice: stub,
    archive: stub,
    restore: stub,
    cloneDraft: stub,
    activate: stub,
    deactivate: stub,
    ...overrides,
  } as unknown as AdminBundleWritePort;
}

function deps(overrides: Partial<AdminBundleHandlerDeps> = {}): AdminBundleHandlerDeps {
  return {
    writePort: createPort(),
    authorizeAdmin: async () => ({ ok: true, userId: "actor-id", role: "owner", isMachineActor: false }) as never,
    mutationsEnabled: true,
    activationEnabled: true,
    ...overrides,
  };
}

function request(body: unknown, method = "POST"): RouteRequest {
  return { method, body, query: {}, headers: {} } as unknown as RouteRequest;
}

function createResponse(): RouteResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as RouteResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function body(res: RouteResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("bundle write handlers — the publish gate", () => {
  it("refuses a machine actor's publish before the write is ever reached", async () => {
    const writePort = createPort();
    const res = createResponse();

    await createAdminBundleActivateHandler(
      deps({
        writePort,
        authorizeAdmin: async () =>
          ({ ok: true, userId: "agent-id", role: "owner", isMachineActor: true }) as never,
      }),
    )(request({ mode: "commit", code: "starter-set" }), res);

    expect(body(res)).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: "FORBIDDEN" }),
    });
    // The point of the gate: the write was never attempted, not merely rejected.
    expect(writePort.activate).not.toHaveBeenCalled();
  });

  it("lets a human publish, and gates it on the activation flag rather than the mutation flag", async () => {
    const res = createResponse();
    await createAdminBundleActivateHandler(deps({ mutationsEnabled: false }))(
      request({ mode: "commit", code: "starter-set" }),
      res,
    );
    expect(body(res)).toMatchObject({ ok: true });

    const disabled = createResponse();
    await createAdminBundleActivateHandler(deps({ activationEnabled: false }))(
      request({ mode: "commit", code: "starter-set" }),
      disabled,
    );
    expect(body(disabled)).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        details: expect.objectContaining({ featureFlag: "COMMERCE_BUNDLE_ACTIVATION_ENABLED" }),
      }),
    });
  });
});

describe("bundle write handlers — the rule passes that run before the write", () => {
  it("refuses a fulfillment mode no runtime honours, without calling the boundary", async () => {
    const writePort = createPort();
    const res = createResponse();

    await createAdminBundleCreateDraftHandler(deps({ writePort }))(
      request({
        mode: "commit",
        bundle: { code: "kitted-set", title: "Kitted set", fulfillmentMode: "kitted" },
      }),
      res,
    );

    expect(body(res)).toMatchObject({ ok: false });
    expect(writePort.upsertDraft).not.toHaveBeenCalled();
  });

  it("refuses an add-on-only composition before the whole-set replace is attempted", async () => {
    const writePort = createPort();
    const res = createResponse();

    await createAdminBundleSetCompositionHandler(deps({ writePort }))(
      request({
        mode: "commit",
        code: "starter-set",
        components: [{ sku: "UNIT-A", quantity: 1, isAddon: true, sortOrder: 0 }],
      }),
      res,
    );

    expect(body(res)).toMatchObject({ ok: false });
    expect(writePort.setComposition).not.toHaveBeenCalled();
  });

  it("reads the stored constraint and delegates it to the injected rules port", async () => {
    const constraint = { kind: "fixed.catalog", version: 1, data: { slots: 1 } };
    const writePort = createPort({ loadCompositionConstraint: vi.fn(async () => constraint) });
    const validateComposition = vi.fn(async () => ({ ok: false as const, code: "slots_exceeded" }));
    const res = createResponse();

    await createAdminBundleSetCompositionHandler(
      deps({
        writePort,
        compositionRules: { validateComposition, resizeComposition: async () => null },
      }),
    )(
      request({
        mode: "commit",
        code: "starter-set",
        components: [{ sku: "UNIT-A", quantity: 2, isAddon: false, sortOrder: 0 }],
      }),
      res,
    );

    expect(writePort.loadCompositionConstraint).toHaveBeenCalledWith("starter-set");
    expect(validateComposition).toHaveBeenCalledWith(
      expect.objectContaining({ constraint }),
    );
    expect(body(res)).toMatchObject({ ok: false });
    expect(writePort.setComposition).not.toHaveBeenCalled();
  });

  it("writes, and shapes the envelope, once every pre-write rule passes", async () => {
    const writePort = createPort({
      setComposition: vi.fn(async () => ({
        idempotent: false,
        dryRun: true,
        code: "starter-set",
        componentCount: 2,
      })) as never,
    });
    const res = createResponse();

    await createAdminBundleSetCompositionHandler(deps({ writePort }))(
      request({
        mode: "dry_run",
        code: "starter-set",
        components: [
          { sku: "UNIT-A", quantity: 2, isAddon: false, sortOrder: 0 },
          { sku: "UNIT-B", quantity: 1, isAddon: true, sortOrder: 1 },
        ],
      }),
      res,
    );

    expect(writePort.setComposition).toHaveBeenCalledOnce();
    expect(body(res)).toMatchObject({
      ok: true,
      data: expect.objectContaining({ code: "starter-set", componentCount: 2, dryRun: true }),
    });
  });
});
