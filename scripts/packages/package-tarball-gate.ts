import { carriesPrivateOperationalCoordinate } from "../oss-public-coordinate-detector.ts";
import type { Finding, PackageEntry } from "./package-manifest-policy.ts";

/**
 * What may ship inside a packed `@openlup/*` tarball.
 *
 * A tree check sees tracked files; a tarball also carries build output, so the
 * two can differ. Every packed file must therefore be one of:
 * - a tracked file of the package directory, byte for byte;
 * - build output under `dist/` whose tracked TypeScript source exists;
 * - the package manifest, which npm may normalise, with identity and exports unchanged.
 * Source maps never ship, because they embed build-machine paths.
 *
 * Private names are not checked here: that list never enters public CI, and the
 * owner scans a staged tarball locally before approving it.
 */
export type TarballEntry = { path: string; bytes: Uint8Array };
/** Bytes of a tracked repository file, or undefined when the path is not tracked. */
export type TrackedReader = (repositoryPath: string) => Uint8Array | undefined;

const MACHINE_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+[\\/]/;
const DERIVED = /^dist\/(.+)\.(?:js|d\.ts)$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

function checkManifestEntry(entry: PackageEntry, bytes: Uint8Array, readTracked: TrackedReader): string | undefined {
  const tracked = readTracked(`${entry.directory}/package.json`);
  if (!tracked) return "the package has no tracked manifest";
  try {
    const packed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const source = JSON.parse(new TextDecoder().decode(tracked)) as Record<string, unknown>;
    for (const key of ["name", "version", "exports", "dependencies", "peerDependencies"] as const) {
      if (JSON.stringify(packed[key]) !== JSON.stringify(source[key])) return `the packed manifest changes ${key}`;
    }
    return undefined;
  } catch {
    return "the packed manifest is not JSON";
  }
}

export function checkTarballEntries(entry: PackageEntry, entries: readonly TarballEntry[], readTracked: TrackedReader): Finding[] {
  const findings: Finding[] = [];
  const finding = (path: string, rule: string, detail: string): void => { findings.push({ subject: `${entry.name}:${path}`, rule, detail }); };
  if (!entries.some(({ path }) => path === "package.json")) finding("package.json", "manifest", "the tarball has no package.json");
  for (const { path, bytes } of entries) {
    if (path.split("/").includes("..") || path.startsWith("/")) { finding(path, "path", "a packed path leaves the package root"); continue; }
    const text = new TextDecoder().decode(bytes);
    if (MACHINE_PATH.test(text)) finding(path, "machine-path", "a build-machine home path is packed");
    if (carriesPrivateOperationalCoordinate(text, path)) finding(path, "operational-coordinate", "a private operational coordinate is packed");
    if (path.endsWith(".map")) { finding(path, "sourcemap", "source maps do not ship"); continue; }
    if (path === "package.json") { const problem = checkManifestEntry(entry, bytes, readTracked); if (problem) finding(path, "manifest", problem); continue; }
    const derived = DERIVED.exec(path);
    if (derived) {
      const stem = `${entry.directory}/src/${derived[1]}`;
      if (!SOURCE_EXTENSIONS.some((extension) => readTracked(`${stem}${extension}`))) finding(path, "derived-without-source", `no tracked ${stem}.ts produces it`);
      continue;
    }
    const tracked = readTracked(`${entry.directory}/${path}`);
    if (!tracked) finding(path, "unlisted-file", "neither a tracked file nor build output of one");
    else if (!equalBytes(tracked, bytes)) finding(path, "changed-file", "differs from the tracked file");
  }
  return findings;
}
