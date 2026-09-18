import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcquisitionEvidencePort } from "../../domains/marketing/research/acquisitionEvidencePorts.js";
import { closeAcquisitionEvidenceBindings, resolveAcquisitionEvidenceBinding } from "./acquisitionEvidenceBinding.js";

const port = (): AcquisitionEvidencePort => ({
  submitSurvey: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
  listSurveys: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
  applyNewsletterConsent: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
  close: vi.fn(async () => undefined),
});

describe("acquisition evidence binding", () => {
  afterEach(() => closeAcquisitionEvidenceBindings());
  it("exists only for a configured direct Postgres bundle", async () => {
    const factory = vi.fn(async () => port());
    await expect(resolveAcquisitionEvidenceBinding({ PLATFORM_BUNDLE: "vercel-supabase", DATABASE_URL: "postgres://unused" }, { portFactory: factory })).resolves.toBeNull();
    await expect(resolveAcquisitionEvidenceBinding({ PLATFORM_BUNDLE: "node-postgres" }, { portFactory: factory })).resolves.toBeNull();
    const binding = await resolveAcquisitionEvidenceBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: " postgres://direct/evidence " }, { portFactory: factory });
    expect(binding).not.toBeNull();
    expect(factory).toHaveBeenCalledWith({ connectionString: "postgres://direct/evidence" });
  });
});
