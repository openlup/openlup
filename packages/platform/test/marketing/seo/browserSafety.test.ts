import { expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

it("bundles the SEO and content leaves for a browser without imports or ambient loading", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    entryPoints: ["contactLegal.ts", "seo/jsonLd.ts", "seo/metadata.ts", "seo/serializeJsonLd.ts", "seo/urls.ts"]
      .map((file) => new URL(`../../../src/marketing/${file}`, import.meta.url).pathname),
    outdir: "browser-proof",
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).sort()).toEqual([
    "src/marketing/contactLegal.ts",
    "src/marketing/seo/jsonLd.ts",
    "src/marketing/seo/metadata.ts",
    "src/marketing/seo/serializeJsonLd.ts",
    "src/marketing/seo/urls.ts",
  ]);
  for (const output of Object.values(result.metafile!.outputs)) expect(output.imports).toEqual([]);
  for (const output of result.outputFiles) expect(output.text).not.toMatch(/\b(?:process|document|window|require)\b/u);
});
