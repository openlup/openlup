import { afterEach, describe, expect, it, vi } from "vitest";

import type { AcquisitionCasePort } from "../../domains/clients/acquisitionCasePorts.js";
import {
  closeAcquisitionCaseRuntimeBindings,
  resolveAcquisitionCaseRuntimeBinding,
} from "./acquisitionCaseBinding.js";

function port(): AcquisitionCasePort {
  return {
    submit: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    list: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    get: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
    transition: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    activeCount: vi.fn(async () => ({ ok: true as const, value: 0 })),
    close: vi.fn(async () => undefined),
  };
}

describe("acquisition case runtime binding", () => {
  afterEach(() => closeAcquisitionCaseRuntimeBindings());

  it("stays absent outside direct Postgres and without DATABASE_URL", async () => {
    const factory = vi.fn(async () => port());
    await expect(resolveAcquisitionCaseRuntimeBinding({
      PLATFORM_BUNDLE: "vercel-supabase",
      DATABASE_URL: "postgres://unused",
    }, { portFactory: factory })).resolves.toBeNull();
    await expect(resolveAcquisitionCaseRuntimeBinding({
      PLATFORM_BUNDLE: "node-postgres",
    }, { portFactory: factory })).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes only the direct connection string and composes handlers", async () => {
    const adapter = port();
    const factory = vi.fn(async () => adapter);
    const binding = await resolveAcquisitionCaseRuntimeBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: " postgres://direct/acquisition ",
    }, { portFactory: factory });
    expect(factory).toHaveBeenCalledWith({ connectionString: "postgres://direct/acquisition" });
    await expect(binding?.handlers.activeCount()).resolves.toEqual({
      ok: true,
      value: { activeTesterCount: 0 },
    });
    await binding?.close();
    expect(adapter.close).toHaveBeenCalledOnce();
  });
});
