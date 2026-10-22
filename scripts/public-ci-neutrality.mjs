import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Owner-approved opt-in adapter vocabulary. Only ui-12 is affected; all
// other categories and neutral sources stay checked. Subpath vocabulary outside
// adapter directories is limited to the exact owner-approved files below.
const adapterNames = ["res" + "end", "kla" + "viyo"];
const adapterWord = new RegExp(`\\b${adapterNames[0]}\\b`, "gi");
const adapterPaths = new RegExp(`^packages/platform/(?:src|test)/communications/(?:${adapterNames.join("|")})/`);
const adapterReports = new Set(adapterNames.map((name) => `packages/platform/api/communications-${name}.api.md`));
const adapterLedger = "docs/platform/plans/oss-a1-communications-adapters.md";
const adapterSubpathFiles = new Set([
  "server/runtime/communications/a1ReferenceBinding.ts",
  "server/runtime/communications/a1ReferenceBinding.test.ts",
  "packages/platform/package.json",
  "packages/platform/release-gates.json",
  "packages/platform/test/packageBoundary.test.ts",
  "config/openlup-publication-catalog.json",
  "packages/platform/CHANGELOG.md",
  "packages/platform/CHANGELOG-HISTORY.md",
  "docs/platform/CANONICAL_CONTRACTS.md",
  "docs/platform/ARCHITECTURE_AND_EXTENSIONS.md",
  adapterLedger,
]);
// Match complete path segments, including installed file paths, but not longer
// or differently cased tokens. ui-12 counts only the first adapter name.
const adapterSubpath = new RegExp(`(?<![\\w-])communications/(?:${adapterNames.join("|")})(?![\\w-])`, "g");
// Coordinator-approved filename and relative-entry tokens remain file-scoped.
const adapterReportFiles = new Set([
  "packages/platform/release-gates.json",
  "config/openlup-publication-catalog.json",
]);
const adapterReportToken = new RegExp(`(?<![\\w.-])communications-(?:${adapterNames.join("|")})\\.api\\.md(?![\\w./-])`, "g");
const adapterRelativeEntry = new RegExp(`(?<![\\w./-])\\./(?:${adapterNames.join("|")})/index\\.js(?![\\w./-])`, "g");
// Exact complete cold-proof lines, rather than a file-wide or arbitrary marked
// block exemption. Editing a line requires another explicit policy review.
const coldProofLines = Object.fromEntries(Object.entries({
  "scripts/packages/platform-cold-consumer.ts": [
    "  \"communications/$ADAPTER\",",
    "const adapter = await import(\"@openlup/platform/communications/$ADAPTER\");",
    "    compileConsumer(consumer, [\"communications/$ADAPTER\"], compiler);"
  ],
  "scripts/packages/platform-cold-consumer.test.ts": [
    "  metadata.exports[\"./communications/$ADAPTER\"] = \"./communications/$ADAPTER/index.js\";",
    "  mkdirSync(join(packageRoot, \"communications/$ADAPTER\"), { recursive: true });",
    "  for (const path of [\"$ADAPTER/index.js\", \"emailTransport.js\", \"emailEgress.js\", \"emailObservation.js\", \"deliveryReconciliation.js\"]) {",
    "  const path = join(packageRoot, \"communications/$ADAPTER/index.js\");",
    "it(\"proves the installed $Adapter surface with no SDK/optional peers and only injected IO\", () => {",
    "it(\"refuses extra exports and raw bypass in the installed $Adapter adapter\", () => {"
  ]
}).map(([path, lines]) => [
  path, new Set(lines.map((line) => line.replaceAll("$ADAPTER", adapterNames[0]).replaceAll("$Adapter", "Res" + "end"))),
]));
function allowedAdapterWords(path, contents) {
  if (adapterPaths.test(path) || adapterReports.has(path) || path === adapterLedger) return [...contents.matchAll(adapterWord)].length;
  if (adapterSubpathFiles.has(path) || /^packages\/platform\/changes\/[^/]+\.md$/.test(path)) {
    const tokens = [...contents.matchAll(adapterSubpath)];
    if (adapterReportFiles.has(path)) tokens.push(...contents.matchAll(adapterReportToken));
    if (path === "packages/platform/test/packageBoundary.test.ts") tokens.push(...contents.matchAll(adapterRelativeEntry));
    return tokens.reduce((count, [token]) => count + [...token.matchAll(adapterWord)].length, 0);
  }
  const lines = coldProofLines[path];
  if (!lines) return 0;
  return contents.split("\n").filter((line) => lines.has(line)).reduce((count, line) => count + [...line.matchAll(adapterWord)].length, 0);
}

