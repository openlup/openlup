/**
 * `npm run packages:check [-- --pack] [-- --out <dir>] [-- --release-tag <tag>]`,
 * from the repository root.
 *
 * Without options it checks every package manifest against
 * `config/openlup-packages.json` and needs no build. With `--pack` it also
 * builds and packs each listed package into a temporary directory, and checks
 * every packed file (see `package-tarball-gate.ts`). A package directory must
 * be clean before the build and still clean after it, so the packed bytes are
 * the commit's. It prints one summary line per tarball, with its integrity.
 *
 * `--out <dir>` implies `--pack`. It keeps the tarball of every publishable
 * package in an empty `<dir>`, and writes `packages-manifest.json` there: the
 * commit, the version, and each tarball's sha256 and integrity. That is the
 * input a publication job stages. `--release-tag openlup-source-preview/<n>`
 * requires the lockstep version to be `0.<n>.0`. Nothing here publishes.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGES_CONFIG_PATH, checkPackageDirectories, checkPackageManifest, checkUnreleasedManifest, parsePackagesConfig, type Finding, type PackageEntry } from "./package-manifest-policy.ts";
import { checkTarballEntries, type TarballEntry } from "./package-tarball-gate.ts";

type PackResult = { filename: string; integrity: string; sha256: string; entryCount: number };
export const PACKAGES_MANIFEST_FILE = "packages-manifest.json";
const RELEASE_TAG = /^openlup-source-preview\/([1-9]\d*)$/;
const capture = (root: string, command: string, args: string[], cwd = root): string => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

function walk(directory: string, onSymlink: (path: string) => void): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name), state = lstatSync(path);
    if (state.isSymbolicLink()) { onSymlink(path); return []; }
    return state.isDirectory() ? walk(path, onSymlink) : [path];
  });
}

function packAndCheck(root: string, entry: PackageEntry, readTracked: (path: string) => Uint8Array | undefined, findings: Finding[], outDir?: string): PackResult | undefined {
  const finding = (rule: string, detail: string): void => { findings.push({ subject: entry.name, rule, detail }); };
  const dirty = (): string => capture(root, "git", ["status", "--porcelain", "--untracked-files=no", "--", entry.directory]).trim();
  if (dirty()) { finding("dirty-tree", `commit or discard the changes under ${entry.directory} first; a pack is checked against the commit`); return undefined; }
  const directory = join(root, entry.directory);
  const scripts = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  // Run the package's own pack preparation visibly, so a build error shows its diagnostics; then pack without re-running it.
  const prepare = "prepack" in scripts ? "prepack" : "build" in scripts ? "build" : undefined;
  if (prepare) execFileSync("npm", ["run", prepare], { cwd: directory, stdio: ["ignore", "inherit", "inherit"] });
  if (dirty()) { finding("dirty-tree", `the build rewrote tracked files under ${entry.directory}`); return undefined; }
  const scratch = mkdtempSync(join(tmpdir(), "openlup-packages-"));
  try {
    const [packed] = JSON.parse(capture(root, "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], directory)) as Array<{ filename: string; integrity: string }>;
    const extracted = join(scratch, "x");
    mkdirSync(extracted);
    capture(root, "tar", ["-xzf", join(scratch, packed.filename), "-C", extracted]);
    for (const name of readdirSync(extracted)) if (name !== "package") finding("tarball-root", `the tarball carries ${name} beside package/`);
    const packageRoot = join(extracted, "package");
    const files = walk(packageRoot, (path) => finding("symlink", `${relative(packageRoot, path)} is a symbolic link`));
    const entries: TarballEntry[] = files.map((path) => ({ path: relative(packageRoot, path).split(sep).join("/"), bytes: readFileSync(path) }));
    findings.push(...checkTarballEntries(entry, entries, readTracked));
    const tarball = join(scratch, packed.filename);
    if (outDir && entry.publish) copyFileSync(tarball, join(outDir, packed.filename));
    return { filename: packed.filename, integrity: packed.integrity, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), entryCount: entries.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type Options = { pack: boolean; outDir?: string; releaseTag?: string };
function parseOptions(args: readonly string[]): Options | string {
  const options: Options = { pack: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pack") options.pack = true;
    else if (arg === "--out" || arg === "--release-tag") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
      if (arg === "--out") { options.outDir = value; options.pack = true; } else options.releaseTag = value;
      index += 1;
    } else return `unknown argument ${arg}`;
  }
  return options;
}

export function runPackagesCheck(root: string, args: readonly string[]): number {
  const options = parseOptions(args);
  if (typeof options === "string") { console.error(`packages:check: ${options}`); return 2; }
  const tracked = new Set(capture(root, "git", ["ls-files", "-z"]).split("\0").filter(Boolean));
  const readTracked = (path: string): Uint8Array | undefined => (tracked.has(path) ? readFileSync(join(root, path)) : undefined);
  const manifest = (directory: string): unknown => { const bytes = readTracked(`${directory}/package.json`); return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; };
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const findings = checkPackageDirectories(config, [...tracked]);
  for (const entry of config.packages) if (manifest(entry.directory) !== undefined) findings.push(...checkPackageManifest(entry, manifest(entry.directory), config));
  for (const entry of config.unreleased) if (manifest(entry.directory) !== undefined) findings.push(...checkUnreleasedManifest(entry, manifest(entry.directory)));
  if (options.releaseTag !== undefined) {
    const number = RELEASE_TAG.exec(options.releaseTag)?.[1];
    if (number === undefined) findings.push({ subject: options.releaseTag, rule: "release-version", detail: "a package release rides on an openlup-source-preview/<n> tag" });
    else if (config.version !== `0.${number}.0`) findings.push({ subject: options.releaseTag, rule: "release-version", detail: `the lockstep version is ${config.version}; this release needs 0.${number}.0` });
  }
  const outDir = options.outDir === undefined ? undefined : join(root, options.outDir);
  if (outDir && existsSync(outDir) && readdirSync(outDir).length > 0) { console.error(`packages:check: ${options.outDir} is not empty`); return 2; }
  if (outDir) mkdirSync(outDir, { recursive: true });
  const packed: Array<{ name: string } & PackResult> = [];
  if (options.pack) {
    for (const entry of config.packages) {
      const result = packAndCheck(root, entry, readTracked, findings, outDir);
      if (!result) continue;
      console.log(`packed ${entry.name}@${config.version}: ${result.filename}, ${result.entryCount} files, ${result.integrity}`);
      if (entry.publish) packed.push({ name: entry.name, ...result });
    }
  }
  for (const { subject, rule, detail } of findings) console.error(`${rule} ${subject}: ${detail}`);
  if (outDir && findings.length === 0) {
    const commit = capture(root, "git", ["rev-parse", "HEAD"]).trim();
    const packages = packed.map(({ name, filename, sha256, integrity }) => ({ name, filename, sha256, integrity }));
    writeFileSync(join(outDir, PACKAGES_MANIFEST_FILE), `${JSON.stringify({ schemaVersion: 1, commit, version: config.version, packages }, null, 2)}\n`);
    console.log(`packages:check: ${packages.length} publishable tarball(s) kept in ${options.outDir}`);
  }
  console.log(findings.length === 0 ? `packages:check: ${config.packages.length} package(s) at ${config.version}, no findings` : `packages:check: ${findings.length} finding(s)`);
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = runPackagesCheck(process.cwd(), process.argv.slice(2));
