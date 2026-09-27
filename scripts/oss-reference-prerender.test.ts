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

  it("refuses a deployment manifest before loading SSR code", async () => {
    const root = temp();
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "dist"));
    const manifest = JSON.parse(readFileSync("config/public-reference-site-routes.json", "utf8"));
    manifest.siteLifecycle = "storefront";
    manifest.csrFallback = { exactPaths: ["/account"], routeFamilies: ["/checkout"] };
    const route = manifest.routes[0];
    manifest.routes = Array.from({ length: 79 }, (_, index) => ({
      ...route, path: index === 0 ? "/" : `/fixture-${index}`,
      canonicalPath: index === 0 ? "/" : `/fixture-${index}`,
      id: `${index === 0 ? "pl" : route.locale}:${index === 0 ? "/" : `/fixture-${index}`}`,
      seoKey: `fixture.${index}`, seoPath: ["fixture", String(index)], contentSentinel: `Fixture ${index}`,
      ...(index === 0 ? { locale: "pl", htmlLang: "pl", ogLocale: "pl_PL" } : {}),
    }));
    writeFileSync(join(root, "config", "site-routes.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "dist", "index.html"), "<div id=\"root\"></div>");

    await expect(prerenderPublicReference(root)).rejects.toThrow(/projected public reference/);
  });
});
