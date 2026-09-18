import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureOrderReviewGrantFromLocation,
  createOrderReviewMediaIntent,
  fetchOrderReviewMedia,
  prepareOrderReviewMedia,
  readOrderReview,
  readOrderReviewGrant,
  resetOrderReviewClientStateForTests,
  uploadOrderReviewMedia,
} from "./orderReviewClient.js";

const GRANT = "review-grant:123e4567-e89b-12d3-a456-426614174000";

describe("order review browser capability", () => {
  beforeEach(() => resetOrderReviewClientStateForTests());

  it("captures an exact entry fragment in memory and scrubs it synchronously", () => {
    const history = { state: { marker: true }, replaceState: vi.fn() };
    expect(captureOrderReviewGrantFromLocation({
      pathname: "/review",
      search: "?locale=en",
      hash: `#grant=${GRANT}`,
    }, history)).toBe(GRANT);
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "/review?locale=en",
    );
    expect(readOrderReviewGrant()).toBe(GRANT);
  });

  it.each(["#grant=bad", "#anchor", "#grant="])("scrubs invalid entry fragment %s", (hash) => {
    const replaceState = vi.fn();
    expect(captureOrderReviewGrantFromLocation({
      pathname: "/recenzja",
      search: "",
      hash,
    }, { state: null, replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/recenzja");
  });

  it("does not touch an unrelated route anchor or overwrite the grant", () => {
    const replaceState = vi.fn();
    captureOrderReviewGrantFromLocation({ pathname: "/review", search: "", hash: `#grant=${GRANT}` }, { state: null, replaceState });
    replaceState.mockClear();
    expect(captureOrderReviewGrantFromLocation({ pathname: "/psy/test", search: "", hash: "#details" }, { state: null, replaceState })).toBe(GRANT);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("keeps the upload capability in a header and sends bytes to the literal raw path", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await uploadOrderReviewMedia("upload-capability", bytes, { fetcher });
    expect(fetcher).toHaveBeenCalledWith("/api/feedback-event", expect.objectContaining({
      method: "PUT",
      body: bytes,
      headers: { Authorization: "Bearer upload-capability", "Content-Type": "image/png" },
    }));
    expect(JSON.stringify(fetcher.mock.calls[0])).not.toContain("?upload-capability");
  });

  it("returns null for an eligible grant before its first review", async () => {
    captureOrderReviewGrantFromLocation({ pathname: "/review", search: "", hash: `#grant=${GRANT}` }, { state: null, replaceState: vi.fn() });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { review: null, media: [] } }), { status: 200 }));
    await expect(readOrderReview({ fetcher })).resolves.toBeNull();
  });

  it("mints one in-memory capability and sends only its digest on exact intent retries", async () => {
    captureOrderReviewGrantFromLocation({ pathname: "/review", search: "", hash: `#grant=${GRANT}` }, { state: null, replaceState: vi.fn() });
    const uuids = [
      "123e4567-e89b-12d3-a456-426614174001",
      "123e4567-e89b-12d3-a456-426614174002",
      "123e4567-e89b-12d3-a456-426614174003",
    ];
    const prepared = await prepareOrderReviewMedia(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      { randomUUID: vi.fn(() => uuids.shift()! as `${string}-${string}-${string}-${string}-${string}`), subtle: crypto.subtle },
    );
    expect(prepared.uploadCapability).toBe("order-review-upload:123e4567-e89b-12d3-a456-426614174001");
    const result = {
      media: {
        mediaRef: "order-review-media:123e4567-e89b-12d3-a456-426614174000",
        declaredContentType: "image/png",
        declaredByteLength: 3,
        observedContentType: null,
        observedByteLength: null,
        observedDigest: null,
        state: "pending",
      },
      uploadExpiresAt: "2026-08-16T12:00:00Z",
      replayed: false,
    };
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { result } }), { status: 200 }));
    await createOrderReviewMediaIntent(prepared, { fetcher });
    await createOrderReviewMediaIntent(prepared, { fetcher });
    const bodies = fetcher.mock.calls.map((call) => String(call[1]?.body));
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toContain(prepared.capabilityDigest);
    expect(bodies[0]).not.toContain(prepared.uploadCapability);
    expect(bodies.join("\n")).not.toContain(GRANT);
    expect(fetcher.mock.calls.every((call) => !String(call[0]).includes(GRANT))).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${GRANT}` } });
  });

  it("fetches protected bytes with the memory grant and no capability URL", async () => {
    captureOrderReviewGrantFromLocation({ pathname: "/review", search: "", hash: `#grant=${GRANT}` }, { state: null, replaceState: vi.fn() });
    const blob = new Blob(["image"], { type: "image/webp" });
    const fetcher = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }));
    await expect(fetchOrderReviewMedia("order-review-media:123e4567-e89b-12d3-a456-426614174000", { fetcher })).resolves.toEqual(blob);
    expect(fetcher.mock.calls[0]?.[0]).not.toContain(GRANT);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${GRANT}` } });
  });
});