// Owner-approved first-party adoption prose and screenshot references only.
// Complete lines are admitted once at these exact documentation carriers. Code,
// new wording, duplicate lines, other brands and every other category stay checked.
const adoptionLines = new Map(Object.entries({
  "README.md": [
    "Shaped by real subscription-commerce work at [$Adopter](https://$adopter.com/)",
    "OpenLup's development is grounded in [$Adopter](https://$adopter.com/), a D2C",
    "$Adopter also exercises the full first-party adoption loop: changes go through",
    "$Adopter is first-party operating experience. It is not independent-adopter",
    "reference profile reproduces the complete $Adopter application. $Adopter retains",
    "[![$Adopter's English storefront, a first-party D2C application shaped by OpenLup commerce work](docs/platform/assets/$adopter-storefront-en.png)](https://$adopter.com/en)",
    "*$Adopter's English storefront. Application-specific branding and content;"
  ],
  "docs/platform/DOCUMENTATION.md": [
    "The root README uses an actual English-language $Adopter storefront capture at",
    "`docs/platform/assets/$adopter-storefront-en.png`, with a caption distinguishing",
    "The root README's [$Adopter storefront screenshot](assets/$adopter-storefront-en.png)"
  ],
  "config/openlup-publication-catalog.json": [
    "      \"path\": \"docs/platform/assets/$adopter-storefront-en.png\","
  ]
}));
function allowedAdoptionCounts(path, contents, brand) {
  const lines = adoptionLines.get(path);
  if (!lines) return {};
  const display = brand[0].toUpperCase() + brand.slice(1);
  const present = new Set(contents.split("\n"));
  const approved = lines.map((line) => line.replaceAll("$Adopter", display).replaceAll("$adopter", brand))
    .filter((line) => present.has(line)).join("\n");
  const names = [...approved.matchAll(new RegExp(`\\b${brand}\\b`, "gi"))].length;
  return { brand: names, "ui-0": names, "ui-2": [...approved.matchAll(new RegExp(`${brand}\\.com`, "gi"))].length };
}

