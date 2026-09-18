import { describe, expect, it, vi } from "vitest";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import {
  createPorts,
  createResponse,
  intent,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

describe("commerce checkout diagnostics", () => {
  it("includes sanitized provisioning diagnostics only for preview smoke", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.persistencePort.persistIntent).mockRejectedValue(
      new Error("duplicate client anna@example.com token=super-secret-value"),
    );

    try {
      await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            details: expect.objectContaining({
              stage: "provision_identity",
              diagnostic: expect.stringContaining("[redacted-email]"),
            }),
          }),
        }),
      );
      const payload = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(JSON.stringify(payload)).not.toContain("anna@example.com");
      expect(JSON.stringify(payload)).not.toContain("super-secret-value");
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("includes sanitized orchestration diagnostics only for preview smoke", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new Error("provider failed for anna@example.com token=secret-value"),
    );

    try {
      await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            details: expect.objectContaining({
              stage: "orchestrate_order",
              diagnosticReason: expect.stringContaining("[redacted-email]"),
            }),
          }),
        }),
      );
      const payload = vi.mocked(res.json).mock.calls.at(-1)?.[0];
      expect(JSON.stringify(payload)).not.toContain("anna@example.com");
      expect(JSON.stringify(payload)).not.toContain("secret-value");
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
