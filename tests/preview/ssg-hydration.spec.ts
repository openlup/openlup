// The built public-reference shell hydrates its prerendered documents without a mismatch: every
// SSG route in the projected manifest is served as the document the prerenderer wrote, the client
// entry attaches to that markup, and the markup is unchanged after hydration with no page error.
// The documents are read from the preview server, so they come from the build it serves.
// Run after `npm run build` with `npx playwright test -c playwright.ssg.config.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

type ManifestRoute = { path: string; delivery: string; canonicalPath: string; contentSentinel: string };

const ROOT = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "config/public-reference-site-routes.json"), "utf8")) as {
  siteOrigin: string;
  routes: ManifestRoute[];
};
const ssgRoutes = manifest.routes.filter((route) => route.delivery === "ssg");

/** The prerendered file for a route, as the preview server serves it from the build directory. */
function documentPath(path: string): string {
  return path === "/" ? "/index.html" : `${path}/index.html`;
}

function rootMarkup(html: string): string {
  const match = /<div id="root">([\s\S]*)<\/div>\s*<\/body>/.exec(html);
  if (!match) throw new Error("prerendered document has no root element");
  return match[1]!;
}

test("the manifest declares SSG routes to prove", () => {
  expect(ssgRoutes.length).toBeGreaterThan(0);
});

for (const route of ssgRoutes) {
  test(`hydrates the prerendered ${route.path} without a mismatch`, async ({ page, request, baseURL }) => {
    const served = await request.get(documentPath(route.path));
    expect(served.status()).toBe(200);
    const html = await served.text();
    const serverMarkup = rootMarkup(html);
    expect(serverMarkup).toContain(route.contentSentinel);
    expect(html).toContain(`<link rel="canonical" href="${new URL(route.canonicalPath, manifest.siteOrigin).href}" />`);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route(new URL(route.path, baseURL).href, (request) =>
      request.fulfill({ status: 200, contentType: "text/html", body: html }));

    await page.goto(route.path);
    await page.waitForFunction(() => {
      const root = document.getElementById("root");
      return root !== null && Object.keys(root).some((key) => key.startsWith("__reactContainer$"));
    });
    await page.waitForLoadState("networkidle");

    expect(await page.locator("#root").innerHTML()).toBe(serverMarkup);
    expect(errors).toEqual([]);
  });
}
