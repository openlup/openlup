import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import handler from "./dhl-create-shipment.js";

describe("DHL create shipment BFF route adapter", () => {
  it("refuses before constructing a standalone DHL port", async () => {
    const source = await readFile(new URL("./dhl-create-shipment.ts", import.meta.url), "utf8");
    expect(source).toContain("refuseRetiredDirectDhlAction");
    expect(source).not.toContain("createDhlCreateShipmentPort");
  });

  it("keeps the POST-only route guard without resolving provider dependencies", async () => {
    const response = captureResponse();
    await handler({ method: "GET", headers: {}, query: {} } as never, response as never);
    expect(response.statusCode).toBe(405);
    expect(response.allow).toBe("POST");
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
