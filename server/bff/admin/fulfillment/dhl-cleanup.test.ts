import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapLegacyCleanupDhlResponse } from "../../../adapters/dhl/cleanupAdapter.js";
import handler from "./dhl-cleanup.js";

describe("admin DHL cleanup BFF route adapters", () => {
  it("retires remote cleanup before constructing a standalone DHL port", async () => {
    const source = await readFile(new URL("./dhl-cleanup.ts", import.meta.url), "utf8");
    expect(source).toContain("refuseRetiredDirectDhlAction");
    expect(source).not.toContain("createDhlCleanupPort");
  });

  it("keeps the POST-only route guard without resolving provider dependencies", async () => {
    const response = captureResponse();
    await handler({ method: "GET", headers: {}, query: {} } as never, response as never);
    expect(response.statusCode).toBe(405);
    expect(response.allow).toBe("POST");
  });

  it("maps legacy cleanup response into the BFF contract", () => {
    expect(
      mapLegacyCleanupDhlResponse({
        dhl_deleted: true,
        dhl_error: "already removed",
        label_deleted: true,
      }),
    ).toEqual({
      dhlDeleted: true,
      dhlError: "already removed",
      labelDeleted: true,
      canProceed: true,
    });
  });
});

function captureResponse() {
  return {
    statusCode: 200,
    allow: "",
    setHeader(name: string, value: string) { if (name === "Allow") this.allow = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
}
