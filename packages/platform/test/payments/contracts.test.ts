import { expect, it } from "vitest";
import * as contracts from "@openlup/platform/payments/contracts";
import { rolldown } from "rolldown";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

it("keeps the published contracts type-only within the 32 byte browser budget", async () => {
  expect(Object.keys(contracts)).toEqual([]);
  const bundle = await rolldown({
    input: fileURLToPath(new URL("../../dist/payments/contracts/index.js", import.meta.url)),
    platform: "browser",
    onLog(_level, log) { throw new Error(log.message); },
  });
  try {
    const { output } = await bundle.generate({ format: "es", minify: true, inlineDynamicImports: true });
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("chunk");
    if (output[0].type !== "chunk") throw new Error("Expected one browser chunk");
    expect(gzipSync(output[0].code).length).toBeLessThanOrEqual(32);
  } finally { await bundle.close(); }
});
