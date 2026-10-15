// Shared BlobStoragePort contract (Platform Portability, W5).
//
// The SAME assertion set (upload/exists/delete/list/urlFor) run against every adapter that
// supports real round-trips. The filesystem adapter runs it for real in CI (no creds); the
// in-memory fakes used by the vercel/supabase/s3 adapter tests run it too, so all four backends
// are held to one behavioral spec. `.testFixtures.ts` so the changed-runtime-coverage guard
// ignores it and vitest does not collect it as a standalone suite.

import { describe, expect, it } from "vitest";
import type { BlobStoragePort } from "@openlup/core/platform-runtime";

export function runBlobPortContract(label: string, make: () => BlobStoragePort): void {
  describe(`BlobStoragePort contract: ${label}`, () => {
    it("upload returns a url + pathname and the object then exists", async () => {
      const blob = make();
      const result = await blob.upload("objects/contract-a.png", Buffer.from("alpha"), {
        contentType: "image/png",
      });
      expect(typeof result.url).toBe("string");
      expect(result.url.length).toBeGreaterThan(0);
      expect(typeof result.pathname).toBe("string");
      expect(await blob.exists("objects/contract-a.png")).toBe(true);
    });

    it("exists is false for an absent key", async () => {
      const blob = make();
      expect(await blob.exists("objects/never-written.png")).toBe(false);
    });

    it("delete removes the object", async () => {
      const blob = make();
      await blob.upload("objects/contract-del.png", Buffer.from("bye"));
      expect(await blob.exists("objects/contract-del.png")).toBe(true);
      await blob.delete("objects/contract-del.png");
      expect(await blob.exists("objects/contract-del.png")).toBe(false);
    });

    it("list returns keys filtered by prefix", async () => {
      const blob = make();
      await blob.upload("objects/one.png", Buffer.from("1"));
      await blob.upload("objects/two.png", Buffer.from("2"));
      await blob.upload("other/three.png", Buffer.from("3"));
      const all = await blob.list("objects");
      expect(all.keys).toEqual(expect.arrayContaining(["objects/one.png", "objects/two.png"]));
      expect(all.keys).not.toContain("other/three.png");
    });

    it("urlFor is deterministic for a key", () => {
      const blob = make();
      expect(blob.urlFor("objects/x.png")).toBe(blob.urlFor("objects/x.png"));
      expect(blob.urlFor("objects/x.png")).toContain("objects/x.png");
    });
  });
}
