import { carriesPrivateOperationalCoordinate } from "../oss-public-coordinate-detector.ts";
import { posix } from "node:path";
import { exportTargets, type Finding, type PackageEntry } from "./package-manifest-policy.ts";

/**
 * What may ship inside a packed `@openlup/*` tarball.
 *
 * A tree check sees tracked files; a tarball also carries build output, so the
 * two can differ. Every packed file must therefore be either a tracked file of
 * the package directory, byte for byte (the manifest included), or build
 * output under `dist/` whose tracked, non-test TypeScript source exists. Source
 * declaration maps may point only to their shipped, tracked TypeScript source.
 * JavaScript source maps and machine paths never ship. This gate does not check private names.
 */
export type TarballEntry = { path: string; bytes: Uint8Array };
/** Bytes of a tracked repository file at the checked commit, or undefined when the path is not tracked. */
export type TrackedReader = (repositoryPath: string) => Uint8Array | undefined;

const MACHINE_PATH = /(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/|[A-Za-z]:\\{1,2}Users\\{1,2})[A-Za-z0-9._-]+/;
const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;
const DERIVED = /^dist\/(.+)\.(?:js|d\.ts(?:\.map)?)$/;
const TEST_SOURCE = /\.(?:test|spec)$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
// Shipped TypeScript is intentional: core-source exports are part of the current artifact contract.
const ALLOWED_CONTENT = /^(?:package\.json|release-gates\.json|LICENSE|[^/]+\.md|(?:docs|api)\/.+\.md|dist\/.+\.d\.ts\.map|(?:src|dist)\/.+\.(?:[cm]?js|tsx?|d\.[cm]?ts)|sql\/(?:.+\.sql|manifest\.json))$/u;
const FORBIDDEN_CONTENT = /(?:^|\/)(?:__tests__|tests?|fixtures?|__fixtures__|coverage|\.vscode|\.idea)(?:\/|$)|(?:^|\/)\.env[^/]*$|(?:^|\/)\.DS_Store$|\.(?:test|spec)\.|(?:testFixtures|fixtures?)\.|\.(?:map|swp|tsbuildinfo|tgz)$|~$/iu;
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

export function checkTarballEntries(entry: PackageEntry, entries: readonly TarballEntry[], readTracked: TrackedReader): Finding[] {
  const findings: Finding[] = [];
  const finding = (path: string, rule: string, detail: string): void => { findings.push({ subject: `${entry.name}:${path}`, rule, detail }); };
  const packedPaths = new Set(entries.map(({ path }) => path));
  // A declaration map ships only when its adjacent declaration references it.
  const declarationMaps: string[] = [];
  const referencedMaps = new Set<string>();
  if (!packedPaths.has("package.json")) finding("package.json", "manifest", "the tarball has no package.json");
  const manifestBytes = readTracked(`${entry.directory}/package.json`);
  if (manifestBytes) {
    // The manifest policy validated this tracked manifest before packing it.
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { exports?: unknown };
    const checked = new Set<string>();
    for (const { conditions, target } of exportTargets(manifest.exports)) {
      if (checked.has(target)) continue;
      checked.add(target);
      const path = target.slice(2);
      if (!packedPaths.has(path)) finding(path, "missing-export", `${conditions.join(" > ")} target ${target} is not packed`);
    }
  }
  for (const { path, bytes } of entries) {
    if (path.split("/").includes("..") || path.startsWith("/")) { finding(path, "path", "a packed path leaves the package root"); continue; }
    const text = new TextDecoder().decode(bytes);
    if (MACHINE_PATH.test(text)) finding(path, "machine-path", "a build-machine home path is packed");
    if (carriesPrivateOperationalCoordinate(text, path)) finding(path, "operational-coordinate", "a private operational coordinate is packed");
    const declarationMap = /^dist\/.+\.d\.ts\.map$/u.test(path);
    if (path.endsWith(".map") && !declarationMap) { finding(path, "sourcemap", "only declaration maps to shipped source may ship"); continue; }
    if (FORBIDDEN_CONTENT.test(declarationMap ? path.slice(0, -4) : path) || !ALLOWED_CONTENT.test(path)) { finding(path, "package-content-allowlist", "this file kind does not ship; remove it from the package"); continue; }
    const derived = DERIVED.exec(path);
    if (derived) {
      const stem = `${entry.directory}/src/${derived[1]}`;
      if (declarationMap) {
        let valid = false;
        try {
          const map = JSON.parse(text);
          const source = Array.isArray(map.sources) && map.sources.length === 1 && typeof map.sources[0] === "string"
            ? posix.normalize(posix.join(posix.dirname(path), map.sources[0])) : "";
          valid = map.version === 3 && map.file === posix.basename(path.slice(0, -4)) &&
            map.sources[0] === posix.relative(posix.dirname(path), source) &&
            (map.sourceRoot === undefined || map.sourceRoot === "") && map.sourcesContent === undefined &&
            packedPaths.has(path.slice(0, -4)) && SOURCE_EXTENSIONS.some(extension =>
              source === `src/${derived[1]}${extension}` && packedPaths.has(source) && !!readTracked(`${entry.directory}/${source}`));
        } catch { /* Malformed JSON is a refused declaration map. */ }
        if (!valid) finding(path, "sourcemap", "declaration map must resolve to its shipped tracked source and declaration");
        else declarationMaps.push(path);
      } else if (SOURCE_MAP_REFERENCE.test(text)) {
        const expected = `//# sourceMappingURL=${posix.basename(path)}.map`;
        const references = text.split("\n").filter(line => SOURCE_MAP_REFERENCE.test(line));
        if (!path.endsWith(".d.ts") || references.length !== 1 || references[0] !== expected || !packedPaths.has(`${path}.map`))
          finding(path, "sourcemap", "only a local declaration-map reference may ship");
        else referencedMaps.add(`${path}.map`);
      }
      if (TEST_SOURCE.test(stem)) finding(path, "test-output", "built output of a test file does not ship");
      else if (!SOURCE_EXTENSIONS.some((extension) => readTracked(`${stem}${extension}`))) finding(path, "derived-without-source", `no tracked ${stem}.ts produces it`);
      continue;
    }
    const tracked = readTracked(`${entry.directory}/${path}`);
    if (!tracked) finding(path, path === "package.json" ? "manifest" : "unlisted-file", "neither a tracked file nor build output of one");
    else if (!equalBytes(tracked, bytes)) finding(path, path === "package.json" ? "manifest" : "changed-file", "differs from the tracked file");
  }
  for (const path of declarationMaps) {
    if (!referencedMaps.has(path)) finding(path, "sourcemap", "declaration map must be referenced by its adjacent declaration");
  }
  return findings;
}
