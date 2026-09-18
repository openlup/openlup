import { defaultClientConditions, defaultServerConditions, defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const configDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
const publicReferenceSsrBuild = process.env.OPENLUP_BUILD_TARGET === "public-reference-ssr";
const publicReferenceDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
    <title>Public reference catalog</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/public-reference/main.tsx"></script>
  </body>
</html>`;

function publicReferenceDocumentPlugin(): Plugin {
  return { name: "public-reference-document", transformIndexHtml: { order: "pre", handler: () => publicReferenceDocument } };
}

/** Refuse every first-party module Vite parses outside the deliberately small public root. */
export function assertPublicReferenceModuleId(id: string, root = configDir): void {
  const source = id.replace(/\?.*$/, "");
  if (!path.isAbsolute(source) || source.split(path.sep).includes("node_modules")) return;
  const publicRoot = `${path.resolve(root, "src/public-reference")}${path.sep}`;
  if (source !== path.resolve(root, "index.html") && !source.startsWith(publicRoot)) throw new Error(`Public reference import graph refused first-party module outside src/public-reference: ${source}`);
}

function publicReferenceGraphGuard(): Plugin {
  return {
    name: "public-reference-import-closure",
    load(id) { assertPublicReferenceModuleId(id); return null; },
    moduleParsed(moduleInfo) { assertPublicReferenceModuleId(moduleInfo.id); },
  };
}

export function publicReferenceViteConfig(): UserConfig {
  return {
    appType: "spa",
    publicDir: false,
    envPrefix: [],
    plugins: [publicReferenceGraphGuard(), ...(publicReferenceSsrBuild ? [] : [publicReferenceDocumentPlugin()]), react()],
    resolve: {
      conditions: ["core-source", ...(publicReferenceSsrBuild ? defaultServerConditions : defaultClientConditions)],
      alias: { "@": path.resolve(configDir, "./src") },
    },
    ssr: { resolve: { conditions: ["core-source", ...defaultServerConditions] } },
    build: publicReferenceSsrBuild ? {
      outDir: process.env.OPENLUP_SSR_OUT_DIR ?? "dist-public-reference-ssr",
      emptyOutDir: true,
      ssr: "src/public-reference/entry-server.tsx",
      rollupOptions: { output: { entryFileNames: "entry-server.js" } },
    } : {
      outDir: process.env.OPENLUP_BUILD_OUT_DIR ?? "dist",
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: path.resolve(configDir, "index.html"), output: { entryFileNames: "assets/public-reference-[hash].js" } },
    },
  };
}

export default defineConfig((): UserConfig => publicReferenceViteConfig());
