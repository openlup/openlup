import { expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

it.each(["index.ts", "contracts/index.ts"])("bundles operations/%s without server or provider imports", async (entry) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../src/operations/${entry}`, import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false,
    treeShaking: false, metafile: true, logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.filter((path) => /operations\/server\/|node:|\/pg\/|@supabase|@aws-sdk/.test(path))).toEqual([]);
});
