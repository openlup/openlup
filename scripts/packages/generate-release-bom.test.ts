import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateReleaseBom } from "./generate-release-bom.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve(".context/scratch/release-bom"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  git(["init", "--initial-branch=main"]);
  const packages = ["core", "outbox"].map(name => ({ name: `@openlup/${name}`, directory: `packages/${name}`, publish: true }));
  put("config/openlup-packages.json", { schemaVersion: 2, packages, unreleased: [] });
  for (const pkg of packages) put(`${pkg.directory}/package.json`, { name: pkg.name, version: "0.36.0", license: "Apache-2.0" });
  git(["add", "."]);
  git(["-c", "user.name=Synthetic BOM test", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic package inventory"]);
  const commit = git(["rev-parse", "HEAD"]);
  const artifacts = packages.map((pkg, index) => {
    const filename = `synthetic-${index}.tgz`, bytes = `Synthetic artifact bytes ${index}`;
    put(`packs/${filename}`, bytes);
    return { name: pkg.name, version: "0.36.0", filename, sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  });
  const manifest = { schemaVersion: 2, commit, packages: artifacts };
  const manifestPath = join(root, "packs/packages-manifest.json");
  const save = () => put("packs/packages-manifest.json", manifest); save();
  return { root, put, commit, manifest, manifestPath, save };
}

describe("release-set BOM", () => {
  it("binds verified artifact bytes and the committed source inventory, excluding host paths", () => {
    const f = fixture();
    const bom = generateReleaseBom(f.root, f.manifestPath, f.commit);
    expect(bom.packages).toHaveLength(2);
    expect(bom.packages[0]!.artifact.sha256).toBe(f.manifest.packages[0]!.sha256);
    expect(bom.source.commit).toBe(f.commit);
    const cli = resolve(import.meta.dirname, "generate-release-bom-cli.ts");
    const output = execFileSync(process.execPath, ["--experimental-strip-types", cli, f.manifestPath, f.commit], { cwd: f.root, encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(output)).toEqual(bom);
    expect(JSON.stringify(bom)).not.toContain(f.root);
    f.put("packages/core/package.json", { name: "@openlup/core", version: "0.99.0" });
    expect(generateReleaseBom(f.root, f.manifestPath, f.commit)).toEqual(bom);
  });

  it.each(["altered", "omitted", "wrong-version", "wrong-commit"])("refuses %s artifact evidence", kind => {
    const f = fixture();
    if (kind === "altered") f.put(`packs/${f.manifest.packages[0]!.filename}`, "Changed artifact");
    if (kind === "omitted") f.manifest.packages.pop();
    if (kind === "wrong-version") f.manifest.packages[0]!.version = "0.35.0";
    if (kind === "wrong-commit") f.manifest.commit = "a".repeat(40);
    f.save();
    expect(() => generateReleaseBom(f.root, f.manifestPath, f.commit)).toThrow(/pack-manifest/u);
  });

  it("keeps the retained reference identity out of tarballs, public docs and tracked starter files", () => {
    const root = resolve(import.meta.dirname, "../..");
    const reference = readFileSync(join(root, "server/adapters/localReferenceStoreAdapter.ts"), "utf8");
    const sku = /canonicalSku:\s*"([^"\n]+)"/u.exec(reference)?.[1];
    if (!sku) throw new Error("reference identity guard: canonical SKU declaration missing");
    const reject = (path: string, bytes: Buffer) => {
      if (path.includes(sku) || bytes.includes(sku)) throw new Error(`reference identity guard: retained SKU reached ${path}`);
    };
    for (const carrier of ["tarball", "docs", "starter"]) {
      expect(() => reject(`${carrier}/synthetic`, Buffer.from(sku))).toThrow(/retained SKU reached/u);
      expect(() => reject(`${carrier}/${sku}`, Buffer.from("neutral"))).toThrow(/retained SKU reached/u);
    }
    const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).split("\0")
      .filter(path => /\.md$/iu.test(path) || path.startsWith("docs/") || path.startsWith("examples/neutral-store/"));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const absolute = join(root, path);
      if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`reference identity guard: nonordinary carrier ${path}`);
      reject(path, readFileSync(absolute));
    }
    // Root test prerequisites build these packages. Pack their real allowlists
    // without lifecycle scripts; inspect payload bytes as well as member paths.
    const scratch = resolve(".context/scratch/release-bom");
    mkdirSync(scratch, { recursive: true });
    const packs = mkdtempSync(join(scratch, "neutral-packs-")); roots.push(packs);
    const inventory = JSON.parse(readFileSync(join(root, "config/openlup-packages.json"), "utf8")) as { packages: { name: string; directory: string; publish: boolean }[] };
    const packages = inventory.packages.filter(pkg => pkg.publish);
    expect(packages.length).toBeGreaterThan(0);
    for (const pkg of packages) {
      const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packs], { cwd: join(root, pkg.directory), encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const [artifact] = JSON.parse(output) as { filename: string }[];
      const path = join(packs, artifact!.filename);
      reject(pkg.name, execFileSync("tar", ["-tzf", path], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }));
      reject(pkg.name, execFileSync("tar", ["-xOf", path], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }));
    }
  }, 120_000);

});
