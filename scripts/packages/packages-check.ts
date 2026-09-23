/**
 * `npm run packages:check [-- --pack]`, from the repository root.
 *
 * Without `--pack` it checks every package manifest against
 * `config/openlup-packages.json` and needs no build. With `--pack` it also builds
 * and packs each listed package into a temporary directory and checks every
 * packed file (see `package-tarball-gate.ts`). It prints one summary line per
 * tarball, with the integrity that a later publish must reproduce. Nothing is
 * published.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PACKAGES_CONFIG_PATH, checkPackageDirectories, checkPackageManifest, parsePackagesConfig, type Finding, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";
import { checkTarballEntries, type TarballEntry } from "./package-tarball-gate.ts";

const root = process.cwd();
const run = (command: string, args: string[], cwd = root): string => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const tracked = new Set(run("git", ["ls-files", "-z"]).split("\0").filter(Boolean));
const readTracked = (path: string): Uint8Array | undefined => (tracked.has(path) ? readFileSync(join(root, path)) : undefined);

function manifestFindings(config: PackagesConfig): Finding[] {
  const findings = checkPackageDirectories(config, [...tracked]);
  for (const entry of config.packages) {
    const bytes = readTracked(`${entry.directory}/package.json`);
    if (bytes) findings.push(...checkPackageManifest(entry, JSON.parse(new TextDecoder().decode(bytes)), config));
  }
  return findings;
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => { const path = join(directory, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
}

type PackResult = { filename: string; integrity: string; entryCount: number };
function packAndCheck(entry: PackageEntry, findings: Finding[]): PackResult {
  const directory = join(root, entry.directory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  if (manifest.scripts?.build) run("npm", ["run", "build"], directory);
  const scratch = mkdtempSync(join(tmpdir(), "openlup-packages-"));
  try {
    const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch], directory)) as Array<{ filename: string; integrity: string }>;
    const extracted = join(scratch, "x");
    mkdirSync(extracted);
    run("tar", ["-xzf", join(scratch, packed.filename), "-C", extracted]);
    const packageRoot = join(extracted, "package");
    const entries: TarballEntry[] = walk(packageRoot).map((path) => ({ path: relative(packageRoot, path).split(sep).join("/"), bytes: readFileSync(path) }));
    findings.push(...checkTarballEntries(entry, entries, readTracked));
    return { filename: packed.filename, integrity: packed.integrity, entryCount: entries.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--pack");
if (unknown.length > 0) { console.error(`packages:check: unknown argument ${unknown.join(" ")}`); process.exit(2); }
const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
const findings = manifestFindings(config);
if (args.includes("--pack")) {
  for (const entry of config.packages) {
    const result = packAndCheck(entry, findings);
    console.log(`packed ${entry.name}@${config.version}: ${result.filename}, ${result.entryCount} files, ${result.integrity}`);
  }
}
for (const { subject, rule, detail } of findings) console.error(`${rule} ${subject}: ${detail}`);
console.log(findings.length === 0 ? `packages:check: ${config.packages.length} package(s) at ${config.version}, no findings` : `packages:check: ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
