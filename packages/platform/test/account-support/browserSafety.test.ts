import { expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

it("bundles contracts for a browser without server modules or ambient loading", async () => {
  const result = await build({ absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)), entryPoints: [new URL("../../src/account-support/contracts/index.ts", import.meta.url).pathname],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
  expect(result.outputFiles[0].text.trim()).toBe("");
  expect(Object.keys(result.metafile!.inputs)).toEqual(["src/account-support/contracts/index.ts"]);
});
