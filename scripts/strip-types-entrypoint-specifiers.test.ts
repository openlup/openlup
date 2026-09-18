// Falsifier: a script launched with `node --experimental-strip-types` must be
// able to resolve every relative module it imports.
//
// WHY: type stripping erases annotations and rewrites nothing else. A `.js`
// specifier stays a `.js` specifier, so Node's ESM resolver looks for a file that
// was never emitted and throws ERR_MODULE_NOT_FOUND at module load — before the
// script's first statement. `npm run smoke:email-delivery-worker:health` and
// `.github/workflows/email-delivery-worker-preview.yml` both died that way while
// looking green enough to keep shipping, because the failure is a load error, not
// a check result.
//
// WHY NOT a blanket "no unresolvable `.js` specifier under scripts/": measured at
// 183 sites in 53 non-test files, and none of them is a defect — those scripts run
// under `tsx`, which resolves `.js` onto its `.ts` source. The extension is
// runtime-dependent, which is the same reason
// `scripts/check-vercel-ts-import-specifiers.ts` refuses the mirror-image blanket
// rule for `.ts` specifiers.
//
// WHY NOT fold this into that guard: it is a Vercel-REACHABILITY analysis rooted
// at `api/**`, and its resolver deliberately maps `.js` onto the `.ts` source the
// platform compiles from. This rule is rooted at the strip-types entrypoint set
// and must refuse exactly that mapping. Same sentence, opposite root set and
// opposite resolver.
//
// SO: walk the real runtime import graph from every `--experimental-strip-types`
// entrypoint, over source that Node's own `stripTypeScriptTypes` has erased — so a
// type-only import, which never reaches the resolver, is never counted. A finding
// is a defect when the importing file is under `scripts/`, where `.ts` is
// unambiguously correct. A finding in `api/`, `server/` or `src/` is a different
// defect: that code is compiled for Vercel, where `.js` is mandatory, so the wrong
// thing is the entrypoint's choice of runtime. Those are held at a shrink-only
// ceiling below rather than silenced.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Entrypoints spelled as a shell word, including the `"$ROOT/…"` and
// `"$GITHUB_WORKSPACE/…"` forms workflows and `scripts/openlup/verify.sh` use.
const SHELL_ENTRYPOINT =
  /--experimental-strip-types\s+(?:--input-type=module\s+)?(?:"?\$\{?(?:GITHUB_WORKSPACE|ROOT|OPENLUP_ROOT)\}?\/"?)?"?([A-Za-z0-9_@.\-/]+\.(?:ts|mts|mjs))"?/g;
// Entrypoints spelled as an argv array element, the shape `scripts/openlup/*.ts` uses
// when it spawns a sibling tool.
const ARGV_ENTRYPOINT = /--experimental-strip-types"\s*,\s*"([A-Za-z0-9_@.\-/]+\.(?:ts|mts|mjs))"/g;

const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/g,
];

/** An entrypoint whose graph reaches an unresolvable specifier that this rule does
 *  not own, because the carrier is compiled for Vercel where `.js` is required.
 *  Shrink-only: repairing one keeps the suite green, adding one turns it red. The
 *  repair is to run the entrypoint under `tsx`, not to flip the specifier. */
const RUNTIME_MISMATCH_CEILING = [
  "scripts/email-cutover-readiness.ts",
  "scripts/omnipack-preprod-default-provider-matrix.ts",
  "scripts/omnipack-preprod-provider-matrix.ts",
  "scripts/omnipack-stage-batch-ladder.ts",
  "scripts/omnipack-stage-batch-operator.ts",
  "scripts/omnipack-subscription-forecast-proof.ts",
  "scripts/smoke-checkout-contract-preview.mjs",
  "scripts/smoke-stripe-accounting-preview.ts",
  "scripts/smoke-stripe-release-preview.ts",
];

type Finding = { file: string; line: number; specifier: string; entrypoint: string };

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readIfPresent(rel: string): string | null {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

function listFiles(relDir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = toPosix(relative(ROOT, path));
        if (keep(rel)) out.push(rel);
      }
    }
  };
  walk(join(ROOT, relDir));
  return out;
}

function isTestFile(rel: string): boolean {
  return /\.(?:test|spec)\.[cm]?tsx?$/.test(rel);
}

