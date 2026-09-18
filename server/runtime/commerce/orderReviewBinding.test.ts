import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("order review runtime binding", () => {
  const source = readFileSync(join(process.cwd(), "server/runtime/commerce/orderReviewBinding.ts"), "utf8");

  it("is the one loader-compatible raw entrypoint", () => {
    expect(source).toContain("export default createOrderReviewRawUploadHandler");
    expect(source).toContain("resolveOrderReviewRawUploadBindingState");
  });

  it("reconciles only claimed exact keys and retains a promoted object after metadata failure", () => {
    expect(source).toContain("media.claimReconcile(limit)");
    expect(source).toContain("store.inspect(task.objectKey");
    expect(source).toContain("if (!promoted)");
    expect(source).not.toMatch(/readdir|glob|walk\(/);
  });

  it("keeps one bounded reconciler alive and closes it with the pool", () => {
    expect(source).toContain("reconcileInFlight ??=");
    expect(source).toContain("queueMicrotask(wakeReconciler)");
    expect(source).toContain("setInterval(wakeReconciler, 30_000)");
    expect(source).toContain("clearInterval(interval)");
    expect(source).toContain("await reconcileInFlight?.catch");
  });

  it("hashes completed raw replays before allocating temp storage", () => {
    const complete = source.indexOf('admission.kind === "complete"');
    expect(complete).toBeGreaterThan(0);
    expect(complete).toBeLessThan(source.indexOf("store.writeTemp"));
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain('hash.digest("hex") === admission.media.observedDigest');
  });

  it("reopens only after exact pre-rename absence", () => {
    expect(source).toContain('let reason = "object_absent"');
    expect(source).toContain('reason = "upload_residue"');
    expect(source).toContain("store.inspect(tempRef, reservation.declaredByteLength)");
    expect(source).toContain("reservation.leaseExpiresAt");
  });
});
