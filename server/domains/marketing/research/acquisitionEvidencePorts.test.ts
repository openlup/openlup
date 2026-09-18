import { describe, expect, it } from "vitest";

import * as acquisitionEvidencePorts from "./acquisitionEvidencePorts.js";
import type {
  AcquisitionEvidencePort,
  AcquisitionEvidenceResult,
} from "./acquisitionEvidencePorts.js";

describe("acquisition evidence port contract", () => {
  it("stays runtime-neutral while remaining an importable domain boundary", () => {
    expect(Object.keys(acquisitionEvidencePorts)).toEqual([]);

    const unavailable: AcquisitionEvidenceResult<never> = {
      ok: false,
      error: { kind: "unavailable" },
    };
    expect(unavailable).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("requires every survey and consent operation on one closeable port", () => {
    const port = {
      submitSurvey: async () => ({ ok: false as const, error: { kind: "invalid" as const } }),
      listSurveys: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
      applyNewsletterConsent: async () => ({ ok: false as const, error: { kind: "conflict" as const } }),
      close: async () => undefined,
    } satisfies AcquisitionEvidencePort;

    expect(Object.keys(port)).toEqual([
      "submitSurvey",
      "listSurveys",
      "applyNewsletterConsent",
      "close",
    ]);
  });
});
