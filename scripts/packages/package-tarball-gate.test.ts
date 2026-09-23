import { describe, expect, it } from "vitest";
import { checkTarballEntries, type TarballEntry } from "./package-tarball-gate.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const entry = { name: "@openlup/core", directory: "packages/core", publish: false };
const manifest = JSON.stringify({ name: "@openlup/core", version: "0.6.0", private: true, exports: { "./a": { types: "./dist/a.d.ts", default: "./dist/a.js" } } });
const tracked: Record<string, string> = { "packages/core/package.json": manifest, "packages/core/README.md": "# Core\n", "packages/core/src/a.ts": "export const a = 1;\n", "packages/core/src/b.tsx": "export const b = 2;\n", "packages/core/src/a.test.ts": "test\n" };
const readTracked = (path: string) => (path in tracked ? encode(tracked[path] as string) : undefined);
const defaults: Array<[string, string]> = [["package.json", manifest], ["README.md", "# Core\n"], ["src/a.ts", "export const a = 1;\n"], ["dist/a.js", "export const a = 1;\n"], ["dist/a.d.ts", "export declare const a = 1;\n"], ["dist/b.js", "export const b = 2;\n"]];
const packed = (extra: Array<[string, string]> = [], replace: Record<string, string | null> = {}): TarballEntry[] => [...defaults.filter(([path]) => replace[path] !== null).map(([path, text]): [string, string] => [path, replace[path] ?? text]), ...extra].map(([path, text]) => ({ path, bytes: encode(text) }));
const rules = (entries: TarballEntry[]) => checkTarballEntries(entry, entries, readTracked).map(({ rule }) => rule);

describe("tarball gate", () => {
  it("accepts tracked files, built output of tracked sources and the tracked manifest", () => {
    expect(rules(packed())).toEqual([]);
  });
  it("refuses a manifest that differs from the tracked one in any byte", () => {
    const withScript = JSON.stringify({ ...JSON.parse(manifest), scripts: { postinstall: "node x.js" } });
    const renamed = JSON.stringify({ ...JSON.parse(manifest), name: "@openlup/other" });
    expect(rules(packed([], { "package.json": withScript }))).toEqual(["manifest"]);
    expect(rules(packed([], { "package.json": renamed }))).toEqual(["manifest"]);
    expect(rules(packed([], { "package.json": null }))).toEqual(["manifest"]);
  });
  it("refuses each seeded defect", () => {
    expect(rules(packed([["dist/a.js.map", "{}"]]))).toEqual(["sourcemap"]);
    expect(rules(packed([], { "dist/a.js": "export const a = 1;\n//# sourceMappingURL=data:application/json;base64,e30=\n" }))).toEqual(["sourcemap"]);
    expect(rules(packed([["notes.txt", "scratch"]]))).toEqual(["unlisted-file"]);
    expect(rules(packed([], { "README.md": "# Core, edited\n" }))).toEqual(["changed-file"]);
    expect(rules(packed([["dist/missing.js", "export {};\n"]]))).toEqual(["derived-without-source"]);
    expect(rules(packed([["dist/a.test.js", "test\n"]]))).toEqual(["test-output"]);
    expect(rules(packed([], { "dist/a.js": `// built in ${["", "Users", "someone", "src"].join("/")}\n` }))).toEqual(["machine-path"]);
    expect(rules(packed([], { "dist/a.js": `// built in ${["", "root", "work"].join("/")}\n` }))).toEqual(["machine-path"]);
    expect(rules(packed([], { "dist/a.js": `"${["C:", "", "Users", "", "someone"].join("\\")}"\n` }))).toEqual(["machine-path"]);
    expect(rules(packed([], { "README.md": `See ${["https://github.com/example", "app"].join("/")}\n` }))).toEqual(["operational-coordinate", "changed-file"]);
    expect(rules(packed([["../escape.js", "x"]]))).toEqual(["path"]);
  });
});
