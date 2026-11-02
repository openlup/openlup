import { expect, it } from "vitest";
import { build } from "esbuild";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

it("bundles read contracts for a browser with only their own source and zod", async () => {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sourceRoot = realpathSync(resolve(packageRoot, "src/account-support/read-contracts"));
  const zodRoot = realpathSync(dirname(createRequire(import.meta.url).resolve("zod/package.json")));
  const result = await build({ absWorkingDir: packageRoot,
    entryPoints: [resolve(sourceRoot, "index.ts")], bundle: true, platform: "browser",
    format: "esm", write: false, metafile: true });
  const inputs = Object.keys(result.metafile!.inputs).sort();
  console.info("read-contracts browser inputs", JSON.stringify(inputs));
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) {
    const path = realpathSync(resolve(packageRoot, input));
    expect(path.startsWith(`${sourceRoot}${sep}`) || path.startsWith(`${zodRoot}${sep}`),
      `Unexpected browser input: ${input}; full closure: ${JSON.stringify(inputs)}`).toBe(true);
  }
});
