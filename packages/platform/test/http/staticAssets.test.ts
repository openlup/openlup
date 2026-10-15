import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDistStaticReader } from "../../src/http/staticAssets.js";

describe("distribution static reader", () => {
  async function fixture(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(process.cwd(), ".static-reader-"));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
  }

  it("reads file bytes with their content type and refuses traversal, missing files and directories", async () => {
    await fixture(async (root) => {
      const dist = join(root, "dist");
      await mkdir(join(dist, "assets"), { recursive: true });
      await writeFile(join(root, "outside.txt"), "outside");
      await writeFile(join(dist, "assets", "app.js"), "export default 42;");
      const reader = createDistStaticReader(dist);
      expect(await reader.read("/assets/app.js")).toEqual({ body: Buffer.from("export default 42;"), contentType: "text/javascript; charset=utf-8" });
      expect(await reader.read("/../outside.txt")).toBeNull();
      expect(await reader.read("../../outside.txt")).toBeNull();
      expect(await reader.read("/missing.js")).toBeNull();
      expect(await reader.read("/assets")).toBeNull();
    });
  });

  it("prefers the separate SPA fallback document over the home document", async () => {
    await fixture(async (root) => {
      await writeFile(join(root, "index.html"), "<home/>");
      await writeFile(join(root, "spa-fallback.html"), "<shell/>");
      expect(await createDistStaticReader(root).readIndex()).toEqual({ body: Buffer.from("<shell/>"), contentType: "text/html; charset=utf-8" });
    });
  });

  it("uses index.html when no separate fallback document exists", async () => {
    await fixture(async (root) => {
      await writeFile(join(root, "index.html"), "<shell/>");
      expect(await createDistStaticReader(root).readIndex()).toEqual({ body: Buffer.from("<shell/>"), contentType: "text/html; charset=utf-8" });
    });
  });

  it("propagates failure when neither fallback document exists", async () => {
    await fixture(async (root) => {
      await expect(createDistStaticReader(root).readIndex()).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