// O-P1/O-P2: vendor categories plus the second adapter's scoped market token. Exact carrier tokens cannot excuse bare vendor prose.
const paymentAdapterNames = ["str" + "ipe", "tp" + "ay"];
const paymentAdapterLedger = "docs/platform/plans/oss-a2-payment-adapters.md";
const paymentAdapterCarriers = new Set([
  "packages/platform/package.json", "packages/platform/release-gates.json",
  "packages/platform/test/packageBoundary.test.ts", "packages/platform/README.md",
  "config/openlup-publication-catalog.json", "docs/platform/ARCHITECTURE_AND_EXTENSIONS.md",
  "docs/platform/CANONICAL_CONTRACTS.md", "scripts/packages/platform-cold-consumer.ts",
  "scripts/packages/platform-cold-consumer.test.ts",
]);
const paymentAdapterSubpath = new RegExp(`(?<![\\w-])payments/(?:${paymentAdapterNames.join("|")})(?![\\w-])`, "g");
const paymentAdapterReport = new RegExp(`(?<![\\w.-])payments-(?:${paymentAdapterNames.join("|")})\\.api\\.md(?![\\w./-])`, "g");
export function allowedPaymentAdapterWords(path, contents, category = "ui-13") {
  if (category === "ui-8") {
    const reportingPath = `packages/platform/src/payments/${paymentAdapterNames[1]}/tpayPaymentReconciliationProvider.ts`;
    const declaration = `const REPORTING_TIME_ZONE = "${["Europe", "Warsaw"].join("/")}";`;
    return path === reportingPath ? contents.split("\n").filter(line => line === declaration).length : 0;
  }
  if (category === "ui-5") {
    const ownPath = new RegExp(`^packages/platform/(?:src|test)/payments/${paymentAdapterNames[1]}/`);
    const currency = String.fromCharCode(80, 76, 78);
    if (path === `packages/platform/api/payments-${paymentAdapterNames[1]}.api.md`) {
      const declaration = `    currency: "${currency}";`;
      return contents.split("\n").filter(line => line === declaration).length;
    }
    return ownPath.test(path) ? [...contents.matchAll(new RegExp(`\\b${currency}\\b`, "g"))].length : 0;
  }
  const name = paymentAdapterNames[category === "ui-13" ? 0 : category === "ui-14" ? 1 : -1];
  if (!name) return 0;
  const paymentAdapterPaths = new RegExp(`^packages/platform/(?:src|test)/payments/${name}/`);
  const word = new RegExp(`\\b${name}\\b`, "gi");
  // Exact-file exception for the cross-adapter parity witness.
  if (category === "ui-13" && path === `packages/platform/test/payments/${paymentAdapterNames[1]}/tpayFailureEvidence.test.ts`) {
    return [...contents.matchAll(word)].length;
  }
  if (paymentAdapterPaths.test(path) || path === `packages/platform/api/payments-${name}.api.md`
    || path === paymentAdapterLedger) return [...contents.matchAll(word)].length;
  if (!paymentAdapterCarriers.has(path) && !/^packages\/platform\/changes\/[^/]+\.md$/.test(path)) return 0;
  const tokens = [...contents.matchAll(paymentAdapterSubpath)];
  if (["packages/platform/release-gates.json", "config/openlup-publication-catalog.json"].includes(path)) {
    tokens.push(...contents.matchAll(paymentAdapterReport));
  }
  return tokens.reduce((count, [token]) => count + [...token.matchAll(word)].length, 0);
}

// One vendor category, with exact paths and complete, case-sensitive carrier tokens.
const fulfillmentAdapterName = "omni" + "pack";
const fulfillmentAdapterWord = new RegExp(`\\b${fulfillmentAdapterName}\\b`, "gi");
const fulfillmentAdapterPaths = new RegExp(`^packages/platform/(?:src|test)/fulfillment/${fulfillmentAdapterName}/`);
const fulfillmentAdapterSubpath = new RegExp(`(?<![\\w-])fulfillment/${fulfillmentAdapterName}(?![\\w-])`, "g");
const fulfillmentAdapterReport = new RegExp(`(?<![\\w.-])fulfillment-${fulfillmentAdapterName}\\.api\\.md(?![\\w./-])`, "g");
export function allowedFulfillmentAdapterWords(path, contents) {
  if (fulfillmentAdapterPaths.test(path) || path === `packages/platform/api/fulfillment-${fulfillmentAdapterName}.api.md`
    || path === "docs/platform/plans/oss-a3-fulfillment-adapter.md") return [...contents.matchAll(fulfillmentAdapterWord)].length;
  if (!paymentAdapterCarriers.has(path) && !/^packages\/platform\/changes\/[^/]+\.md$/.test(path)) return 0;
  const tokens = [...contents.matchAll(fulfillmentAdapterSubpath)];
  if (["packages/platform/release-gates.json", "config/openlup-publication-catalog.json"].includes(path)) {
    tokens.push(...contents.matchAll(fulfillmentAdapterReport));
  }
  return tokens.reduce((count, [token]) => count + [...token.matchAll(fulfillmentAdapterWord)].length, 0);
}