/** Every file that can name a strip-types entrypoint: the script table, the
 *  workflows, the shell wrappers, and the tools that spawn a sibling by argv. */
export function entrypointCarriers(): string[] {
  const carriers = ["package.json", "openlup"];
  carriers.push(...listFiles(".github/workflows", (rel) => rel.endsWith(".yml") || rel.endsWith(".yaml")));
  carriers.push(...listFiles("scripts", (rel) => rel.endsWith(".sh") || (rel.endsWith(".ts") && !isTestFile(rel))));
  return carriers.filter((rel) => isFile(join(ROOT, rel)));
}

export function collectStripTypesEntrypoints(): string[] {
  const found = new Set<string>();
  for (const carrier of entrypointCarriers()) {
    const text = readIfPresent(carrier);
    if (text === null) continue;
    for (const pattern of [SHELL_ENTRYPOINT, ARGV_ENTRYPOINT]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        if (isFile(join(ROOT, match[1]))) found.add(match[1]);
      }
    }
  }
  return Array.from(found).sort();
}

/** The relative specifiers Node will actually resolve for this module: the source
 *  as `stripTypeScriptTypes` leaves it, so `import type` lines are already gone,
 *  and only lines that open an import/export statement count — a specifier quoted
 *  inside a string constant is data, not an edge. */
function runtimeSpecifiers(rel: string): { line: number; specifier: string }[] {
  const source = readIfPresent(rel);
  if (source === null) return [];
  let runtime = source;
  if (/\.[cm]?ts$/.test(rel)) {
    try {
      runtime = stripTypeScriptTypes(source, { mode: "strip" });
    } catch {
      return [];
    }
  }
  const out: { line: number; specifier: string }[] = [];
  const lines = runtime.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!/^(?:import\b|export\b|\})/.test(trimmed) && !/\bimport\s*\(/.test(trimmed)) continue;
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const specifier = match[1];
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        if (specifier.includes("${")) continue;
        out.push({ line: index + 1, specifier });
      }
    }
  }
  return out;
}

export function scanStripTypesGraphs(): Finding[] {
  const findings: Finding[] = [];
  for (const entrypoint of collectStripTypesEntrypoints()) {
    const visited = new Set<string>();
    const walk = (rel: string): void => {
      if (visited.has(rel)) return;
      visited.add(rel);
      for (const { line, specifier } of runtimeSpecifiers(rel)) {
        const target = resolve(dirname(join(ROOT, rel)), specifier);
        if (isFile(target)) {
          walk(toPosix(relative(ROOT, target)));
          continue;
        }
        findings.push({ file: rel, line, specifier, entrypoint });
        // Keep walking through the break so one bad specifier cannot hide the
        // modules behind it.
        const sibling = ["ts", "tsx", "mts"]
          .map((ext) => target.replace(/\.[cm]?jsx?$/, `.${ext}`))
          .find((candidate) => candidate !== target && isFile(candidate));
        if (sibling) walk(toPosix(relative(ROOT, sibling)));
      }
    };
    walk(entrypoint);
  }
  return findings;
}

describe("strip-types entrypoint specifiers", () => {
  const findings = scanStripTypesGraphs();

  it("finds the strip-types entrypoints the repository actually launches", () => {
    const entrypoints = collectStripTypesEntrypoints();
    expect(entrypoints.length).toBeGreaterThan(100);
    expect(entrypoints).toContain("scripts/email-delivery-worker-health.ts");
  });

  it("resolves every relative specifier a scripts/ module contributes to a strip-types graph", () => {
    const owned = findings
      .filter((finding) => finding.file.startsWith("scripts/"))
      .map((finding) => `${finding.file}:${finding.line} imports ${finding.specifier} (via ${finding.entrypoint})`);
    expect(owned).toEqual([]);
  });

  it("holds the entrypoints that run Vercel-compiled code at a shrink-only ceiling", () => {
    const mismatched = Array.from(
      new Set(findings.filter((finding) => !finding.file.startsWith("scripts/")).map((finding) => finding.entrypoint)),
    ).sort();
    expect(mismatched.filter((entrypoint) => !RUNTIME_MISMATCH_CEILING.includes(entrypoint))).toEqual([]);
  });

  it("agrees with Node: the repaired entrypoint loads", () => {
    const probe = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", "await import('./scripts/email-delivery-worker-health.ts')"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(probe).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
