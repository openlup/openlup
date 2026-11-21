import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";
import { readChangelogFragments } from "./changelog-fragments.ts";
import { readCurrentPackManifest } from "./pack-manifest-input.ts";
import { type PackageEntry, parsePackagesConfig } from "./package-manifest-policy.ts";
import { baselineRefusal, downloadLatest, localPacks, type Pack, unpackSet } from "./released-api-baseline.ts";
import { paymentOutcome, paymentSubpath, paymentSymbol } from "./released-api-payment.ts";
import { assertClosedRegistryTags } from "./released-api-registries.ts";
import { compareTypes, type Finding, type Surface } from "./released-api-types.ts";

const cadence = "https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#release-cadence";
const deprecationPath = `Restore the released contract, add the replacement alongside it, mark the old API @deprecated and name the upgrade action in a Migration: fragment. Keep the bridge through a supported minor before removal in an authorized major. Release cadence: ${cadence}`;
const registryPath = `Preserve the released registry prefix. Document each new tail entry in a Migration: line for the minor release. Release cadence: ${cadence}`;
type RemovalPolicy = { authorizedMajor?: string; entries?: Map<string, string[]> };

function allowedRemoval(finding: Finding, candidate: string, policy: RemovalPolicy): boolean {
  if (!finding.deprecated || !policy.authorizedMajor) return false;
  const [major, minor] = finding.version.split(".");
  const nextMajor = String(Number(major) + 1);
  if (policy.authorizedMajor !== nextMajor || candidate !== `${nextMajor}.0.0`) return false;
  return (policy.entries?.get(finding.name) ?? []).some(fragment => {
    const entries = fragment.split(/^### Stable API removal[ \t]*\r?$/mu).slice(1);
    return entries.some(entry => {
      const fields = entry.trim().split(/\r?\n/u).slice(0, 5).map(line => line.trim());
      return fields[0] === `Subpath: ${finding.subpath}` && fields[1] === `Symbol: ${finding.symbol}`
        && fields[2] === `Bridge minor: ${major}.${minor}` && fields[3] === `Target major: ${nextMajor}`
        && /^Upgrade action: \S/u.test(fields[4] ?? "");
    });
  });
}

function changeNotes(root: string, directory: string, preparedVersion?: string): string[] {
  const fragments = readChangelogFragments(root, directory).map(fragment => fragment.contents);
  if (!preparedVersion) return fragments;
  const changelog = readFileSync(join(root, directory, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^## /mu).find(part => part.startsWith(`[${preparedVersion}]`));
  return section ? [...fragments, section] : fragments;
}

export async function checkReleasedApi(root: string, packages: PackageEntry[], candidatePacks: Pack[], releasedPacks?: Pack[], authorizedMajor?: string) {
  const started = performance.now();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "openlup-released-api-")));
  try {
    const names = packages.map(({ name }) => name);
    const packs = releasedPacks ?? await downloadLatest(names, join(scratch, "downloads"));
    const released = unpackSet(join(scratch, "released"), packs, names, "released");
    const candidate = unpackSet(join(scratch, "candidate"), candidatePacks, names, "candidate");
    for (const set of [released, candidate]) {
      for (const [name, { directory }] of set.installed) assertClosedRegistryTags(directory, name, set.version);
    }
    const modules = join(scratch, "node_modules");
    mkdirSync(modules);
    for (const name of readdirSync(join(root, "node_modules"))) {
      if (!name.startsWith(".") && name !== "@openlup") symlinkSync(join(root, "node_modules", name), join(modules, name), "dir");
    }

    const surfaces: Surface[] = [];
    for (const [name, { directory, manifest }] of released.installed) {
      const metadata = JSON.parse(readFileSync(join(directory, "release-gates.json"), "utf8")) as { packageSurface?: Record<string, { maturity: string }> };
      const current = candidate.installed.get(name)!.manifest.exports;
      const stable = Object.entries(metadata.packageSurface ?? {}).filter(([, { maturity }]) => maturity === "stable");
      if (!stable.length) baselineRefusal(`${name}@${manifest.version} has no stable subpaths in its packed release metadata`);
      for (const [key] of stable) {
        if (!manifest.exports?.[key]) baselineRefusal(`${name}@${manifest.version} has no export for ${key}`);
        surfaces.push({ name, version: manifest.version, subpath: name + key.slice(1), candidate: Boolean(current?.[key]) });
      }
    }
    const preparedVersion = candidate.version === released.version ? undefined : candidate.version;
    const findings = compareTypes(scratch, surfaces, candidate.version, name =>
      changeNotes(root, packages.find(entry => entry.name === name)!.directory, preparedVersion));
    const payment = surfaces.find(({ subpath }) => subpath === paymentSubpath);
    if (payment && !findings.some(({ subpath, symbol }) => subpath === paymentSubpath && symbol === paymentSymbol)) {
      const before = paymentOutcome(released.directory), after = paymentOutcome(candidate.directory);
      if (before !== after) findings.push({ ...payment, symbol: paymentSymbol, change: `released readback outcome changed from ${before} to ${after}` });
    }
    const entries = authorizedMajor ? new Map(packages.map(({ name, directory }) => [name, changeNotes(root, directory, candidate.version)])) : undefined;
    const policy = { authorizedMajor, entries };
    const refused = findings.filter(finding => !allowedRemoval(finding, candidate.version, policy));
    if (refused.length) throw new Error(refused.map(({ name, version, subpath, symbol, change, appendOnly }) =>
      `Stable API break against ${name}@${version} — ${subpath} → ${symbol}: ${change}. ${appendOnly ? registryPath : deprecationPath}`).join("\n"));
    const elapsed = Math.round(performance.now() - started);
    console.log(`Released API ${released.version} → ${candidate.version}: ${surfaces.length} stable subpaths in ${elapsed} ms`);
    return elapsed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [released, candidate, commit, ...extra] = process.argv.slice(2);
  if (!released || !candidate || !commit || extra.length) throw new Error("Use <released-pack-directory|npm> <candidate-pack-directory> <full-sha>");
  const root = process.cwd();
  const packages = parsePackagesConfig(readFileSync(join(root, "config/openlup-packages.json"), "utf8")).packages.filter(({ publish }) => publish);
  const packs = readCurrentPackManifest(root, join(candidate, "packages-manifest.json"), commit);
  await checkReleasedApi(root, packages, [...packs.values()], released === "npm" ? undefined : localPacks(resolve(released)), processEnvironment.OPENLUP_AUTHORIZED_API_MAJOR);
}
