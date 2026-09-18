import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";

export type PublicDiagnostic = { file: string; line: number; code: string; message: string };
export type PublicTypecheckSummary = { pairs: string[]; importers: number; targets: number; cascades: number; cascadesByCode: Record<string, number> };
export type PublicTypecheckPin = { unresolvedEdges: { pairs: number; importers: number; targets: number; digest: string; pairHashes: string[] }; inferenceCascades: { diagnostics: number } };
export type TypecheckDebt = { unresolvedEdges: { mode: "exact-ratchet"; pairs: number; importers: number; targets: number; digest: string; pairHashes: string[] }; inferenceCascades: { mode: "ceiling-ratchet"; diagnostics: number } };
export type PublicTypecheckCompatibility = { typecheck: { projects: string[]; signedPreviewDebt: TypecheckDebt } };

/**
 * The owner-signed preview typecheck debt.
 *
 * It used to live inside the tracked source-release contract, which was otherwise a pure cache of
 * the tree. When that cache stopped being a git file this ceiling had to stay in git, because it is
 * the one field of the contract nothing derives: `unresolvedEdges` is an EXACT ratchet (a new pair
 * fails, a paid one fails too and asks for the pin to be lowered) and `inferenceCascades` is an
 * upper bound. Raising either is an owner decision, and it is written here rather than recomputed
 * so that raising it is a reviewable one-line diff instead of a digest that moved.
 *
 * `projects` is NOT pinned beside it: that list is derived from the repository's own `typecheck`
 * script (`projectsFromPackage`), so a project added to the chain is measured automatically.
 */
export const SIGNED_PREVIEW_TYPECHECK_DEBT: TypecheckDebt = {
  unresolvedEdges: { mode: "exact-ratchet", pairs: 0, importers: 0, targets: 0, digest: "sha256-e3b0c44298fc1c149afbf4c8996fb924", pairHashes: [] },
  inferenceCascades: { mode: "ceiling-ratchet", diagnostics: 0 },
};
type JsonObject = Record<string, unknown>;
const CONTRACT_PATH = "config/openlup-source-release-contract.json";
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: string[]): boolean => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function readPublicTypecheckCompatibility(contractSource: string): PublicTypecheckCompatibility {
  let raw: unknown;
  try { raw = JSON.parse(contractSource); } catch { throw new Error(`${CONTRACT_PATH}: unreadable JSON cannot be projected`); }
  if (!object(raw)) throw new Error(`${CONTRACT_PATH}: missing public typecheck compatibility contract`);
  const compatibility = raw.compatibility;
  if (!object(compatibility) || !exactKeys(compatibility, ["typecheck"])) throw new Error(`${CONTRACT_PATH}: missing public typecheck compatibility contract`);
  const typecheck = compatibility.typecheck;
  if (!object(typecheck)) throw new Error(`${CONTRACT_PATH}: missing public typecheck compatibility contract`);
  const debt = typecheck.signedPreviewDebt;
  if (!exactKeys(typecheck, ["projects", "signedPreviewDebt"]) || !Array.isArray(typecheck.projects) || typecheck.projects.length === 0 || typecheck.projects.some((project) => typeof project !== "string" || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.json$/u.test(project)) || new Set(typecheck.projects).size !== typecheck.projects.length || !object(debt) || !exactKeys(debt, ["inferenceCascades", "unresolvedEdges"]) || !object(debt.unresolvedEdges) || !object(debt.inferenceCascades)) throw new Error(`${CONTRACT_PATH}: malformed public typecheck compatibility contract`);
  const edges = debt.unresolvedEdges;
  const cascades = debt.inferenceCascades;
  const hashes = edges.pairHashes;
  const expectedDigest = Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string") ? `sha256-${createHash("sha256").update([...hashes].sort().join("\n")).digest("hex").slice(0, 32)}` : "";
  if (!exactKeys(edges, ["digest", "importers", "mode", "pairHashes", "pairs", "targets"]) || edges.mode !== "exact-ratchet" || !count(edges.pairs) || !count(edges.importers) || !count(edges.targets) || !Array.isArray(hashes) || hashes.length !== edges.pairs || hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{12}$/u.test(hash)) || new Set(hashes).size !== hashes.length || JSON.stringify(hashes) !== JSON.stringify([...hashes].sort()) || edges.digest !== expectedDigest || edges.importers > edges.pairs || edges.targets > edges.pairs || !exactKeys(cascades, ["diagnostics", "mode"]) || cascades.mode !== "ceiling-ratchet" || !count(cascades.diagnostics)) throw new Error(`${CONTRACT_PATH}: malformed signed preview typecheck debt`);
  return compatibility as PublicTypecheckCompatibility;
}

