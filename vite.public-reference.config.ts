import { loadEnv, defaultClientConditions, defaultServerConditions, defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "node:fs";

const configDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
const publicReferenceSsrBuild = process.env.OPENLUP_BUILD_TARGET === "public-reference-ssr";
const referenceProfile = process.env.OPENLUP_REFERENCE_PROFILE;
const identityBuild = referenceProfile === "identity";
const subscriptionBuild = referenceProfile === "subscription";
const publicReferenceDocument = `<!doctype html>
<html lang="en"${identityBuild ? ' data-openlup-profile="identity"' : subscriptionBuild ? ' data-openlup-profile="subscription"' : ""}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
    <title>Public reference catalog</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/public-reference/${identityBuild ? "identity-main" : subscriptionBuild ? "subscription-main" : "main"}.tsx"></script>
  </body>
</html>`;

function publicReferenceDocumentPlugin(identityAuth = "managed"): Plugin {
  return { name: "public-reference-document", transformIndexHtml: { order: "pre", handler: () => identityBuild ? publicReferenceDocument.replace('data-openlup-profile="identity"', `data-openlup-profile="identity" data-identity-auth="${identityAuth}"`) : publicReferenceDocument } };
}

/** Refuse every first-party module Vite parses outside the deliberately small public root. */
export function assertPublicReferenceModuleId(id: string, root = configDir, sharedFiles: readonly string[] = []): void {
  const source = id.replace(/\?.*$/, "");
  if (!path.isAbsolute(source) || source.split(path.sep).includes("node_modules")) return;
  const publicRoot = `${path.resolve(root, "src/public-reference")}${path.sep}`;
  const shared = sharedFiles.some((file) => !path.isAbsolute(file) && !file.split("/").includes("..") && path.resolve(root, file) === source);
  if (source !== path.resolve(root, "index.html") && !source.startsWith(publicRoot) && !shared) throw new Error(`Public reference import graph refused first-party module outside declared profile: ${source}`);
}

function publicReferenceGraphGuard(): Plugin {
  const sharedFiles: string[] = identityBuild
    ? JSON.parse(readFileSync(path.resolve(configDir, "config/public-reference-identity-imports.json"), "utf8")).files
    : subscriptionBuild && !publicReferenceSsrBuild
    ? JSON.parse(readFileSync(path.resolve(configDir, "config/public-reference-subscription-imports.json"), "utf8")).files
    : [];
  const check = (id: string) => {
    if (identityBuild) {
      const source = id.replace(/\?.*$/, "");
      if (path.isAbsolute(source) && !source.split(path.sep).includes("node_modules")
        && source !== path.resolve(configDir, "index.html")
        && !sharedFiles.some(file => path.resolve(configDir, file) === source)) throw new Error(`Identity reference import outside closed inventory: ${source}`);
    } else assertPublicReferenceModuleId(id, configDir, sharedFiles);
  };
  return {
    name: "public-reference-import-closure",
    load(id) { check(id); return null; },
    moduleParsed(moduleInfo) { check(moduleInfo.id); },
  };
}

export function publicReferenceViteConfig(mode = "production"): UserConfig {
  const env = loadEnv(mode, configDir, "");
  const publicAuth = (identityBuild || subscriptionBuild) && !publicReferenceSsrBuild ? {
    VITE_SUPABASE_URL: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "",
    VITE_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "",
    VITE_COMMERCE_AUTH_PROVIDER_KIND: env.VITE_COMMERCE_AUTH_PROVIDER_KIND ?? "supabase",
    VITE_COMMERCE_SOCIAL_PROVIDERS: "",
  } : {};
  return {
    appType: "spa",
    publicDir: false,
    envPrefix: [],

    plugins: [{
      name: "public-reference-auth-settings",
      configResolved(config) { Object.assign(config.env, publicAuth); },
    }, publicReferenceGraphGuard(), ...(publicReferenceSsrBuild ? [] : [publicReferenceDocumentPlugin(["postgres", "node-postgres"].includes(publicAuth.VITE_COMMERCE_AUTH_PROVIDER_KIND ?? "") ? "direct" : "managed")]), react()],
    resolve: {
      conditions: [...(publicReferenceSsrBuild ? defaultServerConditions : defaultClientConditions)],
      alias: { "@": path.resolve(configDir, "./src") },
    },
    ssr: { resolve: { conditions: [...defaultServerConditions] } },
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

export default defineConfig(({ mode }): UserConfig => publicReferenceViteConfig(mode));
