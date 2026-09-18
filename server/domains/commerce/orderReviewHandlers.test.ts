import { describe, expect, it } from "vitest";
import { createOrderReviewHandlers } from "./orderReviewHandlers.js";

const GRANT = "review-grant:11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);

describe("order review handlers", () => {
  it("keeps missing grants non-enumerating", async () => {
    const handlers = createOrderReviewHandlers({ read: async () => null } as never);
    await expect(handlers.read(GRANT)).resolves.toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("admits an eligible grant before its first review", async () => {
    const handlers = createOrderReviewHandlers({ read: async () => ({ review: null, media: [] }) } as never);
    await expect(handlers.read(GRANT)).resolves.toEqual({ ok: true, value: { review: null, media: [] } });
  });

  it("does not invoke persistence for malformed submit", async () => {
    const handlers = createOrderReviewHandlers({ submit: async () => { throw new Error("called"); } } as never);
    await expect(handlers.submit({ grant: GRANT, rating: 0, fingerprint: DIGEST })).resolves.toEqual({
      ok: false, error: { kind: "invalid" },
    });
  });

  it("returns media intent metadata without clear upload capability", async () => {
    const handlers = createOrderReviewHandlers({
      createMediaIntent: async () => ({
        media: {
          mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222",
          declaredContentType: "image/png", declaredByteLength: 24,
          observedContentType: null, observedByteLength: null, observedDigest: null, state: "pending",
        },
        uploadExpiresAt: "2026-08-16T00:00:00.000Z",
        replayed: false,
      }),
    } as never);
    const result = await handlers.createMediaIntent({
      grant: GRANT, contentType: "image/png", byteLength: 24, capabilityDigest: DIGEST, commandKey: "intent-1",
    });
    expect(result).toMatchObject({ ok: true, value: { replayed: false } });
    expect(JSON.stringify(result)).not.toContain("order-review-upload:");
  });
});
