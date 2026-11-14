/** Read-only release-set BOM from the existing exact-commit pack producer. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { readCiImage } from "../ci-image-pull.mjs";
import { assertInstalledPackages, readPackManifest } from "./pack-manifest-input.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function generateReleaseBom(root: string, manifestPath: string, commit: string) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("release-bom: expected full source commit");
  const read = (path: string) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const configBytes = read("config/openlup-packages.json");
  const inventory = parsePackagesConfig(configBytes);
  const packages = inventory.packages.filter(item => item.publish).map(pkg => {
    const bytes = read(`${pkg.directory}/package.json`);
    const metadata = JSON.parse(bytes);
    if (metadata.name !== pkg.name || typeof metadata.version !== "string" || !/^0\.\d+\.\d+$/u.test(metadata.version) || metadata.license !== "Apache-2.0") throw new Error("release-bom: invalid committed package identity/license");
    return { name: pkg.name, version: metadata.version as string, license: metadata.license as string, manifestSha256: hash(bytes) };
  });
  if (!packages.length || new Set(packages.map(pkg => pkg.version)).size !== 1) throw new Error("release-bom: incomplete or mixed package set");
  const verified = readPackManifest(manifestPath, commit, packages);
  return {
    formatVersion: 1,
    kind: "openlup-package-set-bom",
    source: { repository: "https://github.com/openlup/openlup", commit, inventorySha256: hash(configBytes) },
    setVersion: packages[0]!.version,
    posture: "development-preview",
    scope: "First-party npm package set only. Not a dependency SBOM, image/composition inventory, execution result, publication receipt or provenance attestation.",
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)).map(pkg => {
      const artifact = verified.get(pkg.name)!;
      return { ...pkg, artifact: { sha256: artifact.sha256, integrity: artifact.integrity } };
    }),
  };
}

type ExactSetEvidence = {
  setVersion: string; tag: string; tagCommit: string;
  extraction: { mode: string; setVersion: string; sourceRevision: string; contentSha256: string; lockfileSha256: string };
  packages: { name: string; version: string; integrity: string; verificationSource: string; provenanceSha256: string }[];
  image: { name: string; platform: string; manifestDigest: string; baseImageDigest: string };
};

/** Bind pre-existing signature verification to the original installed target, never the final receipt. */
export function generateExactSetReleaseBom(root: string, application: string, evidence: ExactSetEvidence) {
  const refuse = (reason: string): never => { throw new Error(`release-bom: ${reason}`); };
  const { setVersion, tag, tagCommit, image } = evidence;
  if (image?.name !== "ghcr.io/openlup/neutral-store-starter" || image.platform !== "linux/amd64"
    || !/^sha256:[a-f0-9]{64}$/u.test(image.manifestDigest) || image.baseImageDigest !== readCiImage("starter-node").digest) refuse("image_identity_mismatch");
  if (!/^0\.\d+\.\d+$/u.test(setVersion) || tag !== `openlup-core-v${setVersion}` || !/^[a-f0-9]{40}$/u.test(tagCommit)) refuse("set_identity_mismatch");
  const read = (path: string) => {
    try { return execFileSync("git", ["show", `${tagCommit}:${path}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return refuse(`missing_input: ${path}`); }
  };
  const installed = (path: string) => {
    const absolute = join(application, path);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile() || !realpathSync(absolute).startsWith(realpathSync(application) + sep)) refuse(`missing_or_unsafe_input: ${path}`);
    return readFileSync(absolute);
  };
  const inventory = parsePackagesConfig(read("config/openlup-packages.json").toString()).packages.filter(p => p.publish).sort((a, b) => a.name.localeCompare(b.name));
  if (!Array.isArray(evidence.packages) || evidence.packages.length !== inventory.length || new Set(evidence.packages.map(p => p.name)).size !== inventory.length) refuse("verified_package_set_missing_or_extra");
  assertInstalledPackages(application, inventory.map(p => p.name));
  const packages = inventory.map(pkg => {
    const verified = evidence.packages.find(p => p.name === pkg.name), metadata = JSON.parse(installed(`node_modules/${pkg.name}/package.json`).toString());
    const source = JSON.parse(read(`${pkg.directory}/package.json`).toString());
    if (!verified || verified.version !== setVersion || source.name !== pkg.name || source.version !== setVersion || metadata.name !== pkg.name || metadata.version !== setVersion
      || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(verified.integrity) || verified.verificationSource !== "npm audit signatures --json --include-attestations" || !/^[a-f0-9]{64}$/u.test(verified.provenanceSha256)) refuse(`verified_package_mismatch: ${pkg.name}`);
    const { name, version, integrity, verificationSource, provenanceSha256 } = verified!;
    return { name, version, integrity, verificationSource, provenanceSha256 };
  });
  const ownership = JSON.parse(read("examples/neutral-store/ownership.json").toString());
  const content = [...ownership.owned, ...ownership.managed].sort().filter(path => !["package-lock.json", ".starter-origin.json"].includes(path)).map(path => [path, hash(installed(path))]);
  const origin = JSON.parse(installed(".starter-origin.json").toString()), lockBytes = installed("package-lock.json"), lock = JSON.parse(lockBytes.toString());
  const starter = { mode: origin.mode, sourceRevision: origin.sourceRevision, contentSha256: hash(JSON.stringify(content)), lockfileSha256: hash(lockBytes) };
  if (origin.schemaVersion !== 2 || !["released", "reconstructed"].includes(starter.mode) || origin.setVersion !== setVersion || evidence.extraction?.setVersion !== setVersion || starter.sourceRevision !== tagCommit
    || Object.entries(starter).some(([key, value]) => origin[key] !== value || evidence.extraction[key] !== value)) refuse("starter_identity_mismatch");
  for (const pkg of packages) if (lock.packages?.[`node_modules/${pkg.name}`]?.integrity !== pkg.integrity || lock.packages?.[`node_modules/${pkg.name}`]?.version !== setVersion) refuse(`locked_package_mismatch: ${pkg.name}`);
  const compositionFiles = [".dockerignore", ".npmrc", "Dockerfile", "compose.yaml", "installation/install.ts", "lifecycle.mjs", "package.json"];
  const files = compositionFiles.map(path => ({ path, sha256: hash(installed(path)) }));
  if (!/image: postgres:16@sha256:[a-f0-9]{64}/u.test(installed("compose.yaml").toString()) || !installed("installation/install.ts").includes("generation: 'qualified-v2'")) refuse("composition_profile_mismatch");
  const manifests = execFileSync("git", ["ls-tree", "-r", "--name-only", tagCommit, "--", ...inventory.map(p => `${p.directory}/sql/manifest.json`)], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const entries = inventory.flatMap(pkg => {
    const path = `${pkg.directory}/sql/manifest.json`, target = `node_modules/${pkg.name}/sql/manifest.json`;
    if (!manifests.includes(path)) {
      if (lstatSync(join(application, target), { throwIfNoEntry: false })) refuse(`schema_manifest_extra: ${pkg.name}`);
      return [];
    }
    const bytes = installed(target);
    if (!bytes.equals(read(path))) refuse(`schema_manifest_mismatch: ${pkg.name}`);
    return [{ path: `${pkg.name}/sql/manifest.json`, sha256: hash(bytes) }];
  }).map((entry, position) => ({ position, ...entry }));
  if (!entries.length) refuse("schema_catalogue_missing");
  return { formatVersion: 3, kind: "openlup-exact-set-bom", image: { name: image.name, platform: image.platform, manifestDigest: image.manifestDigest, baseImageDigest: image.baseImageDigest }, setVersion, tag, tagCommit, posture: "development-preview", packages,
    verificationSha256: hash(JSON.stringify(packages)), starter,
    composition: { profile: "neutral-store-postgresql-node-oci", postgresMajor: 16, files, sha256: hash(JSON.stringify(files)) },
    schemaCatalogue: { entries, sha256: hash(JSON.stringify(entries)) } };
}
