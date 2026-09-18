import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadSiteRouteManifest } from "./site-routes.mjs";

const DEFAULT_DIST = process.env.OPENLUP_BUILD_OUT_DIR ?? "dist";
const DEFAULT_SSR_ENTRY = `${process.env.OPENLUP_SSR_OUT_DIR ?? "dist-public-reference-ssr"}/entry-server.js`;

type PublicReferenceManifest = {
  siteLifecycle: string;
  siteOrigin: string;
  routes: Array<{ path: string; canonicalPath: string }>;
};

type PrerenderOptions = { distDir?: string; ssrEntry?: string };

function documentFor(template: string, markup: string, canonical: string): string {
  if (!template.includes('<div id="root"></div>')) {
    throw new Error("Public reference client template must contain the neutral root element");
  }
  return template
    .replace("</head>", `    <link rel="canonical" href="${canonical}" />\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
}

function destination(dist: string, routePath: string): string {
  return routePath === "/"
    ? resolve(dist, "index.html")
    : resolve(dist, routePath.slice(1), "index.html");
}

/** Render the explicit public-reference SSG list and nothing inferred from the source application. */
export async function prerenderPublicReference(root = process.cwd(), options: PrerenderOptions = {}) {
  const manifest = loadSiteRouteManifest(root) as PublicReferenceManifest;
  if (manifest.siteLifecycle !== "public-reference") {
    throw new Error("Public reference prerender requires the projected public reference route manifest");
  }
  const dist = resolve(root, options.distDir ?? DEFAULT_DIST);
  const template = readFileSync(resolve(dist, "index.html"), "utf8");
  const entry = resolve(root, options.ssrEntry ?? DEFAULT_SSR_ENTRY);
  const { renderRoute } = await import(pathToFileURL(entry).href) as { renderRoute?: unknown };
  if (typeof renderRoute !== "function") throw new Error("Public reference SSR entry must export renderRoute");

  const written: string[] = [];
  for (const route of manifest.routes) {
    const target = destination(dist, route.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, documentFor(template, renderRoute(route.path), new URL(route.canonicalPath, manifest.siteOrigin).href));
    written.push(target);
  }
  return { manifest, written };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  prerenderPublicReference().then(
    ({ written }) => process.stdout.write(`public reference prerender holds: ${written.length} page(s)\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
