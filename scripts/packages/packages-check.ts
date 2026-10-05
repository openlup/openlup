/**
 * `npm run packages:check [-- --pack | --cold] [-- --out <dir>] [-- --release-tag <tag> | --release-set <version>]`,
 * from the repository root.
 *
 * Without options it checks every package manifest against
 * `config/openlup-packages.json`, including that every publishable package
 * carries the same set version `0.N.P`, and needs no build. With `--pack` it also
 * builds declared internal prerequisites and packs each listed package into a temporary directory, and checks
 * every packed file (see `package-tarball-gate.ts`). A package directory must
 * be clean before the build and still clean after it, so the packed bytes are
 * the commit's. It prints one summary line per tarball, with its integrity.
 *
 * `--out <dir>` implies `--pack`. It keeps the tarball of every publishable
 * package in an empty `<dir>`, and writes `packages-manifest.json` there: the
 * commit, and each tarball's package, version, sha256 and integrity. That is
 * the input a publication job stages. `--release-tag openlup-<package>-v<version>`
 * names one publishable package, requires its manifest version to be that
 * version, and packs only that package. `--release-set <version>` names the
 * whole set: every publishable package, each at that set version. Nothing here
 * publishes. `--cold` also removes untracked dist outputs before each attempt;
 * preflight and publisher use it so no package depends on another pack's residue.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGES_CONFIG_PATH, SET_VERSION, checkPackageDirectories, checkPackageManifest, checkSetVersions, checkUnreleasedManifest, releaseVersionAbove, parsePackageReleaseTag, parsePackagesConfig, type Finding, type PackageEntry } from "./package-manifest-policy.ts";
import { checkTarballEntries, type TarballEntry } from "./package-tarball-gate.ts";
import { preparePackage } from "./package-build.ts";

type PackResult = { filename: string; integrity: string; sha256: string; entryCount: number };
export const PACKAGES_MANIFEST_FILE = "packages-manifest.json";
const capture = (root: string, command: string, args: string[], cwd = root): string => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const versionOf = (manifest: unknown): unknown => (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as Record<string, unknown>).version : undefined);

function walk(directory: string, onSymlink: (path: string) => void): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name), state = lstatSync(path);
    if (state.isSymbolicLink()) { onSymlink(path); return []; }
    return state.isDirectory() ? walk(path, onSymlink) : [path];
  });
}

function packAndCheck(root: string, entry: PackageEntry, packages: readonly PackageEntry[], cold: boolean, readTracked: (path: string) => Uint8Array | undefined, findings: Finding[], keepDir?: string): PackResult | undefined {
  const finding = (rule: string, detail: string): void => { findings.push({ subject: entry.name, rule, detail }); };
  const dirty = (): string => capture(root, "git", ["status", "--porcelain", "--untracked-files=no", "--", entry.directory]).trim();
  if (dirty()) { finding("dirty-tree", `commit or discard the changes under ${entry.directory} first; a pack is checked against the commit`); return undefined; }
  const directory = join(root, entry.directory);
  preparePackage(root, entry, packages, cold);
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
    if (keepDir && entry.publish) copyFileSync(tarball, join(keepDir, packed.filename));
    return { filename: packed.filename, integrity: packed.integrity, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), entryCount: entries.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type Options = { pack: boolean; cold: boolean; outDir?: string; releaseTag?: string; releaseSet?: string };
function parseOptions(args: readonly string[]): Options | string {
  const options: Options = { pack: false, cold: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pack") options.pack = true;
    else if (arg === "--cold") { options.pack = true; options.cold = true; }
    else if (arg === "--out" || arg === "--release-tag" || arg === "--release-set") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
      if (arg === "--out") { options.outDir = value; options.pack = true; } else if (arg === "--release-tag") options.releaseTag = value; else options.releaseSet = value;
      index += 1;
    } else return `unknown argument ${arg}`;
  }
  if (options.releaseTag !== undefined && options.releaseSet !== undefined) return "name one package with --release-tag or the set with --release-set, not both";
  return options;
}

/** The one package a release tag selects, with a finding for every way the tag and the tree disagree. */
function releaseSelection(tag: string, packages: readonly PackageEntry[], versions: ReadonlyMap<string, unknown>, findings: Finding[]): PackageEntry[] {
  const release = parsePackageReleaseTag(tag);
  const entry = release && packages.find(({ directory }) => directory === release.directory);
  const refuse = (rule: string, detail: string): PackageEntry[] => { findings.push({ subject: tag, rule, detail }); return []; };
  if (!release) return refuse("release-tag", "a package release tag is openlup-<package>-v<MAJOR.MINOR.PATCH>");
  if (!entry || !entry.publish) return refuse("release-tag", `${release.directory} is not a publishable package in ${PACKAGES_CONFIG_PATH}`);
  if (versions.get(entry.name) !== release.version) return refuse("release-version", `${entry.name} is at ${String(versions.get(entry.name))}; this release needs ${release.version}`);
  return [entry];
}

