import { describe, expect, it } from "vitest";
import { createPostgresOrderReviewMediaPort } from "./orderReviewMedia.js";

const DIGEST = "a".repeat(64);

describe("postgres order review media", () => {
  it("does not expose a byte or filesystem interface", async () => {
    const port = createPostgresOrderReviewMediaPort({ query: async () => ({ rows: [{ response: { tasks: [] } }] }) });
    await expect(port.claimReconcile(10)).resolves.toEqual([]);
    expect("open" in port).toBe(false);
  });

  it("claims only exact bounded reconcile keys and fences completion by receipt", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const port = createPostgresOrderReviewMediaPort({ query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ response: sql.includes("claim_media") ? { tasks: [{ receipt: "receipt-1", kind: "delete", objectKey: "review/opaque", expectedDeclaredContentType: "image/png", expectedDeclaredByteLength: 24 }] } : { ok: true } }] };
    } });
    await expect(port.claimReconcile(1)).resolves.toMatchObject([{ receipt: "receipt-1", objectKey: "review/opaque" }]);
    await port.completeReconcile({ receipt: "receipt-1", outcome: { kind: "deleted" } });
    expect(calls[1]!).toMatchObject({ sql: expect.stringContaining("complete_media"), values: ["receipt-1", "deleted", null, null, null, null] });
  });

  it("admits raw ingress by digest only and returns an internal object key", async () => {
    const calls: unknown[][] = [];
    const port = createPostgresOrderReviewMediaPort({
      query: async (_sql, values) => {
        calls.push(values ?? []);
        return { rows: [{ response: {
          media: { mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222", declaredContentType: "image/png", declaredByteLength: 24, observedContentType: null, observedByteLength: null, observedDigest: null, state: "pending" },
          leaseVersion: 1, leaseExpiresAt: "2026-08-16T00:00:00.000Z", objectKey: "review/opaque", declaredContentType: "image/png", declaredByteLength: 24,
        } }] };
      },
    });
    await expect(port.admitUpload({ capabilityDigest: DIGEST, declaredContentType: "image/png", declaredByteLength: 24, writerRef: "node:one" })).resolves.toMatchObject({
      kind: "lease", reservation: { objectKey: "review/opaque" },
    });
    expect(calls[0]!).toEqual([DIGEST, "image/png", 24, "node:one"]);
  });

  it("distinguishes unavailable, live-lease conflict, and completed replay", async () => {
    const input = { capabilityDigest: DIGEST, declaredContentType: "image/png" as const, declaredByteLength: 24, writerRef: "node:one" };
    const unavailable = createPostgresOrderReviewMediaPort({ query: async () => ({ rows: [{ response: null }] }) });
    await expect(unavailable.admitUpload(input)).resolves.toEqual({ kind: "unavailable" });
    const conflict = createPostgresOrderReviewMediaPort({ query: async () => { throw Object.assign(new Error("live lease"), { code: "order_review_conflict" }); } });
    await expect(conflict.admitUpload(input)).resolves.toEqual({ kind: "conflict" });
    const complete = createPostgresOrderReviewMediaPort({ query: async () => ({ rows: [{ response: { kind: "complete", media: {
      mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222", declaredContentType: "image/png", declaredByteLength: 24,
      observedContentType: "image/png", observedByteLength: 24, observedDigest: DIGEST, state: "stored",
    } } }] }) });
    await expect(complete.admitUpload(input)).resolves.toMatchObject({ kind: "complete", media: { observedDigest: DIGEST } });
  });

  it("persists cleanup after a promote failure rolls back the finalize transaction", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const executor = { query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [{ response: sql.includes("lock_media") ? {
        media: { mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222", declaredContentType: "image/png", declaredByteLength: 24, observedContentType: null, observedByteLength: null, observedDigest: null, state: "pending" },
      } : { reconciled: 0 } }] };
    } };
    const port = createPostgresOrderReviewMediaPort(executor, { run: async (work) => work(executor) });
    await expect(port.finalizeUpload({ capabilityDigest: DIGEST, writerRef: "node:one", leaseVersion: 1, digest: DIGEST, byteLength: 24, promote: async () => { throw new Error("rename failed"); } })).rejects.toThrow("rename failed");
    expect(calls.at(-1)).toMatchObject({ sql: expect.stringContaining("abort_media"), values: [DIGEST, "node:one", 1, "finalize_failed"] });
  });
});
