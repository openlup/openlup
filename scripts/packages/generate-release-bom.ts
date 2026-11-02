/** Read-only release-set BOM from the existing exact-commit pack producer. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { readPackManifest } from "./pack-manifest-input.ts";

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
