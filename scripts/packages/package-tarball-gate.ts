import { carriesPrivateOperationalCoordinate } from "../oss-public-coordinate-detector.ts";
import type { Finding, PackageEntry } from "./package-manifest-policy.ts";

/**
 * What may ship inside a packed `@openlup/*` tarball.
 *
 * A tree check sees tracked files; a tarball also carries build output, so the
 * two can differ. Every packed file must therefore be either a tracked file of
 * the package directory, byte for byte (the manifest included), or build
 * output under `dist/` whose tracked, non-test TypeScript source exists. Source
 * maps and source-map references never ship, because they embed build-machine
 * paths. This gate does not check private names.
 */
export type TarballEntry = { path: string; bytes: Uint8Array };
/** Bytes of a tracked repository file at the checked commit, or undefined when the path is not tracked. */
export type TrackedReader = (repositoryPath: string) => Uint8Array | undefined;

const MACHINE_PATH = /(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/|[A-Za-z]:\\{1,2}Users\\{1,2})[A-Za-z0-9._-]+/;
const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;
const DERIVED = /^dist\/(.+)\.(?:js|d\.ts)$/;
const TEST_SOURCE = /\.(?:test|spec)$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

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
    const derived = DERIVED.exec(path);
    if (derived) {
      const stem = `${entry.directory}/src/${derived[1]}`;
      if (SOURCE_MAP_REFERENCE.test(text)) finding(path, "sourcemap", "a source-map reference is packed");
      if (TEST_SOURCE.test(stem)) finding(path, "test-output", "built output of a test file does not ship");
      else if (!SOURCE_EXTENSIONS.some((extension) => readTracked(`${stem}${extension}`))) finding(path, "derived-without-source", `no tracked ${stem}.ts produces it`);
      continue;
    }
    const tracked = readTracked(`${entry.directory}/${path}`);
    if (!tracked) finding(path, path === "package.json" ? "manifest" : "unlisted-file", "neither a tracked file nor build output of one");
    else if (!equalBytes(tracked, bytes)) finding(path, path === "package.json" ? "manifest" : "changed-file", "differs from the tracked file");
  }
  return findings;
}