/** Every publishable package, each at the set version, with a finding for every way the set and the tree disagree. */
function setSelection(version: string, packages: readonly PackageEntry[], versions: ReadonlyMap<string, unknown>, findings: Finding[]): PackageEntry[] {
  const refuse = (detail: string): PackageEntry[] => { findings.push({ subject: `set ${version}`, rule: "release-set", detail }); return []; };
  if (!SET_VERSION.test(version)) return refuse("a set version is 0.N.P below 1.0");
  const publishable = packages.filter(({ publish }) => publish);
  if (publishable.length === 0) return refuse(`${PACKAGES_CONFIG_PATH} lists no publishable package`);
  const behind = publishable.filter(({ name }) => versions.get(name) !== version).map(({ name }) => `${name} is at ${String(versions.get(name))}`);
  return behind.length === 0 ? publishable : refuse(`${behind.join(", ")}; this set needs ${version} for every publishable package`);
}

/** A one-line export list as `tsc` emits it: `export { … } from "…";`, `export type { … } from "…";` or `export { … };`. */
const EXPORT_LIST = /^(\s*export (?:type )?)\{([^{}]*)\}((?: from "[^"]*")?;)$/u;

/** The comments that open a line and close on it, with the whitespace before and after them. */
const LEADING_COMMENTS = /^\s*(?:\/\*.*?\*\/\s*)+/u;

/**
 * An API snapshot's declaration lines: everything from its first `## <declaration file>` section, without the
 * generated header. A comment that opens a line is removed, never the code after it: a line inside an unclosed
 * comment reads as if the comment opened at its start, the code after the comment's close is kept with its leading
 * whitespace trimmed, and a line left empty is dropped. A comment after code stays as written. A one-line export list
 * becomes one line per specifier, as written, so adding a name or a comment is an addition.
 */
function declarationLines(text: string | undefined): string[] {
  const lines = text?.split("\n") ?? [];
  const start = lines.findIndex((line) => line.startsWith("## "));
  let comment = false;
  return (start < 0 ? [] : lines.slice(start)).flatMap((line) => {
    const code = (comment ? `/*${line}` : line).replace(LEADING_COMMENTS, "");
    comment = code.trimStart().startsWith("/*");
    if (comment || (code === "" && line !== "")) return [];
    const list = EXPORT_LIST.exec(code);
    return list ? list[2]!.split(",").map((specifier) => specifier.trim()).filter(Boolean).map((specifier) => `${list[1]}{ ${specifier} }${list[3]}`) : [code];
  });
}

/** Whether `after` keeps every line of `before`, in order, so the change only added lines. */
function onlyAdds(before: readonly string[], after: readonly string[]): boolean {
  let kept = 0;
  for (const line of after) if (kept < before.length && line === before[kept]) kept += 1;
  return kept === before.length;
}

/**
 * Refuses a change from `base` to `head` that removes or changes a declaration line in an API
 * snapshot of a package publishable at `base`, unless the package's single `## [Unreleased]`
 * changelog section at `head` carries a `Migration:` block, or a coherent newly
 * raised set carries it in the unique prepared version section below an empty Unreleased. The base decides what is checked:
 * its packages config, and each subpath its `release-gates.json` `packageSurface` lists. Each is
 * compared with the snapshot the head's `packageSurface` lists for the same subpath; a subpath,
 * gates file or snapshot missing at the head reads as empty, so removing or renaming a subpath
 * is a removal. A base file that cannot be read, or a snapshot path outside its package, refuses.
 * A pure addition keeps every old line in order and has no "before", so it needs none. The head
 * must stay readable as the next base, block or not: its config parses, and each package
 * publishable there keeps a gates file with a `packageSurface` object and every snapshot it lists.
 * The published-tree `--policy` check runs this against a pull request's or merge group's base.
 */
export function assertMigrationBlocks(root: string, base: string, head: string): void {
  for (const commit of [base, head]) capture(root, "git", ["rev-parse", "--verify", `${commit}^{commit}`]);
  const refuse = (detail: string): never => { throw new Error(`migration-block: ${detail}`); };
  const atBase = (path: string): string => { try { return capture(root, "git", ["show", `${base}:${path}`]); } catch { return refuse(`${path} cannot be read at the base ${base}`); } };
  const atHead = (path: string): string | undefined => { try { return capture(root, "git", ["show", `${head}:${path}`]); } catch { return undefined; } };
  const surface = (commit: string, path: string, text: string | undefined): Record<string, unknown> => {
    let found: unknown = {};
    try { if (text !== undefined) found = (JSON.parse(text) as { packageSurface?: unknown }).packageSurface; } catch { found = undefined; }
    return found !== null && typeof found === "object" && !Array.isArray(found) ? found as Record<string, unknown> : refuse(`${path} at ${commit} has no packageSurface object`);
  };
  /** A snapshot entry's path, normalised against its package directory. */
  const snapshotPath = (directory: string, entry: unknown): string => {
    const snapshot = (entry as { snapshot?: unknown } | null)?.snapshot;
    const path = typeof snapshot === "string" && !posix.isAbsolute(snapshot) ? posix.join(directory, snapshot) : "";
    return path.startsWith(`${directory}/`) ? path : refuse(`${directory}/release-gates.json lists the snapshot ${String(snapshot)}, which is not a path inside ${directory}`);
  };
  const preparedMigration = (directory: string, sections: string[]): boolean => {
    try {
      const before = parsePackagesConfig(atBase(PACKAGES_CONFIG_PATH)).packages.filter(({ publish }) => publish);
      const after = parsePackagesConfig(atHead(PACKAGES_CONFIG_PATH) ?? "");
      const manifests = new Map(after.packages.map((entry) => [entry.name, JSON.parse(atHead(`${entry.directory}/package.json`) ?? "null")]));
      const versions = new Map(after.packages.map((entry) => [entry.name, versionOf(manifests.get(entry.name))]));
      const entry = after.packages.find((row) => row.directory === directory && row.publish), version = entry && versions.get(entry.name);
      if (typeof version !== "string" || !SET_VERSION.test(version) || checkSetVersions(after, versions).length > 0) return false;
      if (after.packages.some((row) => checkPackageManifest(row, manifests.get(row.name), after, versions).length > 0)) return false;
      const carrierMatches = (name: string, carrier: unknown): boolean => {
        if (carrier === null || typeof carrier !== "object") return false;
        const value = carrier as Record<string, unknown>, manifest = manifests.get(name);
        if (value.version !== versions.get(name)) return false;
        return ["dependencies", "peerDependencies", "optionalDependencies"].every((field) => {
          const pins = (value[field] ?? {}) as Record<string, unknown>, expected = manifest[field] ?? {};
          return [...new Set([...Object.keys(pins), ...Object.keys(expected)])].filter((pin) => pin.startsWith("@openlup/")).every((pin) => pins[pin] === expected[pin] && pins[pin] === versions.get(pin));
        });
      };
      const rootLock = JSON.parse(atHead("package-lock.json") ?? "null");
      const baseRootLock = capture(root, "git", ["ls-tree", base, "--", "package-lock.json"]).trim() ? JSON.parse(atBase("package-lock.json")) : undefined;
      for (const row of after.packages) {
        const rootCarrier = rootLock?.packages?.[row.directory];
        if ((row.publish || rootCarrier !== undefined || baseRootLock?.packages?.[row.directory] !== undefined) && !carrierMatches(row.name, rootCarrier)) return false;
        const path = `${row.directory}/package-lock.json`, bytes = atHead(path);
        if (!bytes && capture(root, "git", ["ls-tree", base, "--", path]).trim()) return false;
        if (bytes) { const lock = JSON.parse(bytes); if (lock.version !== versions.get(row.name) || !carrierMatches(row.name, lock.packages?.[""])) return false; }
      }
      if (before.some((row) => { const old = versionOf(JSON.parse(atBase(`${row.directory}/package.json`))); return typeof old !== "string" || releaseVersionAbove(version, old) !== true; })) return false;
      const released = sections.filter((section) => section.startsWith(`## [${version}]\n`));
      return released.length === 1 && sections.indexOf(released[0]!) > sections.findIndex((section) => section.startsWith("## [Unreleased]")) && /^\s*Migration:/mu.test(released[0]!);
    } catch { return false; }
  };
  const refusals: string[] = [];
  for (const { name, directory } of parsePackagesConfig(atBase(PACKAGES_CONFIG_PATH)).packages.filter(({ publish }) => publish)) {
    const gates = `${directory}/release-gates.json`, before = surface(base, gates, atBase(gates)), after = surface(head, gates, atHead(gates));
    const changed = Object.entries(before).flatMap(([key, entry]) => {
      const path = snapshotPath(directory, entry), next = Object.hasOwn(after, key) ? atHead(snapshotPath(directory, after[key])) : undefined;
      return onlyAdds(declarationLines(atBase(path)), declarationLines(next)) ? [] : [path];
    });
    if (changed.length === 0) continue;
    const sections = (atHead(`${directory}/CHANGELOG.md`) ?? "").split(/^(?=## )/mu);
    const unreleased = sections.filter((section) => section.startsWith("## [Unreleased]"));
    const missing = unreleased.length !== 1 ? `${directory}/CHANGELOG.md has ${unreleased.length} "## [Unreleased]" sections, not one`
      : /^\s*Migration:/mu.test(unreleased[0]!) || (unreleased[0]!.trim() === "## [Unreleased]" && preparedMigration(directory, sections)) ? undefined : `its "## [Unreleased]" section has no Migration: block`;
    if (missing) refusals.push(`migration-block ${name}: ${changed.join(", ")} removes or changes a declaration line since ${base}, and ${missing}; add a Migration: block with the code or SQL before and after`);
  }
  let publishable: readonly PackageEntry[] = [];
  try { publishable = parsePackagesConfig(atHead(PACKAGES_CONFIG_PATH) ?? "").packages.filter(({ publish }) => publish); } catch { refusals.push(`migration-block: ${PACKAGES_CONFIG_PATH} cannot be read or parsed at the head ${head}`); }
  for (const { directory } of publishable) {
    const gates = `${directory}/release-gates.json`, readable = (path: string): string => atHead(path) ?? refuse(`${path} cannot be read at the head ${head}`);
    try { for (const entry of Object.values(surface(head, gates, readable(gates)))) readable(snapshotPath(directory, entry)); } catch (error) { refusals.push((error as Error).message); }
  }
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
}

export function runPackagesCheck(root: string, args: readonly string[]): number {
  const options = parseOptions(args);
  if (typeof options === "string") { console.error(`packages:check: ${options}`); return 2; }
  const tracked = new Set(capture(root, "git", ["ls-files", "-z"]).split("\0").filter(Boolean));
  const readTracked = (path: string): Uint8Array | undefined => (tracked.has(path) ? readFileSync(join(root, path)) : undefined);
  const manifest = (directory: string): unknown => { const bytes = readTracked(`${directory}/package.json`); return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; };
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const versions = new Map(config.packages.map(({ name, directory }) => [name, versionOf(manifest(directory))]));
  const findings = checkPackageDirectories(config, [...tracked]);
  for (const entry of config.packages) if (manifest(entry.directory) !== undefined) findings.push(...checkPackageManifest(entry, manifest(entry.directory), config, versions));
  for (const entry of config.unreleased) if (manifest(entry.directory) !== undefined) findings.push(...checkUnreleasedManifest(entry, manifest(entry.directory)));
  findings.push(...checkSetVersions(config, versions));
  const selected = options.releaseTag !== undefined ? releaseSelection(options.releaseTag, config.packages, versions, findings)
    : options.releaseSet !== undefined ? setSelection(options.releaseSet, config.packages, versions, findings) : config.packages;
  const outDir = options.outDir === undefined ? undefined : resolve(root, options.outDir);
  if (outDir && existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) { console.error(`packages:check: ${options.outDir} is not an empty directory`); return 2; }
  // Publishable tarballs wait here, and reach the out directory only when nothing was found.
  const keepDir = outDir ? mkdtempSync(join(tmpdir(), "openlup-packages-kept-")) : undefined;
  try {
    const packed: Array<{ name: string; version: string } & PackResult> = [];
    if (options.pack && findings.length === 0) {
      for (const entry of selected) {
        const result = packAndCheck(root, entry, config.packages, options.cold, readTracked, findings, keepDir);
        if (!result) continue;
        const version = String(versions.get(entry.name));
        console.log(`packed ${entry.name}@${version}: ${result.filename}, ${result.entryCount} files, ${result.integrity}`);
        if (entry.publish) packed.push({ name: entry.name, version, ...result });
      }
    }
    for (const { subject, rule, detail } of findings) console.error(`${rule} ${subject}: ${detail}`);
    if (outDir && keepDir && findings.length === 0) {
      mkdirSync(outDir, { recursive: true });
      for (const { filename } of packed) copyFileSync(join(keepDir, filename), join(outDir, filename));
      const commit = capture(root, "git", ["rev-parse", "HEAD"]).trim();
      const packages = packed.map(({ name, version, filename, sha256, integrity }) => ({ name, version, filename, sha256, integrity }));
      writeFileSync(join(outDir, PACKAGES_MANIFEST_FILE), `${JSON.stringify({ schemaVersion: 2, commit, packages }, null, 2)}\n`);
      console.log(`packages:check: ${packages.length} publishable tarball(s) kept in ${options.outDir}`);
    }
  } finally {
    if (keepDir) rmSync(keepDir, { recursive: true, force: true });
  }
  console.log(findings.length === 0 ? `packages:check: ${config.packages.length} package(s), no findings` : `packages:check: ${findings.length} finding(s)`);
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = runPackagesCheck(process.cwd(), process.argv.slice(2));
