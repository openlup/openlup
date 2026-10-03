import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = "config/openlup-neutrality-baseline.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const blobIdentity = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const scannerPaths = [
  "packages/core/scripts/neutrality-source-scanner.ts",
  "packages/core/scripts/neutrality-shell-fold.ts",
  "packages/core/scripts/neutrality-tree-counts.ts",
  "packages/ui/smoke/neutrality.ts",
];
// Exact initial counting interfaces, reviewed with this installation. Existing
// matcher and shell-fold bytes must additionally equal the trusted base.
const initialAdapters = {
  "packages/core/scripts/neutrality-tree-counts.ts": "2999eae190b237ababb4ab75a82e9288c58c4b3c",
  "packages/ui/smoke/neutrality.ts": "18a59f35931a273537d02a460e9b0b4b69c02c1f",
};
const categoryPattern = /^(?:brand|legacy-env|ui-(?:[0-9]|1[0-7]))$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (path) => JSON.stringify(path);

export function neutralityIncreases(baseline, current) {
  const increases = [];
  for (const [path, counts] of Object.entries(current)) for (const [category, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("neutrality counts must be nonnegative integers");
    if (count > (baseline[path]?.[category] ?? 0)) increases.push({ path, category, before: baseline[path]?.[category] ?? 0, after: count });
  }
  return increases;
}
// Exact owner-reviewed diagnostic-fixture recalibration. This admission applies
// only to its introduction base; later bases use the ordinary shrink ratchet.
const fixtureIntroductionBase = "e863fe06bee931b26e0e868fbbc3d5eb2d26d16d";
const reviewedDiagnosticFixtures = [
  ["supabase/tests/anon_write_privilege_revoke_test.sql", "25072d998c2369f0058293b19e6c6e4f76941d45a028f1f0a5ff73429007ee6d", 0, 1],
  ["supabase/tests/fulfillment_replacement_sequence_test.sql", "d02bbe3b35d5d29cfc45a17e9c1d1d17aab1c92ede79b3049011f8e1fc033b83", 0, 1],
  ["supabase/tests/channel_order_reaches_the_dispatch_gate_test.sql", "426a6c565cadcd0ed32d870bdfab1818479a8e0e1adc7da310c6ea5b59484f82", 1, 2],
  ["supabase/tests/payment_recovery_sha256_test.sql", "a7ba80b2c3b367ed17bb1fd69a4c49e07252b6b04363f3b24d9fa8b19dbb9919", 1, 2],
  ["supabase/tests/subscription_starter_cycle_order_discount_test.sql", "c8452657e76f50d245a19e96acee781813fba4f1c6923fe07a285205a7a94da6", 1, 2],
];
export function unreviewedDiagnosticFixtureIncreases(increases, snapshots, sourceBase) {
  if (sourceBase !== fixtureIntroductionBase) return increases;
  return increases.filter((row) => !reviewedDiagnosticFixtures.some(([path, digest, before, after]) =>
    row.path === hash(path) && row.category === "ui-15" && row.before === before && row.after === after
      && snapshots.has(path) && hash(snapshots.get(path)) === digest));
}
export function validateBaseline(baseline) {
  if (!record(baseline) || baseline.schemaVersion !== 2 || !/^[a-f0-9]{40}$/.test(baseline.sourceCommit) || !record(baseline.counts)) throw new Error("invalid neutrality baseline");
  if (!record(baseline.scannerPins) || JSON.stringify(Object.keys(baseline.scannerPins).sort()) !== JSON.stringify([...scannerPaths].sort())) throw new Error("invalid neutrality scanner pins");
  for (const pin of Object.values(baseline.scannerPins)) if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error("invalid neutrality scanner pin identity");
  for (const [path, counts] of Object.entries(baseline.counts)) {
    if (!/^[a-f0-9]{64}$/.test(path) || !record(counts)) throw new Error("invalid neutrality baseline path");
    for (const [category, count] of Object.entries(counts)) if (!categoryPattern.test(category) || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid neutrality baseline count");
  }
}
function git(args, options = {}) {
  try { return execFileSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options }); }
  catch { throw new Error("neutrality Git inventory or object unavailable"); }
}
function inventoryRecords(args) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(git(args)).split("\0").filter(Boolean); }
  catch { throw new Error("unsupported or unavailable UTF-8 Git inventory"); }
}
function validPath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsupported inventory path: ${label(path)}`);
  return path;
}
function readLocal(path, deletionAllowed = false) {
  validPath(path);
  const components = path.split("/");
  for (let index = 1; index <= components.length; index++) {
    const component = components.slice(0, index).join("/");
    let stat;
    try { stat = lstatSync(join(root, component)); }
    catch (error) {
      if (deletionAllowed && error.code === "ENOENT") return undefined;
      throw new Error(`unreadable inventory path: ${label(path)}`);
    }
    if (stat.isSymbolicLink() || (index < components.length ? !stat.isDirectory() : !stat.isFile())) throw new Error(`unsupported filesystem entry: ${label(component)}`);
  }
  try { return readFileSync(join(root, path)); }
  catch { throw new Error(`unreadable inventory path: ${label(path)}`); }
}
function treeBytes(ref) {
  const entries = inventoryRecords(["ls-tree", "-r", "-z", ref]).map((entry) => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("unsupported Git inventory record");
    if (!["100644", "100755"].includes(match[1]) || match[2] !== "blob") throw new Error(`unsupported Git inventory object: ${label(match[4])}`);
    return { oid: match[3], path: validPath(match[4]) };
  });
  // Requests contain object identities, never pathname expressions or delimiters.
  const output = git(["cat-file", "--batch"], { input: entries.map(({ oid }) => `${oid}\n`).join("") });
  let offset = 0;
  const snapshots = new Map();
  for (const { oid, path } of entries) {
    const end = output.indexOf(10, offset);
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(output.subarray(offset, end).toString("utf8"));
    if (!match || match[1] !== oid) throw new Error(`unreadable inventory blob: ${label(path)}`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || end + size + 1 >= output.length || output[end + size + 1] !== 10) throw new Error(`invalid inventory blob: ${label(path)}`);
    snapshots.set(path, output.subarray(end + 1, end + size + 1));
    offset = end + size + 2;
  }
  if (offset !== output.length) throw new Error("invalid Git blob transport");
  return snapshots;
}
function workingBytes() {
  const snapshots = new Map();
  for (const entry of inventoryRecords(["ls-files", "--stage", "-z"])) {
    const match = /^(\d{6}) [a-f0-9]{40} (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("unsupported Git index record");
    if (!["100644", "100755"].includes(match[1]) || match[2] !== "0") throw new Error(`unsupported or unmerged Git index object: ${label(match[3])}`);
    const bytes = readLocal(match[3], true);
    if (bytes !== undefined) snapshots.set(match[3], bytes);
  }
  for (const path of inventoryRecords(["ls-files", "--others", "--exclude-standard", "-z"])) snapshots.set(path, readLocal(path));
  return new Map([...snapshots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function pinsFor(snapshots) {
  return Object.fromEntries(scannerPaths.map((path) => {
    const bytes = snapshots.get(path);
    if (!bytes) throw new Error(`missing scanner source: ${label(path)}`);
    return [path, blobIdentity(bytes)];
  }));
}
function validateScannerChain(snapshots) {
  for (const path of scannerPaths) {
    const source = snapshots.get(path)?.toString("utf8");
    if (source === undefined) throw new Error(`missing scanner source: ${label(path)}`);
    if (/\b(?:import|require)\s*\(/u.test(source) || /^[ \t]*import\s*["']/m.test(source)) throw new Error(`unchecked scanner dependency: ${label(path)}`);
    for (const [, specifier] of source.matchAll(/^[ \t]*(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["'];/gm)) {
      if (specifier.startsWith("node:")) continue;
      const dependency = resolve(root, dirname(path), specifier);
      if (!scannerPaths.some((allowed) => join(root, allowed) === dependency)) throw new Error(`unchecked scanner dependency: ${label(path)}`);
    }
  }
}
function verifyPins(parent, current, base) {
  validateScannerChain(current);
  const pins = pinsFor(current);
  for (const path of scannerPaths) {
    const approved = parent ? parent.scannerPins[path] : initialAdapters[path] ?? (base.get(path) && blobIdentity(base.get(path)));
    if (!approved || pins[path] !== approved) throw new Error(`${parent ? "scanner pin drift" : "unreviewed initial scanner identity"}: ${label(path)}`);
    if (parent && (!base.get(path) || blobIdentity(base.get(path)) !== approved)) throw new Error(`base scanner pin drift: ${label(path)}`);
  }
  return pins;
}
function scanSnapshots(snapshots) {
  const sources = [], binary = [];
  for (const [path, bytes] of snapshots) {
    try {
      if (bytes.includes(0)) throw new Error("binary");
      sources.push({ path, contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } catch { binary.push(path); }
  }
  const invoke = (path, input, args = []) => {
    try { return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", path, ...args], { cwd: root, input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })); }
    catch { throw new Error(`neutrality scanner failed: ${label(path)}`); }
  };
  const ui = invoke("packages/ui/smoke/neutrality.ts", sources, ["--counts-json"]);
  if (!record(ui) || !Array.isArray(ui.counts) || !record(ui.policy)) throw new Error("invalid neutrality scanner output");
  const core = invoke("packages/core/scripts/neutrality-tree-counts.ts", { sources, policy: ui.policy });
  if (!Array.isArray(core)) throw new Error("invalid neutrality scanner output");
  const paths = Object.fromEntries([...snapshots.keys()].map((path) => [hash(path), path]));
  const rows = {};
  for (const row of [...ui.counts, ...core]) {
    if (!record(row) || !snapshots.has(row.path) || !record(row.counts)) throw new Error("invalid neutrality scanner row");
    for (const [category, count] of Object.entries(row.counts)) if (!categoryPattern.test(category) || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid neutrality scanner count");
    if (Object.keys(row.counts).length) rows[hash(row.path)] = { ...rows[hash(row.path)], ...row.counts };
  }
  return { rows: Object.fromEntries(Object.entries(rows).sort()), paths, textFiles: sources.length, binaryFiles: binary.length, binary };
}
export function scanTree(ref) { return scanSnapshots(ref ? treeBytes(ref) : workingBytes()); }
function baseCommit(args) {
  const index = args.indexOf("--base-commit");
  const explicit = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && !explicit) throw new Error("missing neutrality base SHA");
  if (explicit && (!/^[a-f0-9]{40}$/.test(explicit) || /^0+$/.test(explicit))) throw new Error("neutrality base must be a nonzero full commit SHA");
  if (index >= 0) args.splice(index, 2);
  return git(["rev-parse", "--verify", `${explicit ?? "origin/main"}^{commit}`], { encoding: "utf8" }).trim();
}
function parseBaseline(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("invalid neutrality baseline JSON"); }
  validateBaseline(value);
  return value;
}
function report(increases, paths) {
  for (const row of increases) console.error(`${label(paths[row.path] ?? row.path)}: ${row.category} increased ${row.before} -> ${row.after}`);
}
function main() {
  const options = process.argv.slice(2);
  const base = baseCommit(options);
  if (options.length > 1 || (options[0] !== undefined && options[0] !== "--write-baseline")) throw new Error("expected no option or --write-baseline");
  const baseBytes = treeBytes(base);
  const parent = baseBytes.has(baselinePath) ? parseBaseline(baseBytes.get(baselinePath)) : undefined;
  const currentBytes = workingBytes();
  const scannerPins = verifyPins(parent, currentBytes, baseBytes);
  const measuredBase = scanSnapshots(baseBytes);
  const current = scanSnapshots(currentBytes);
  for (const path of current.binary) if (Object.keys(measuredBase.rows[hash(path)] ?? {}).length) throw new Error(`contaminated text became binary: ${label(path)}`);
  const baseIncreases = unreviewedDiagnosticFixtureIncreases(neutralityIncreases(measuredBase.rows, current.rows), currentBytes, base);
  if (options[0] === "--write-baseline") {
    const counts = parent ? current.rows : measuredBase.rows;
    const raised = parent ? unreviewedDiagnosticFixtureIncreases(neutralityIncreases(parent.counts, counts), currentBytes, base) : [];
    if (baseIncreases.length || raised.length) {
      report([...baseIncreases, ...raised], { ...measuredBase.paths, ...current.paths });
      throw new Error("baseline regeneration would increase accepted debt");
    }
    readLocal(baselinePath, true); // Refuse a symlink or nonregular target.
    try { writeFileSync(join(root, baselinePath), `${JSON.stringify({ schemaVersion: 2, sourceCommit: base, scannerPins, counts }, null, 2)}\n`); }
    catch { throw new Error(`unable to write neutrality baseline: ${label(baselinePath)}`); }
  } else {
    if (!currentBytes.has(baselinePath)) throw new Error("neutrality baseline missing or removed");
    const baseline = parseBaseline(currentBytes.get(baselinePath));
    for (const path of scannerPaths) if (baseline.scannerPins[path] !== scannerPins[path]) throw new Error(`baseline scanner pin drift: ${label(path)}`);
    if (!parent && (baseline.sourceCommit !== base || JSON.stringify(baseline.counts) !== JSON.stringify(measuredBase.rows))) throw new Error("initial neutrality baseline must equal the measured base tree");
    const raised = parent ? unreviewedDiagnosticFixtureIncreases(neutralityIncreases(parent.counts, baseline.counts), currentBytes, base) : [];
    // The candidate must fit the explicitly recalibrated baseline, even at introduction.
    const increases = neutralityIncreases(baseline.counts, current.rows);
    report([...baseIncreases, ...raised, ...increases], { ...measuredBase.paths, ...current.paths });
    console.log(`Neutrality: ${current.textFiles} text files, ${current.binaryFiles} binary files inventoried; ${baseIncreases.length + raised.length + increases.length} increases. Base ${base}; candidate ${git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}; path keys are SHA-256 hashes of exact relative paths.`);
    if (baseIncreases.length || raised.length || increases.length) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
