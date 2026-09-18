import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createAdminOrderReviewMediaBffHandler } from "./media.js";

const MEDIA = "order-review-media:123e4567-e89b-12d3-a456-426614174000";
function response() { const out: { status?: number } = {}; const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn((n: number) => { out.status = n; return res; }), json: vi.fn(() => res), write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn() }); return { out, res: res as never, raw: res }; }

describe("admin order review media BFF", () => {
  it("requires a stable idempotency key before physical delete", async () => {
    const remove = vi.fn(); const target = response();
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ deleteAdminMedia: remove } as never),
    })({ method: "DELETE", headers: {}, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.out.status).toBe(400); expect(remove).not.toHaveBeenCalled();
  });

  it("reports cleanup failures as unavailable rather than not found", async () => {
    const target = response();
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ deleteAdminMedia: vi.fn().mockRejectedValue(new Error("disk")) } as never),
    })({ method: "DELETE", headers: { "idempotency-key": "delete:1" }, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.out.status).toBe(503);
  });

  it("reports a concurrent revoke/delete conflict as conflict", async () => {
    const target = response();
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ deleteAdminMedia: vi.fn().mockRejectedValue(
        Object.assign(new Error("order_review_conflict"), { code: "23505" }),
      ) } as never),
    })({ method: "DELETE", headers: { "idempotency-key": "delete:race" }, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.out.status).toBe(409);
  });

  it("never opens pending metadata", async () => {
    const open = vi.fn(); const target = response();
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ authorizeAdminMedia: vi.fn().mockResolvedValue({ media: {
        state: "pending", observedContentType: null, observedByteLength: null, observedDigest: null,
      }, open }) } as never),
    })({ method: "GET", headers: {}, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.out.status).toBe(404); expect(open).not.toHaveBeenCalled();
  });

  it("streams exact observed admin bytes with private headers only", async () => {
    const target = response(); async function* bytes() { yield new Uint8Array([4, 5]); }
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ authorizeAdminMedia: vi.fn().mockResolvedValue({ media: {
        state: "confirmed", observedContentType: "image/webp", observedByteLength: 2, observedDigest: "b".repeat(64),
      }, open: async () => bytes() }) } as never),
    })({ method: "GET", headers: {}, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.raw.setHeader.mock.calls).toEqual(expect.arrayContaining([
      ["Content-Type", "image/webp"], ["Content-Length", "2"], ["Cache-Control", "private, no-store"],
      ["Vary", "Authorization"], ["X-Content-Type-Options", "nosniff"],
    ]));
    expect(target.raw.setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
    expect(target.raw.setHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", expect.anything());
  });

  it("does not accumulate slow-client listeners on the admin stream", async () => {
    const target = response();
    target.raw.write.mockImplementation(() => { queueMicrotask(() => target.raw.emit("drain")); return false; });
    async function* bytes() { for (let index = 0; index < 8; index += 1) yield new Uint8Array([index]); }
    await createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => "admin-1",
      resolveBinding: async () => ({ authorizeAdminMedia: vi.fn().mockResolvedValue({ media: {
        state: "stored", observedContentType: "image/png", observedByteLength: 8, observedDigest: "a".repeat(64),
      }, open: async () => bytes() }) } as never),
    })({ method: "GET", headers: {}, query: { mediaRef: MEDIA } } as never, target.res);
    expect(target.raw.write).toHaveBeenCalledTimes(8);
    expect(target.raw.listenerCount("drain") + target.raw.listenerCount("close") + target.raw.listenerCount("error")).toBe(0);
  });
});
