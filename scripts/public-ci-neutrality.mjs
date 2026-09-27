import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = "config/openlup-neutrality-baseline.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function neutralityIncreases(baseline, current) {
  const increases = [];
  for (const [path, counts] of Object.entries(current)) for (const [category, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("neutrality counts must be nonnegative integers");
    if (count > (baseline[path]?.[category] ?? 0)) increases.push({ path, category, before: baseline[path]?.[category] ?? 0, after: count });
  }
  return increases;
}

export function scanTree(ref) {
  const paths = [...new Set(execFileSync("git", ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean))].sort();
  const snapshots = new Map();
  if (ref) {
    const output = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: paths.map((path) => `${ref}:${path}\n`).join(""), maxBuffer: 256 * 1024 * 1024 });
    let offset = 0;
    for (const path of paths) {
      const end = output.indexOf(10, offset);
      const header = output.subarray(offset, end).toString("utf8");
      const match = /^[a-f0-9]{40} blob (\d+)$/.exec(header);
      if (!match) throw new Error(`unreadable baseline blob: ${path}`);
      const size = Number(match[1]);
      snapshots.set(path, output.subarray(end + 1, end + 1 + size));
      offset = end + 2 + size;
    }
  }
  const sources = [], binary = [];
  for (const path of paths) {
    const bytes = ref ? snapshots.get(path) : readFileSync(join(root, path));
    try {
      if (bytes.includes(0)) throw new Error("binary");
      sources.push({ path, contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } catch { binary.push(path); }
  }
  const invoke = (path, input, args = []) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", path, ...args], { cwd: root, input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const ui = invoke("packages/ui/smoke/neutrality.ts", sources, ["--counts-json"]);
  const core = invoke("packages/core/scripts/neutrality-tree-counts.ts", { sources, policy: ui.policy });
  const rows = {};
  for (const row of [...ui.counts, ...core]) if (Object.keys(row.counts).length) rows[hash(row.path)] = { ...rows[hash(row.path)], ...row.counts };
  return { rows: Object.fromEntries(Object.entries(rows).sort()), paths: Object.fromEntries(paths.map((path) => [hash(path), path])), textFiles: sources.length, binaryFiles: binary.length };
}

function baseCommit() {
  const index = process.argv.indexOf("--base-commit");
  const explicit = index < 0 ? undefined : process.argv[index + 1];
  if (index >= 0 && !explicit) throw new Error("missing neutrality base SHA");
  if (explicit && !/^[a-f0-9]{40}$/.test(explicit)) throw new Error("neutrality base must be a full commit SHA");
  return execFileSync("git", ["rev-parse", "--verify", `${explicit ?? "origin/main"}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
}
function readParent(base) {
  const paths = execFileSync("git", ["ls-tree", "--name-only", base, "--", baselinePath], { cwd: root, encoding: "utf8" });
  if (!paths.trim()) return undefined;
  return JSON.parse(execFileSync("git", ["show", `${base}:${baselinePath}`], { cwd: root, encoding: "utf8" }));
}
function main() {
  const base = baseCommit();
  const parent = readParent(base);
  const options = process.argv.slice(2);
  const baseIndex = options.indexOf("--base-commit");
  if (baseIndex >= 0) options.splice(baseIndex, 2);
  if (options.length > 1) throw new Error("unknown neutrality options");
  const mode = options[0];
  const current = scanTree(mode === "--write-baseline" ? base : undefined);
  if (mode === "--write-baseline") {
    if (parent && neutralityIncreases(parent.counts, current.rows).length) throw new Error("baseline regeneration would increase accepted debt");
    writeFileSync(join(root, baselinePath), `${JSON.stringify({ schemaVersion: 1, sourceCommit: base, counts: current.rows }, null, 2)}\n`);
  } else if (mode === undefined) {
    const baseline = JSON.parse(readFileSync(join(root, baselinePath), "utf8"));
    if (baseline.schemaVersion !== 1 || !baseline.counts || typeof baseline.counts !== "object") throw new Error("invalid neutrality baseline");
    const raised = parent ? neutralityIncreases(parent.counts, baseline.counts) : [];
    const increases = neutralityIncreases(baseline.counts, current.rows);
    for (const row of [...raised, ...increases]) console.error(`${current.paths[row.path] ?? row.path}: ${row.category} increased ${row.before} -> ${row.after}`);
    console.log(`Neutrality: ${current.textFiles} text files, ${current.binaryFiles} binary files inventoried; ${increases.length + raised.length} increases. Baseline path keys are SHA-256 hashes of exact relative paths.`);
    if (increases.length || raised.length) process.exitCode = 1;
  } else throw new Error("expected no option or --write-baseline");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
