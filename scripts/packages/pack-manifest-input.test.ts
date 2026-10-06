import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPackManifest } from "./pack-manifest-input.ts";

const commit = "a".repeat(40), expected = [{ name: "@openlup/core", version: "0.13.1" }, { name: "@openlup/outbox", version: "0.13.1" }];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pack-manifest-input-")); roots.push(root);
  const packages = expected.map((entry, index) => {
    const bytes = Buffer.from(`synthetic artifact ${index}`), filename = `package-${index}.tgz`;
    writeFileSync(join(root, filename), bytes);
    return { ...entry, filename, sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  });
  const path = join(root, "packages-manifest.json"), manifest = { schemaVersion: 2, commit, packages };
  const save = () => writeFileSync(path, JSON.stringify(manifest)); save();
  return { root, path, manifest, save };
}
describe("supplied artifact identity", () => {
  it("returns the complete exact producer set and actual bytes", () => {
    const f = fixture(), entries = readPackManifest(f.path, commit, expected);
    expect([...entries.keys()]).toEqual(expected.map(({ name }) => name));
    expect(readFileSync(entries.get(expected[0]!.name)!.path, "utf8")).toBe("synthetic artifact 0");
  });
  it.each(["commit", "schema", "unknown", "version", "missing", "duplicate", "escape"])("refuses %s input before a consumer can install", (kind) => {
    const f = fixture();
    if (kind === "commit") f.manifest.commit = "b".repeat(40);
    if (kind === "schema") f.manifest.schemaVersion = 1;
    if (kind === "unknown") Object.assign(f.manifest.packages[0]!, { fallback: "workspace" });
    if (kind === "version") f.manifest.packages[0]!.version = "0.13.0";
    if (kind === "missing") f.manifest.packages.pop();
    if (kind === "duplicate") f.manifest.packages[1] = f.manifest.packages[0]!;
    if (kind === "escape") f.manifest.packages[0]!.filename = "../escape.tgz";
    f.save(); expect(() => readPackManifest(f.path, commit, expected)).toThrow();
  });
  it.each(["bytes", "missing", "symlink", "extra", "sha512"])("refuses %s artifact rather than accepting a plausible manifest", (kind) => {
    const f = fixture(), artifact = join(f.root, f.manifest.packages[0]!.filename);
    if (kind === "bytes") writeFileSync(artifact, "changed");
    if (kind === "missing") rmSync(artifact);
    if (kind === "symlink") { rmSync(artifact); symlinkSync(join(f.root, f.manifest.packages[1]!.filename), artifact); }
    if (kind === "extra") writeFileSync(join(f.root, "workspace.tgz"), "unlisted");
    if (kind === "sha512") { f.manifest.packages[0]!.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`; f.save(); }
    expect(() => readPackManifest(f.path, commit, expected)).toThrow();
  });
});
