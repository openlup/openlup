import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { sendStatusEmailInProcess } from "./edgeHandlerRuntimeLoader.js";

describe("DHL status-email binding facade", () => {
  const env = { APP_BASE_URL: "https://example.test" };
  const input = {
    serviceRoleKey: "service-role",
    testerId: "tester-1",
    templateSlug: "shipped",
    source: "create-dhl-shipment",
    env,
    fetchImpl: vi.fn() as never,
  };

  it("keeps a missing private runtime non-throwing after DHL state has completed", async () => {
    await expect(sendStatusEmailInProcess(input)).resolves.toEqual({
      ok: false, status: 503, data: { error: "tester_program_email_unavailable" },
    });
  });

  it("imports only the conditional binding, never the withheld programme", async () => {
    const source = await readFile(new URL("./edgeHandlerRuntimeLoader.ts", import.meta.url), "utf8");

    expect(source).toContain("#tester-program-email-binding");
    expect(source).not.toContain("domains/tester-program");
    expect(source).not.toContain("adapters/supabase/tester-program");
  });
});
