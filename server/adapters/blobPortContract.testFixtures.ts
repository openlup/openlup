// Shared BlobStoragePort contract (Platform Portability, W5).
//
// The SAME assertion set (upload/exists/delete/list/urlFor) run against every adapter that
// supports real round-trips. The filesystem adapter runs it for real in CI (no creds); the
// in-memory fakes used by the vercel/supabase/s3 adapter tests run it too, so all four backends
// are held to one behavioral spec. `.testFixtures.ts` so the changed-runtime-coverage guard
// ignores it and vitest does not collect it as a standalone suite.

import { describe, expect, it } from "vitest";
import type { BlobStoragePort } from "../../src/domains/platform-runtime/ports.js";

export function runBlobPortContract(label: string, make: () => BlobStoragePort): void {
  describe(`BlobStoragePort contract: ${label}`, () => {
    it("upload returns a url + pathname and the object then exists", async () => {
      const blob = make();
      const result = await blob.upload("pet/contract-a.png", Buffer.from("alpha"), {
        contentType: "image/png",
      });
      expect(typeof result.url).toBe("string");
      expect(result.url.length).toBeGreaterThan(0);
      expect(typeof result.pathname).toBe("string");
      expect(await blob.exists("pet/contract-a.png")).toBe(true);
    });

    it("exists is false for an absent key", async () => {
      const blob = make();
      expect(await blob.exists("pet/never-written.png")).toBe(false);
    });

    it("delete removes the object", async () => {
      const blob = make();
      await blob.upload("pet/contract-del.png", Buffer.from("bye"));
      expect(await blob.exists("pet/contract-del.png")).toBe(true);
      await blob.delete("pet/contract-del.png");
      expect(await blob.exists("pet/contract-del.png")).toBe(false);
    });

    it("list returns keys filtered by prefix", async () => {
      const blob = make();
      await blob.upload("pet/one.png", Buffer.from("1"));
      await blob.upload("pet/two.png", Buffer.from("2"));
      await blob.upload("other/three.png", Buffer.from("3"));
      const all = await blob.list("pet");
      expect(all.keys).toEqual(expect.arrayContaining(["pet/one.png", "pet/two.png"]));
      expect(all.keys).not.toContain("other/three.png");
    });

    it("urlFor is deterministic for a key", () => {
      const blob = make();
      expect(blob.urlFor("pet/x.png")).toBe(blob.urlFor("pet/x.png"));
      expect(blob.urlFor("pet/x.png")).toContain("pet/x.png");
    });
  });
}