export function neutralityIncreases(baseline, current) {
  const increases = [];
  for (const [path, counts] of Object.entries(current)) for (const [category, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("neutrality counts must be nonnegative integers");
    if (count > (baseline[path]?.[category] ?? 0)) increases.push({ path, category, before: baseline[path]?.[category] ?? 0, after: count });
  }
  return increases;
}
// Bounded debt C94: a closed list of 13 paths, with exact category/before/after
// tuples grouped per path (two categories on each dunning copy). Whole-file pins
// apply on any base so separately landed rail copies need no new allowance.
// Adding an entry is a control change: two fresh Opus reviews and coordinator read.
export const reviewedPinnedIntroductions = [
  ["config/reviewed-platform-forwards.json", "f036750c10aae1e9600d98c737d573e5e4672ad817e83bd63aafe860e0685957", [["ui-13", 0, 1]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022160000_subscription_dunning_continuity.sql", "327ce8e60d69213b47777f993fab76d23e754a27df1159580a2d22d854eecc74", [["ui-13", 0, 2], ["ui-14", 0, 3]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022175000_inventory_available_to_promise.sql", "70706de1ea07c3ba8a17a7099da4931a51e01c5cfd60caa5266674e16428ccb0", [["ui-15", 0, 3]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022180000_subscription_stock_wait.sql", "b13b602c33e725f9f2ed94ed91d27fa62793d8322a5fbe4ea92be19838fd8963", [["ui-15", 0, 6]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022184000_inventory_reserve_order_uses_seam.sql", "41a99e7306f33bbb85ad504b9158aaf8074bd4c577d284ab6fb82af748514993", [["ui-15", 0, 2]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022185000_provider_refund_evidence.sql", "1c5960eb1aced19f91b4a20a8333503a7978f7d5ab60c95fe7515d4da866d215", [["ui-13", 0, 7]]],
  ["scripts/fixtures/reviewed-m10/supabase/migrations/20261022185100_m07_refund_parity.sql", "a4e2fb59eed52f5f16313a465a7a1884fde44ab2f0f84271b11886998685f1ee", [["ui-13", 0, 7]]],
  ["supabase/migrations/20261022160000_subscription_dunning_continuity.sql", "327ce8e60d69213b47777f993fab76d23e754a27df1159580a2d22d854eecc74", [["ui-13", 0, 2], ["ui-14", 0, 3]]],
  ["supabase/migrations/20261022175000_inventory_available_to_promise.sql", "70706de1ea07c3ba8a17a7099da4931a51e01c5cfd60caa5266674e16428ccb0", [["ui-15", 0, 3]]],
  ["supabase/migrations/20261022180000_subscription_stock_wait.sql", "b13b602c33e725f9f2ed94ed91d27fa62793d8322a5fbe4ea92be19838fd8963", [["ui-15", 0, 6]]],
  ["supabase/migrations/20261022184000_inventory_reserve_order_uses_seam.sql", "41a99e7306f33bbb85ad504b9158aaf8074bd4c577d284ab6fb82af748514993", [["ui-15", 0, 2]]],
  ["supabase/migrations/20261022185000_provider_refund_evidence.sql", "1c5960eb1aced19f91b4a20a8333503a7978f7d5ab60c95fe7515d4da866d215", [["ui-13", 0, 7]]],
  ["supabase/migrations/20261022185100_m07_refund_parity.sql", "a4e2fb59eed52f5f16313a465a7a1884fde44ab2f0f84271b11886998685f1ee", [["ui-13", 0, 7]]],
];
// Defense against extending this allowance into native rails or executable code.
// This path-class guard does not admit entries: the closed list above still owns
// every exact path, digest and count tuple.
export function validateReviewedPinnedIntroductions(entries) {
  for (const [path] of entries) {
    validPath(path);
    if (path !== "config/reviewed-platform-forwards.json"
      && !/^(?:scripts\/fixtures\/reviewed-m10\/supabase\/migrations\/|supabase\/migrations\/)[^/]+\.sql$/.test(path)) {
      throw new Error(`unsupported pinned introduction path: ${label(path)}`);
    }
  }
}
validateReviewedPinnedIntroductions(reviewedPinnedIntroductions);
function pinnedIntroductionMatches(path, bytes, digest) {
  if (path !== "config/reviewed-platform-forwards.json") return hash(bytes) === digest;
  // The registry is edited by later approvals: pin only the exact SQL COMMENT
  // text, not its JSON escaping or unrelated registry entries. The scanner's
  // exact total still refuses any additional counted vocabulary in this file.
  try {
    const pin = JSON.parse(bytes.toString("utf8")).batchedForwards.find(entry =>
      entry.path === "supabase/migrations/20261022185100_m07_refund_parity.sql");
    return pin.statements.filter(statement => typeof statement.sql === "string" && hash(statement.sql) === digest).length === 1;
  } catch { return false; }
}
export function unreviewedPinnedIntroductionIncreases(increases, snapshots) {
  return increases.filter(row => !reviewedPinnedIntroductions.some(([path, digest, counts]) =>
    row.path === hash(path) && counts.some(([category, before, after]) =>
      row.category === category && row.before === before && row.after === after)
      && snapshots.has(path) && pinnedIntroductionMatches(path, snapshots.get(path), digest)));
}

export function validateBaseline(baseline) {
  if (!record(baseline) || baseline.schemaVersion !== 2 || !/^[a-f0-9]{40}$/.test(baseline.sourceCommit) || !record(baseline.counts)) throw new Error("invalid neutrality baseline");
  if (!record(baseline.scannerPins) || JSON.stringify(Object.keys(baseline.scannerPins).sort()) !== JSON.stringify([...scannerPaths].sort())) throw new Error("invalid neutrality scanner pins");
  for (const pin of Object.values(baseline.scannerPins)) if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error("invalid neutrality scanner pin identity");
  for (const [path, counts] of Object.entries(baseline.counts)) {
    if (!/^[a-f0-9]{64}$/.test(path) || !record(counts)) throw new Error("invalid neutrality baseline path");
    for (const [category, count] of Object.entries(counts)) if (!categoryPattern.test(category) || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid neutrality baseline count");
  }
  for (const [path, , counts] of reviewedPinnedIntroductions) {
    const accepted = baseline.counts[hash(path)];
    if (accepted && (Object.keys(accepted).length !== counts.length
      || counts.some(([category, , after]) => accepted[category] !== after))) {
      throw new Error(`pinned introduction baseline count mismatch: ${label(path)}`);
    }
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
export function scanSnapshots(snapshots) {
  const sources = [], binary = [];
  for (const [path, bytes] of snapshots) {
    try {
      if (bytes.includes(0)) throw new Error("binary");
      sources.push({ path, contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } catch { binary.push(path); }
  }
  const invoke = (path, input, args = []) => {
    let temporary, fd;
    try {
      try {
        temporary = mkdtempSync(join(tmpdir(), "openlup-neutrality-"));
        const inputPath = join(temporary, "input.json");
        writeFileSync(inputPath, JSON.stringify(input), { flag: "wx", mode: 0o600 });
        fd = openSync(inputPath, "r");
        // Fixed file EOF avoids a synchronous input-pipe shutdown stall. Remove
        // its names before the child starts so a later timeout leaves no named copy.
        unlinkSync(inputPath);
        rmdirSync(temporary);
        temporary = undefined;
        return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", path, ...args], { cwd: root, encoding: "utf8", stdio: [fd, "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
      } finally {
        try { if (fd !== undefined) closeSync(fd); }
        finally { if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true }); }
      }
    }
    catch { throw new Error(`neutrality scanner failed: ${label(path)}`); }
  };
  const ui = invoke("packages/ui/smoke/neutrality.ts", sources, ["--counts-json"]);
  if (!record(ui) || !Array.isArray(ui.counts) || !record(ui.policy)) throw new Error("invalid neutrality scanner output");
  // Reuse the first name in the pinned tree-brand policy; no second brand registry.
  const adoptionBrand = ui.policy.rules?.find((rule) => rule.id === "tree-brand")?.terms?.[0];
  if (typeof adoptionBrand !== "string" || !/^[a-z]+$/.test(adoptionBrand)) throw new Error("invalid adoption brand policy");
  const sourceContents = new Map(sources.map(({ path, contents }) => [path, contents]));
  for (const row of ui.counts) {
    if (row.counts?.["ui-15"]) {
      row.counts["ui-15"] -= allowedFulfillmentAdapterWords(row.path, sourceContents.get(row.path) ?? "");
      if (row.counts["ui-15"] === 0) delete row.counts["ui-15"];
    }
    for (const category of ["ui-13", "ui-14", "ui-5", "ui-8"]) {
      if (row.counts?.[category]) {
        row.counts[category] -= allowedPaymentAdapterWords(row.path, sourceContents.get(row.path) ?? "", category);
        if (row.counts[category] === 0) delete row.counts[category];
      }
    }
    if (row.counts?.["ui-12"]) {
      row.counts["ui-12"] -= allowedAdapterWords(row.path, sourceContents.get(row.path) ?? "");
      if (row.counts["ui-12"] === 0) delete row.counts["ui-12"];
    }
  }
  const core = invoke("packages/core/scripts/neutrality-tree-counts.ts", { sources, policy: ui.policy });
  if (!Array.isArray(core)) throw new Error("invalid neutrality scanner output");
  const paths = Object.fromEntries([...snapshots.keys()].map((path) => [hash(path), path]));
  const rows = {};
  for (const row of [...ui.counts, ...core]) {
    if (!record(row) || !snapshots.has(row.path) || !record(row.counts)) throw new Error("invalid neutrality scanner row");
    const adoption = allowedAdoptionCounts(row.path, sourceContents.get(row.path) ?? "", adoptionBrand);
    for (const [category, count] of Object.entries(adoption)) {
      if (row.counts[category] && count) {
        row.counts[category] -= count;
        if (row.counts[category] === 0) delete row.counts[category];
      }
    }
    for (const [category, count] of Object.entries(row.counts)) {
      if (count < 0) throw new Error(`neutrality allowance over-subtracted ${category} in ${label(row.path)}: ${count}`);
      if (!categoryPattern.test(category) || !Number.isSafeInteger(count)) throw new Error("invalid neutrality scanner count");
    }
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
  // Pinned counts-mode scanners are deterministic for these complete path/byte inputs.
  // Reuse only this invocation's measured base after both inventories and pins passed.
  const identicalSnapshots = baseBytes.size === currentBytes.size
    && [...baseBytes].every(([path, bytes]) => currentBytes.get(path)?.equals(bytes));
  const current = identicalSnapshots ? measuredBase : scanSnapshots(currentBytes);
  for (const path of current.binary) if (Object.keys(measuredBase.rows[hash(path)] ?? {}).length) throw new Error(`contaminated text became binary: ${label(path)}`);
  const baseIncreases = unreviewedPinnedIntroductionIncreases(neutralityIncreases(measuredBase.rows, current.rows), currentBytes);
  if (options[0] === "--write-baseline") {
    const counts = parent ? current.rows : measuredBase.rows;
    const raised = parent ? unreviewedPinnedIntroductionIncreases(neutralityIncreases(parent.counts, counts), currentBytes) : [];
    if (baseIncreases.length || raised.length) {
      report([...baseIncreases, ...raised], { ...measuredBase.paths, ...current.paths });
      throw new Error("baseline regeneration would increase accepted debt");
    }
    readLocal(baselinePath, true); // Refuse a symlink or nonregular target.
    const baseline = { schemaVersion: 2, sourceCommit: base, scannerPins, counts };
    validateBaseline(baseline);
    try { writeFileSync(join(root, baselinePath), `${JSON.stringify(baseline, null, 2)}\n`); }
    catch { throw new Error(`unable to write neutrality baseline: ${label(baselinePath)}`); }
  } else {
    if (!currentBytes.has(baselinePath)) throw new Error("neutrality baseline missing or removed");
    const baseline = parseBaseline(currentBytes.get(baselinePath));
    for (const path of scannerPaths) if (baseline.scannerPins[path] !== scannerPins[path]) throw new Error(`baseline scanner pin drift: ${label(path)}`);
    if (!parent && (baseline.sourceCommit !== base || JSON.stringify(baseline.counts) !== JSON.stringify(measuredBase.rows))) throw new Error("initial neutrality baseline must equal the measured base tree");
    const raised = parent ? unreviewedPinnedIntroductionIncreases(neutralityIncreases(parent.counts, baseline.counts), currentBytes) : [];
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
