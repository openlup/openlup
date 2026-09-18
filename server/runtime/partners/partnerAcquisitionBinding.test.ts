import { afterEach, describe, expect, it, vi } from "vitest";
import type { PartnerAcquisitionPort } from "../../../src/domains/partners/ports.js";
import {
  closePartnerAcquisitionBindings,
  resolvePartnerAcquisitionBinding,
} from "./partnerAcquisitionBinding.js";

function port(): PartnerAcquisitionPort {
  return {
    submit: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    list: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    transition: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    close: vi.fn(async () => undefined),
  };
}

describe("partner acquisition binding", () => {
  afterEach(() => closePartnerAcquisitionBindings());

  it("stays absent outside direct Postgres and without DATABASE_URL", async () => {
    const factory = vi.fn(async () => port());
    await expect(resolvePartnerAcquisitionBinding({
      PLATFORM_BUNDLE: "vercel-supabase", DATABASE_URL: "postgres://unused",
    }, { portFactory: factory })).resolves.toBeNull();
    await expect(resolvePartnerAcquisitionBinding({
      PLATFORM_BUNDLE: "node-postgres",
    }, { portFactory: factory })).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes only the direct connection string and closes the port", async () => {
    const adapter = port();
    const factory = vi.fn(async () => adapter);
    const binding = await resolvePartnerAcquisitionBinding({
      PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: " postgres://direct/partners ",
    }, { portFactory: factory });
    expect(binding).toBe(adapter);
    expect(factory).toHaveBeenCalledWith({ connectionString: "postgres://direct/partners" });
    await closePartnerAcquisitionBindings();
    expect(adapter.close).not.toHaveBeenCalled();
  });
});
