import { describe, expect, it } from "vitest";
import { checkTarballEntries, type TarballEntry } from "./package-tarball-gate.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const entry = { name: "@openlup/core", directory: "packages/core", publish: false };
const manifest = JSON.stringify({ name: "@openlup/core", version: "0.6.0", exports: { "./a": { types: "./dist/a.d.ts", default: "./dist/a.js" } }, dependencies: { zod: "^4.4.3" } });
const tracked: Record<string, string> = { "packages/core/package.json": manifest, "packages/core/README.md": "# Core\n", "packages/core/src/a.ts": "export const a = 1;\n", "packages/core/src/b.tsx": "export const b = 2;\n" };
const readTracked = (path: string) => (path in tracked ? encode(tracked[path] as string) : undefined);
const packed = (extra: Array<[string, string]> = [], base: Array<[string, string]> = [["package.json", manifest], ["README.md", "# Core\n"], ["src/a.ts", "export const a = 1;\n"], ["dist/a.js", "export const a = 1;\n"], ["dist/a.d.ts", "export declare const a = 1;\n"], ["dist/b.js", "export const b = 2;\n"]]): TarballEntry[] => [...base, ...extra].map(([path, text]) => ({ path, bytes: encode(text) }));
const rules = (entries: TarballEntry[]) => checkTarballEntries(entry, entries, readTracked).map(({ rule }) => rule);

describe("tarball gate", () => {
  it("accepts tracked files, built output of tracked sources and the manifest", () => {
    expect(rules(packed())).toEqual([]);
  });
  it("accepts a manifest npm normalised without changing identity or exports", () => {
    const normalised = JSON.stringify({ ...JSON.parse(manifest), gitHead: "abc", readme: "ERROR" });
    expect(rules(packed([], [["package.json", normalised]]))).toEqual([]);
  });
  it("refuses each seeded defect", () => {
    expect(rules(packed([["dist/a.js.map", "{}"]]))).toEqual(["sourcemap"]);
    expect(rules(packed([["notes.txt", "scratch"]]))).toEqual(["unlisted-file"]);
    expect(rules(packed([], [["package.json", manifest], ["README.md", "# Core, edited\n"]]))).toEqual(["changed-file"]);
    expect(rules(packed([["dist/missing.js", "export {};\n"]]))).toEqual(["derived-without-source"]);
    expect(rules(packed([["dist/c.js", `// built in ${["", "Users", "someone", "src"].join("/")}\n`]]))).toEqual(["machine-path", "derived-without-source"]);
    expect(rules(packed([], [["package.json", manifest], ["README.md", `See ${["https://github.com/example", "app"].join("/")}\n`]]))).toEqual(["operational-coordinate", "changed-file"]);
    expect(rules(packed([], [["package.json", JSON.stringify({ ...JSON.parse(manifest), exports: { "./*": "./dist/*.js" } })]]))).toEqual(["manifest"]);
    expect(rules(packed([], [["README.md", "# Core\n"]]))).toEqual(["manifest"]);
    expect(rules(packed([["../escape.js", "x"]]))).toEqual(["path"]);
  });
});
