import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prerenderPublicReference } from "./oss-reference-prerender.ts";

const scratch: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "public-reference-prerender-"));
  scratch.push(root);
  return root;
};

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public reference prerender", () => {
  it("writes each declared list/detail page with its own canonical and SSR sentinel", async () => {
    const root = temp();
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "ssr"));
    writeFileSync(join(root, "config", "site-routes.json"), readFileSync("config/public-reference-site-routes.json", "utf8"));
    writeFileSync(join(root, "dist", "index.html"), "<html><head></head><body><div id=\"root\"></div></body></html>");
    writeFileSync(join(root, "ssr", "entry-server.js"), "export const renderRoute = (path) => `<main><h1>${path === '/' ? 'Reference collection' : 'Field notes'}</h1></main>`;\n");

    const result = await prerenderPublicReference(root, { distDir: "dist", ssrEntry: "ssr/entry-server.js" });

    expect(result.written).toHaveLength(2);
    expect(readFileSync(join(root, "dist", "index.html"), "utf8")).toContain('href="https://reference.invalid/"');
    const detail = readFileSync(join(root, "dist", "items", "field-notes", "index.html"), "utf8");
    expect(detail).toContain('href="https://reference.invalid/items/field-notes"');
    expect(detail).toContain("Field notes");
  });

  it("refuses the source deployment manifest rather than silently prerendering its 79 routes", async () => {
    const root = temp();
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "config", "site-routes.json"), readFileSync("config/site-routes.json", "utf8"));
    writeFileSync(join(root, "dist", "index.html"), "<div id=\"root\"></div>");

    await expect(prerenderPublicReference(root)).rejects.toThrow(/projected public reference/);
  });
});
