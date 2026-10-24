/** Shared offline artifact budgets; policy values live in each package's release-gates.json. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { releaseVersionAbove, type Finding, type PackageEntry } from "./package-manifest-policy.ts";
import type { TarballEntry } from "./package-tarball-gate.ts";

type ClassBudget = { maxPackedBytes: number; maxFiles: number };
export type PackBudget = ClassBudget & {
  code: ClassBudget;
  docs: ClassBudget;
  maxUnpackedBytes: number;
  baseline: { version: string; packedBytes: number };
  browserEntries: Record<string, number>;
};
export type PackMeasurement = { packedBytes: number; unpackedBytes: number; files: number; code: { packedBytes: number; files: number }; docs: { packedBytes: number; files: number } };

/** Same compressed class measure as core's release:pack: sorted contents gzipped together, not a tar. */
export function measurePack(entries: readonly TarballEntry[], packedBytes: number): PackMeasurement {
  const group = (kind: "code" | "docs") => {
    const files = entries.filter(({ path }) => kind === "code" ? /^(?:dist\/.+\.(?:[cm]?js|d\.[cm]?ts)|src\/.+\.tsx?)$/u.test(path) : !path.includes("/"));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { packedBytes: gzipSync(Buffer.concat(files.map(({ bytes }) => bytes))).length, files: files.length };
  };
  return { packedBytes, unpackedBytes: entries.reduce((sum, { bytes }) => sum + bytes.length, 0), files: entries.length, code: group("code"), docs: group("docs") };
}

export function readPackBudget(root: string, entry: PackageEntry): PackBudget {
  const file = `${entry.directory}/release-gates.json`;
  const pack = (JSON.parse(readFileSync(join(root, file), "utf8")) as { pack: PackBudget }).pack;
  const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
  if (!pack || ![pack.maxPackedBytes, pack.maxFiles, pack.maxUnpackedBytes, pack.code?.maxPackedBytes, pack.code?.maxFiles, pack.docs?.maxPackedBytes, pack.docs?.maxFiles, pack.baseline?.packedBytes].every(positive)
    || typeof pack.baseline?.version !== "string" || releaseVersionAbove(pack.baseline.version, "0.0.0") !== true
    || !pack.browserEntries || Array.isArray(pack.browserEntries) || typeof pack.browserEntries !== "object" || !Object.values(pack.browserEntries).every(positive)) throw new Error(`${file}: package-size-policy requires positive integer caps, a released baseline and browserEntries`);
  return pack;
}

export function checkPackBudget(entry: PackageEntry, budget: PackBudget, measured: PackMeasurement, releaseSet?: string, changelog = "", releaseNotes?: string): Finding[] {
  const findings: Finding[] = [];
  const cap = (label: string, value: number, limit: number): void => {
    if (value > limit) findings.push({ subject: entry.name, rule: "package-size-cap", detail: `${label} ${value} exceeds cap ${limit}; raise the cap in a reviewed PR` });
  };
  for (const kind of ["code", "docs"] as const) {
    cap(`${kind} packed bytes`, measured[kind].packedBytes, budget[kind].maxPackedBytes);
    cap(`${kind} files`, measured[kind].files, budget[kind].maxFiles);
  }
  cap("tarball packed bytes", measured.packedBytes, budget.maxPackedBytes);
  cap("unpacked bytes", measured.unpackedBytes, budget.maxUnpackedBytes);
  cap("files", measured.files, budget.maxFiles);
  if (releaseSet === undefined) return findings;
  if (releaseVersionAbove(releaseSet, budget.baseline.version) !== true) {
    findings.push({ subject: entry.name, rule: "package-growth-baseline", detail: `release set ${releaseSet} must be newer than baseline ${budget.baseline.version}; use the previously released version and its tarball bytes as the baseline, never the candidate set` });
    return findings;
  }
  const sections = changelog.split(/^(?=## )/mu).filter((section) => section.startsWith(`## [${releaseSet}]\n`));
  const prefix = `- ${entry.name} size growth: `;
  const explained = sections.length === 1 && sections[0]!.split("\n").some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim() !== "");
  if (measured.packedBytes * 100 > budget.baseline.packedBytes * 130) {
    if (!explained) findings.push({ subject: entry.name, rule: "package-size-growth", detail: `packed bytes ${measured.packedBytes} grew >30% from ${budget.baseline.version} (${budget.baseline.packedBytes}); add "${prefix}<explanation>" to CHANGELOG.md section [${releaseSet}]` });
    if (releaseNotes !== undefined && !releaseNotes.split("\n").some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim() !== "")) findings.push({ subject: entry.name, rule: "package-size-growth", detail: `packed bytes ${measured.packedBytes} grew >30% from ${budget.baseline.version} (${budget.baseline.packedBytes}); add "${prefix}<explanation>" to the dispatched RELEASE_NOTES` });
  }
  return findings;
}

/** Bundle every runtime export, with dependencies included. No tree-shaken consumer subset or external imports. */
export function browserEntryBytes(directory: string, target: string): number {
  const script = `import { rolldown } from ${JSON.stringify(import.meta.resolve("rolldown"))};
import { gzipSync } from 'node:zlib';
const bundle = await rolldown({ input: ${JSON.stringify(join(directory, target))}, platform: 'browser', onLog(level, log) { throw new Error(log.message); } });
try {
  const { output } = await bundle.generate({ format: 'es', minify: true, inlineDynamicImports: true });
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('browser entry must produce one bundle');
  process.stdout.write(String(gzipSync(output[0].code).length));
} finally { await bundle.close(); }`;
  return Number(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }));
}

export function checkBrowserEntry(entry: PackageEntry, subpath: string, measured: number, cap: number): Finding[] {
  return measured <= cap ? [] : [{ subject: `${entry.name}:${subpath}`, rule: "browser-entry-size", detail: `minified+gzip bytes ${measured} exceeds cap ${cap}; raise the cap in a reviewed PR` }];
}
