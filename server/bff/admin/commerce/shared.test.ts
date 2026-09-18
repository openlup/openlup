/**
 * Smoke test for the commerce admin BFF shared helpers.
 *
 * This file exists as a companion test so the CI coverage guard
 * (scripts/assert-changed-runtime-coverage.ts) does not flag the shared module
 * as lacking coverage. The flag readers are thin env-var wrappers; deeper
 * coverage flows through each route's own test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commerceCatalogMutationsEnabled,
  createCommerceAdminReferenceReadComposition,
} from "./shared.js";

afterEach(() => {
  delete process.env.COMMERCE_CATALOG_MUTATIONS_ENABLED;
});

describe("commerce admin shared flag helpers", () => {
  it("commerceCatalogMutationsEnabled returns false when env is unset", () => {
    expect(commerceCatalogMutationsEnabled()).toBe(false);
  });

  it("commerceCatalogMutationsEnabled returns true when env=true", () => {
    process.env.COMMERCE_CATALOG_MUTATIONS_ENABLED = "true";
    expect(commerceCatalogMutationsEnabled()).toBe(true);
  });
});

describe("commerce admin reference read composition", () => {
  function dependencies(authorization: {
    ok: boolean;
    userId?: string;
    role?: "admin";
    isMachineActor?: boolean;
    code?: "FORBIDDEN";
    message?: string;
  }) {
    const service = {
      asActor: vi.fn(),
      asService: vi.fn(async (work) => work({
        rpc: vi.fn(async () => ({ data: null, error: null })),
      })),
    };
    return {
      values: {
        readEnvironment: vi.fn(() => ({
          url: "memory:",
          anonKey: "test",
          serviceRoleKey: "secret",
        })),
        readToken: vi.fn(() => "admin-bearer"),
        createAuthClient: vi.fn(() => "auth-client"),
        authorize: vi.fn(async () => authorization),
        readMachineFlag: vi.fn(() => true),
        bindService: vi.fn(() => service),
      },
      service,
    };
  }

  it("never binds elevated data access before or after an authorization denial", async () => {
    const { values } = dependencies({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
    const composition = createCommerceAdminReferenceReadComposition(
      { headers: {} } as never,
      values as never,
    );

    expect(composition.servicePort()).toBeNull();
    expect(values.bindService).not.toHaveBeenCalled();
    await expect(composition.authorize()).resolves.toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
    expect(composition.servicePort()).toBeNull();
    expect(values.bindService).not.toHaveBeenCalled();
  });

  it("binds one service-only port after authorization and keeps audit access lazy", async () => {
    const { values, service } = dependencies({
      ok: true,
      userId: "machine",
      role: "admin",
      isMachineActor: true,
    });
    const composition = createCommerceAdminReferenceReadComposition(
      { headers: {} } as never,
      values as never,
    );

    await composition.authorize();
    const governance = composition.governance();
    expect(values.readMachineFlag).toHaveBeenCalledOnce();
    expect(values.bindService).not.toHaveBeenCalled();

    const port = composition.servicePort();
    expect(port).not.toBeNull();
    expect("asActor" in port!).toBe(false);
    expect(composition.servicePort()).toBe(port);
    expect(values.bindService).toHaveBeenCalledOnce();
    expect(service.asService).not.toHaveBeenCalled();

    await governance.auditClient.rpc("record", {});
    expect(service.asService).toHaveBeenCalledOnce();
  });
});