export function parsePublicDiagnostics(output: string): { positioned: PublicDiagnostic[]; unpositioned: string[] } {
  const positioned: PublicDiagnostic[] = [];
  const unpositioned: string[] = [];
  for (const line of output.split("\n")) {
    if (/^\s/u.test(line) || line.trim() === "") continue;
    const match = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/u.exec(line);
    if (match) positioned.push({ file: match[1].replace(/\\/gu, "/"), line: Number(match[2]), code: match[4], message: match[5] });
    else if (/^error\s+TS\d+:/u.test(line.trim())) unpositioned.push(line.trim());
  }
  return { positioned, unpositioned };
}

const resolveTarget = (importer: string, specifier: string): string => specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(importer), specifier)) : specifier;
export const publicPairHash = (pair: string): string => createHash("sha256").update(pair).digest("hex").slice(0, 12);

export function summarizePublicDiagnostics(diagnostics: PublicDiagnostic[]): PublicTypecheckSummary {
  const pairs = new Set<string>();
  const importers = new Set<string>();
  const targets = new Set<string>();
  const cascadesByCode: Record<string, number> = {};
  const cascades = new Set<string>();
  for (const diagnostic of diagnostics) {
    const missing = /Cannot find module '([^']+)'/u.exec(diagnostic.message);
    if (missing) {
      const target = resolveTarget(diagnostic.file, missing[1]);
      pairs.add(`${diagnostic.file} -> ${target}`); importers.add(diagnostic.file); targets.add(target);
    } else {
      const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.code}`;
      if (!cascades.has(key)) { cascades.add(key); cascadesByCode[diagnostic.code] = (cascadesByCode[diagnostic.code] ?? 0) + 1; }
    }
  }
  return { pairs: [...pairs].sort(), importers: importers.size, targets: targets.size, cascades: cascades.size, cascadesByCode };
}

export function runPublicTypecheckProjects(root: string, projects: string[]): { positioned: PublicDiagnostic[]; unpositioned: string[] } {
  const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(compiler)) throw new Error("the compiler did not run (node_modules/typescript/bin/tsc is absent)");
  const positioned: PublicDiagnostic[] = [];
  const unpositioned: string[] = [];
  for (const project of projects) {
    const run = spawnSync(process.execPath, [compiler, "-p", project, "--noEmit", "--pretty", "false"], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    if (run.error || run.status === null) throw new Error(`${project}: the compiler did not run (${run.error?.message ?? "no exit status"})`);
    const parsed = parsePublicDiagnostics(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
    if (run.status !== 0 && parsed.positioned.length === 0 && parsed.unpositioned.length === 0) throw new Error(`${project}: the compiler did not run successfully (exit ${run.status})`);
    positioned.push(...parsed.positioned);
    unpositioned.push(...parsed.unpositioned.map((line) => `${project}: ${line}`));
  }
  return { positioned, unpositioned };
}

export function comparePublicTypecheck(summary: PublicTypecheckSummary, pin: PublicTypecheckPin): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const pinned = new Set(pin.unresolvedEdges.pairHashes);
  const measuredHashes = summary.pairs.map(publicPairHash);
  const introduced = summary.pairs.filter((pair) => !pinned.has(publicPairHash(pair)));
  const paid = pin.unresolvedEdges.pairHashes.filter((hash) => !measuredHashes.includes(hash)).length;
  if (introduced.length > 0) lines.push(`${introduced.length} unresolved edge(s) that the pin does not carry - a published tree would gain them:`, ...introduced.map((pair) => `  + ${pair}`));
  if (paid > 0) lines.push(`${paid} pinned edge(s) are gone: measured ${summary.pairs.length} against pin ${pin.unresolvedEdges.pairs}.`);
  if (summary.cascades > pin.inferenceCascades.diagnostics) lines.push(`consumer-side errors grew: ${summary.cascades} against ceiling ${pin.inferenceCascades.diagnostics} (${JSON.stringify(summary.cascadesByCode)}).`);
  else if (summary.cascades < pin.inferenceCascades.diagnostics) lines.push(`note: consumer-side errors fell to ${summary.cascades} from ceiling ${pin.inferenceCascades.diagnostics}; the ceiling may be lowered.`);
  return { ok: introduced.length === 0 && paid === 0 && summary.cascades <= pin.inferenceCascades.diagnostics, lines };
}
