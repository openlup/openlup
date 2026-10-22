import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createOmnipackClient } from "../../../src/fulfillment/omnipack/client.js";
import { buildOmnipackDispatchCommand } from "../../../src/fulfillment/omnipack/omnipackDispatchPayload.js";
import { candidate, config, jsonResponse } from "./fixtures.js";

it("requests fresh credentials for every HTTP attempt and retains no returned credential object", async () => {
  let generation = 0; let reads = 0;
  const credentials = vi.fn(() => { const current = ++generation; return { username: "example", get password() { reads++; return `placeholder-${current}`; } }; });
  const authorization: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => { authorization.push(new Headers(init?.headers).get("authorization")); return jsonResponse({}, authorization.length === 1 ? 503 : 200); });
  const client = createOmnipackClient({ ...config, credentials }, fetchImpl);
  expect(credentials).not.toHaveBeenCalled();
  await client.getStock(); await client.getProduct("SKU-A");
  expect(credentials).toHaveBeenCalledTimes(3); expect(reads).toBe(3);
  expect(authorization).toEqual([1, 2, 3].map(n => `Basic ${Buffer.from(`example:placeholder-${n}`).toString("base64")}`));
});
it("sends the exact once-materialized bytes whose hash was prepared", async () => {
  const prepared = buildOmnipackDispatchCommand(candidate());
  prepared.providerPayload.shippingDetails.address.name = "Changed after preparation";
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    expect(init?.body).toBe(prepared.body);
    expect(createHash("sha256").update(init!.body as string).digest("hex")).toBe(prepared.requestFingerprint);
    expect(JSON.parse(init!.body as string).shippingDetails.address.name).toBe("Example Recipient");
    return jsonResponse({ orderId: "provider-1" });
  });
  await createOmnipackClient(config, fetchImpl).createOrder(prepared.body); expect(fetchImpl).toHaveBeenCalledOnce();
});
it("has no environment reader, ambient fetch default or import-time transport call", async () => {
  const root = new URL("../../../src/fulfillment/omnipack/", import.meta.url);
  for (const file of readdirSync(root)) {
    const source = readFileSync(new URL(file, root), "utf8");
    expect(source).not.toMatch(/\bprocess\b|\bimport\s*\(|\beval\s*\(|\bglobalThis\b|=\s*fetch\b/);
  }
  vi.resetModules();
  const imported = await import("../../../src/fulfillment/omnipack/client.js");
  const fetchImpl = vi.fn(); const credentials = vi.fn();
  imported.createOmnipackClient({ ...config, credentials }, fetchImpl);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(credentials).not.toHaveBeenCalled();
});
