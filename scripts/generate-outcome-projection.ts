/** Project public package proof declarations; never turn source presence into a PASS. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parsePackagesConfig } from "./packages/package-manifest-policy.ts";

export const OUTCOME_PROJECTION_PATH = "docs/platform/OUTCOME_PROJECTION.md";
type Proof = { path: string; sha256: string | null };
type Outcome = { package: string; version: string; entry: string; snapshot: Proof; proofs: Proof[]; state: "partial" | "missing" };
export interface OutcomeProjection {
  formatVersion: 1;
  setVersion: string;
  sourceDigest: string;
  state: "partial" | "missing";
  claimable: false;
  outcomes: Outcome[];
}
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function collectOutcomeProjection(root: string): OutcomeProjection {
  const inputs: [string, string][] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    inputs.push([path, digest(bytes)]);
    return JSON.parse(bytes.toString("utf8"));
  };
  const inventory = parsePackagesConfig(JSON.stringify(read("config/openlup-packages.json")));
  const outcomes: Outcome[] = [];
  const versions = new Set<string>();
  for (const pkg of inventory.packages.filter(item => item.publish).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = read(`${pkg.directory}/package.json`);
    const gates = read(`${pkg.directory}/release-gates.json`);
    if (manifest.name !== pkg.name || typeof manifest.version !== "string" || !/^0\.\d+\.\d+$/u.test(manifest.version)) throw new Error("outcome-projection: invalid package identity");
    versions.add(manifest.version);
    if (!manifest.exports || !gates.packageSurface || JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(Object.keys(gates.packageSurface).sort())) throw new Error("outcome-projection: export/evidence inventory mismatch");
    const proof = (localPath: unknown): Proof => {
      if (typeof localPath !== "string" || !localPath || localPath.includes("\\") || localPath.split("/").some(part => !part || part === "." || part === "..")) throw new Error("outcome-projection: unsafe proof path");
      const absolute = resolve(root, pkg.directory, localPath);
      if (!absolute.startsWith(resolve(root, pkg.directory) + sep)) throw new Error("outcome-projection: proof escaped package");
      const path = `${pkg.directory}/${localPath}`;
      const present = existsSync(absolute) && lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink();
      if (present && !realpathSync(absolute).startsWith(realpathSync(resolve(root, pkg.directory)) + sep)) throw new Error("outcome-projection: proof escaped package");
      return { path, sha256: present ? digest(readFileSync(absolute)) : null };
    };
    for (const entry of Object.keys(manifest.exports).sort()) {
      const surface = gates.packageSurface[entry];
      if (!surface || !Array.isArray(surface.packageSmokeEvidence)) throw new Error("outcome-projection: missing smoke declaration");
      const proofs: Proof[] = surface.packageSmokeEvidence.map(proof);
      const snapshot = proof(surface.snapshot);
      outcomes.push({ package: pkg.name, version: manifest.version, entry, snapshot, proofs,
        state: !proofs.length || !snapshot.sha256 || proofs.some(item => item.sha256 === null) ? "missing" : "partial" });
    }
  }
  if (versions.size !== 1 || !outcomes.length) throw new Error("outcome-projection: incomplete or mixed package set");
  return {
    formatVersion: 1, setVersion: [...versions][0]!,
    sourceDigest: digest(JSON.stringify({ inputs: inputs.sort(([a], [b]) => a.localeCompare(b)), outcomes })),
    state: outcomes.some(item => item.state === "missing") ? "missing" : "partial", claimable: false, outcomes,
  };
}

export function renderOutcomeProjection(projection: OutcomeProjection): string {
  const link = (proof: Proof) => `[${proof.path}](../../${proof.path})${proof.sha256 ? "" : " (missing)"}`;
  // Group by the existing export's top-level class, rather than copying provider
  // identifiers into the neutral projection or keeping another provider registry.
  const groups = new Map<string, Outcome[]>();
  for (const outcome of projection.outcomes) {
    const key = `${outcome.package}@${outcome.version}${outcome.entry === "." ? " (root)" : `/${outcome.entry.split("/")[1]}`}`;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  const commonTarget = (proofs: Proof[]): Proof => {
    const parts = proofs[0]!.path.split("/");
    for (const proof of proofs.slice(1)) {
      const next = proof.path.split("/");
      while (parts.some((part, index) => part !== next[index])) parts.pop();
    }
    const path = parts.join("/");
    return { path: proofs.some(proof => proof.path === path) ? path : `${path}/`, sha256: proofs.every(proof => proof.sha256) ? "present" : null };
  };
  return [
    "# Public outcome projection", "",
    "Generated by `node --experimental-strip-types scripts/generate-outcome-projection-cli.ts --write`; do not edit.", "",
    `Format: ${projection.formatVersion}. Declared package set: \`${projection.setVersion}\`. State: **${projection.state}**. **Outcome claim blocked.**`, "",
    `Public-input SHA-256: \`${projection.sourceDigest}\`.`, "",
    "This is the one projection of the existing package export and packageSmokeEvidence instruments. Rows group exports by their existing top-level class, with counts and links to the common API and executable-proof parents. Per-provider names and details stay in those sources. The public-input hash binds every individual declaration and proof file, not an executed result. No private capability register or denominator is imported.", "",
    "The public package instruments do not enumerate every composed-store, deployment, recovery or adopter outcome. That scope remains partial. Source presence, an API snapshot and a generated BOM cannot close it. No complete release outcome, supported install, stable API or production readiness is claimed.", "",
    "Every present proof declaration is partial until the exact release has applicable executed evidence. Missing, partial and unresolved outcomes block their claim. This generator consumes no execution receipts and cannot emit complete. --check checks freshness only; --assert-complete refuses this partial claim. The ordinary package and application proof owners remain authoritative.", "",
    `Declared exports: ${projection.outcomes.length}. All are included in the class counts below.`, "",
    "| Package class | Export count | API declarations | Existing executable proof declarations | State |",
    "| --- | --- | --- | --- | --- |",
    ...[...groups].map(([name, items]) => {
      const proofs = items.flatMap(item => item.proofs);
      const state = items.some(item => item.state === "missing") ? "missing" : "partial";
      return `| \`${name}\` | ${items.length} | ${link(commonTarget(items.map(item => item.snapshot)))} | ${proofs.length ? link(commonTarget(proofs)) : "No declared witness"} | ${state} |`;
    }),
    "",
  ].join("\n");
}

export function runOutcomeProjection(root: string, options: string[]): void {
  if (options.length !== 1 || !["--write", "--check", "--assert-complete"].includes(options[0]!)) throw new Error("Use --write, --check or --assert-complete");
  const projection = collectOutcomeProjection(root);
  const rendered = renderOutcomeProjection(projection);
  if (options[0] === "--write") writeFileSync(join(root, OUTCOME_PROJECTION_PATH), rendered);
  else if (readFileSync(join(root, OUTCOME_PROJECTION_PATH), "utf8") !== rendered) throw new Error("outcome-projection: stale output; regenerate");
  if (options[0] === "--assert-complete") throw new Error("outcome-projection: partial evidence blocks the outcome claim");
}
