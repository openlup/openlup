import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateExactSetReleaseBom, generateReleaseBom } from "./generate-release-bom.ts";
import { qualifyReleasedSet } from "./exact-set-qualification.mjs";

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
  return { root, put, git, commit, manifest, manifestPath, save };
}

function exactFixture(schema = true, major = 16) {
  const f = fixture(), application = join(f.root, "application"), digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const paths = [".dockerignore", ".npmrc", "Dockerfile", "compose.yaml", "installation/install.ts", "lifecycle.mjs", "package.json"];
  f.put("examples/neutral-store/ownership.json", { owned: [], managed: paths });
  if (schema) f.put("packages/outbox/sql/manifest.json", { schemaVersion: 1, migrations: [{ file: "first.sql", sha256: "a".repeat(64) }, { file: "second.sql", sha256: "b".repeat(64) }] });
  f.git(["add", "examples", "packages"]);
  f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "BOM inputs"]);
  const commit = f.git(["rev-parse", "HEAD"]), packages = f.manifest.packages.map(({ name, version, integrity }) => ({ name, version, integrity, verificationSource: "npm audit signatures --json --include-attestations", provenanceSha256: digest(name) }));
  for (const pkg of packages) f.put(`application/node_modules/${pkg.name}/package.json`, { name: pkg.name, version: pkg.version });
  if (schema) f.put("application/node_modules/@openlup/outbox/sql/manifest.json", readFileSync(join(f.root, "packages/outbox/sql/manifest.json"), "utf8"));
  for (const path of paths) f.put(`application/${path}`, path === "compose.yaml" ? `image: postgres:${major}@sha256:` + "a".repeat(64) : path === "installation/install.ts" ? "generation: 'qualified-v2'" : path);
  f.put("application/package-lock.json", { packages: Object.fromEntries(packages.map(pkg => [`node_modules/${pkg.name}`, pkg])) });
  const extraction = { schemaVersion: 2, mode: "released", setVersion: "0.36.0", sourceRevision: commit, contentSha256: digest(JSON.stringify(paths.sort().map(path => [path, digest(readFileSync(join(application, path)))]))), lockfileSha256: digest(readFileSync(join(application, "package-lock.json"))) };
  f.put("application/.starter-origin.json", extraction);
  const evidence = { setVersion: "0.36.0", tag: "openlup-core-v0.36.0", tagCommit: commit, packages, extraction };
  return { ...f, application, evidence, bom: () => generateExactSetReleaseBom(f.root, application, evidence) };
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
    expect(output).toBe(JSON.stringify(bom, null, 2) + "\n");
    expect(JSON.stringify(bom)).not.toContain(f.root);
    f.put("packages/core/package.json", { name: "@openlup/core", version: "0.99.0" });
    expect(generateReleaseBom(f.root, f.manifestPath, f.commit)).toEqual(bom);
  });

  it("binds the exact set deterministically, preserving catalogue order without circular receipt inputs", () => {
    const f = exactFixture(), bom = f.bom();
    expect(bom).toMatchObject({ formatVersion: 2, tagCommit: f.evidence.tagCommit, starter: { mode: "released", contentSha256: f.evidence.extraction.contentSha256, lockfileSha256: f.evidence.extraction.lockfileSha256 }, composition: { postgresMajor: 16 }, schemaCatalogue: { entries: [{ position: 0, path: "@openlup/outbox/sql/manifest.json" }] } });
    f.evidence.packages.reverse();
    Object.assign(f.evidence, { bom: { sha256: "f".repeat(64) }, endedAt: "ignored final receipt data" });
    expect(JSON.stringify(f.bom())).toBe(JSON.stringify(bom));
    expect(JSON.stringify(bom)).not.toMatch(/receipt|endedAt|application\/|images|sboms/u);
    expect(bom.verificationSha256).toBe(createHash("sha256").update(JSON.stringify(bom.packages)).digest("hex"));
  });

  it("keeps a failed BOM attempt failed and removes a stale final digest", () => {
    const f = exactFixture(), path = join(f.root, "receipt.json");
    f.put("receipt.json", { ...f.evidence, result: "FAIL", upgrade: { result: "PASS" }, schemaUpgrade: { result: "PASS" }, bom: { sha256: "stale" } });
    expect(() => qualifyReleasedSet(f.evidence.tag, "wrong", path, false, false, true)).toThrow("qualification_incomplete_or_mismatched");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ result: "FAIL", endedAt: expect.any(String) });
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("bom");
  });

  it.each(["set", "source", "missing", "extra", "substituted", "verification", "integrity", "schema", "schema-missing", "schema-extra", "catalogue", "profile", "starter", "content", "lock"])("refuses exact-set %s substitution", kind => {
    const f = exactFixture(kind !== "catalogue", kind === "profile" ? 17 : 16); let refusal = "starter_identity_mismatch";
    if (kind === "set") { f.evidence.tagCommit = "short"; refusal = "set_identity_mismatch"; }
    if (kind === "source") { f.evidence.tagCommit = "f".repeat(40); refusal = "missing_input"; }
    if (kind === "missing") { f.evidence.packages.pop(); refusal = "verified_package_set_missing_or_extra"; }
    if (kind === "extra") { f.evidence.packages.push({ ...f.evidence.packages[0]!, name: "@openlup/extra" }); refusal = "verified_package_set_missing_or_extra"; }
    if (kind === "substituted") { f.evidence.packages[0]!.name = "@openlup/extra"; refusal = "verified_package_mismatch: @openlup/core"; }
    if (kind === "verification") { f.evidence.packages[0]!.verificationSource = "raw registry"; refusal = "verified_package_mismatch: @openlup/core"; }
    if (kind === "integrity") { f.evidence.packages[0]!.integrity = "sha512-" + Buffer.alloc(64).toString("base64"); refusal = "locked_package_mismatch: @openlup/core"; }
    if (kind === "schema") { f.put("application/node_modules/@openlup/outbox/sql/manifest.json", { migrations: [] }); refusal = "schema_manifest_mismatch: @openlup/outbox"; }
    if (kind === "schema-missing") { rmSync(join(f.application, "node_modules/@openlup/outbox/sql/manifest.json")); refusal = "missing_or_unsafe_input"; }
    if (kind === "schema-extra") { f.put("application/node_modules/@openlup/core/sql/manifest.json", {}); refusal = "schema_manifest_extra: @openlup/core"; }
    if (kind === "catalogue") refusal = "schema_catalogue_missing";
    if (kind === "profile") refusal = "composition_profile_mismatch";
    if (kind === "starter") f.evidence.extraction.contentSha256 = "a".repeat(64);
    if (kind === "content") f.put("application/Dockerfile", "tampered");
    if (kind === "lock") f.put("application/package-lock.json", {});
    expect(() => f.bom()).toThrow(refusal);
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
