import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createM17ChannelReferenceBinding } from "./m17ChannelBinding.js";

type ManagedInput = Extract<Parameters<typeof createM17ChannelReferenceBinding>[1], { rail: "managed" }>;

it("returns null before accessing disabled host bindings", () => {
  const poison = new Proxy({} as ManagedInput, { get() { throw new Error("binding_read"); } });
  expect(createM17ChannelReferenceBinding(false, poison)).toBeNull();
});
it("keeps portable composition source-only and refuses physical consumption before SQL", async () => {
  const query = vi.fn();
  const bound = createM17ChannelReferenceBinding(true, { rail: "portable", actorId: randomUUID(), executor: { query } });
  if (!bound || bound.rail !== "portable") throw new Error("portable_binding_missing");
  expect(bound.readiness).toEqual({ sourceCapture: true, settledIngest: false, privacyLifecycle: "unavailable", jobs: "unavailable", simulator: false });
  expect(bound).not.toHaveProperty("webhook");
  expect(bound).not.toHaveProperty("recover");
  for (const operation of ["recordCapture", "readCapture", "recordPage", "readPage", "commitPage"] as const) expect(typeof bound.source[operation]).toBe("function");
  await expect(bound.consume()).rejects.toMatchObject({ reason: "channel_purchase_physical_unavailable" });
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValue({ code: "P0001", message: "channel_purchase_physical_unavailable" });
  await expect(bound.source.originalConversion({ ledgerId: randomUUID(), externalLineRef: "line:portable",
    jobRunId: randomUUID(), canonicalText: null })).rejects.toThrow("channel_purchase_physical_unavailable");
});
