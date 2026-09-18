// Seeded falsifiers for checks that must run in a standalone published checkout. Source composition
// and withholding live in the private split harness; importing either here would make the public
// checker depend on the control plane it is meant to prove absent.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXPLICIT_PUBLIC_PROJECTION_PATHS,
  PUBLIC_EXECUTION_ENTRYPOINTS,
  createPublicPublicationCatalog,
  createSourceReleaseContract,
  publicPublicationCatalogDigests,
} from "./oss-publication-contract.ts";
import {
  assertMaterializedOutputBytes,
  assertMaterializedOutputInventory,
  assertMaterializedPublicationCatalog,
  materializePublicPublicationCatalog,
  materializedOutputPaths,
  policyVerdict,
  publicInventoryVerdict,
  sourceReleaseProjectionDrift,
  typecheckVerdict,
} from "./oss-published-tree-check.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, PUBLIC_TEST_COMMAND, PUBLIC_TEST_SCOPE } from "./oss-publication-policy.ts";
import { carriesPrivateOperationalCoordinate, computeNeutralizations, NEUTRALIZATION_RULESET_DIGEST, parseRegistry, projectOperationalCoordinates } from "./oss-neutralization-projection.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/published-tree-ci.yml";
const workflow = readFileSync(join(ROOT, WORKFLOW), "utf8");
const packageManifestPaths = PUBLIC_PACKAGE_EXECUTION_SURFACES.map(({ path }) => path);
const publicRootManifest = () => JSON.stringify({ workspaces: (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces?: string[] }).workspaces, scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) });
function writePackageManifests(root: string): void {
  for (const path of packageManifestPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), path === "package.json" ? publicRootManifest() : readFileSync(join(ROOT, path)));
  }
}

describe("the workflow source/public marker", () => {
  it("uses trusted repository metadata instead of a checkout-controlled sentinel", () => {
    expect(workflow).toContain("github.event.repository.private");
    expect(workflow).not.toMatch(/\[\s+-e\s+[^\]]+\]/u);
  });
});

describe("what the workflow may not contain", () => {
  it("names no product and no provider, in any form", () => {
    expect(carriesPrivateOperationalCoordinate(workflow)).toBe(false);
    // The public name is settled, but generic automation still must not carry product identity;
    // the published package scope is the canonical source and must not spread into workflow YAML.
    const scope = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces?: string[] }).workspaces ?? [];
    const packageName = (JSON.parse(readFileSync(join(ROOT, scope[0] ?? "packages/core", "package.json"), "utf8")) as { name?: string }).name ?? "";
    expect(packageName).not.toEqual("");
    expect(workflow).not.toContain(packageName.split("/")[0]);
  });

  it("declares no trigger that would register it as a scheduled or dispatched entrypoint", () => {
    for (const trigger of ["schedule:", "workflow_dispatch:", "repository_dispatch:"]) expect(workflow).not.toContain(trigger);
  });
});

describe("the workflow stays in step with what it claims to run", () => {
  it("exposes exactly the six public contexts and gates each from trusted event metadata", () => {
    const jobs = [...(workflow.split("\njobs:\n")[1] ?? "").matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1]);
    expect(jobs).toEqual(["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks"]);
    expect(workflow).not.toContain("needs: applies");
    const predicate = "    if: ${{ github.event.repository.private == false && (github.event_name != 'pull_request' || (github.event.pull_request.draft == false && (github.event.pull_request.user.login != 'dependabot[bot]' || (github.event.action == 'ready_for_review' && github.event.sender.type == 'User')))) }}";
    expect(workflow.split("\n").filter((line) => line === predicate)).toHaveLength(jobs.length);
    for (const job of jobs) expect(workflow).toContain(`  ${job}:\n    name: ${job}\n${predicate}\n`);
    expect(workflow.replace("    name: dco", "    name: dco-renamed")).not.toContain(`  dco:\n    name: dco\n${predicate}\n`);
    expect(workflow.replace(predicate, `${predicate.slice(0, -3)} && false }}`)).not.toContain(`  dco:\n    name: dco\n${predicate}\n`);
  });

  it("holds every pull request to the sign-off the contributing document promises", () => {
    // The promise: CONTRIBUTING.md documents the trailer and says `git commit -s` writes it. Until
    // the `dco` job existed nothing read a commit message, so the requirement was enforced against
    // nobody. These two assertions are what keep the document and the automation the same rule.
    const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(/^Signed-off-by: .+ <.+@.+>$/m.test(contributing)).toBe(true);
    expect(workflow).toContain('npm run check:dco-signoff -- "$RANGE_BASE" "$RANGE_HEAD"');
    expect(workflow).toContain('test "$RANGE_BASE" = "0000000000000000000000000000000000000000"');
    expect(workflow).toContain("RANGE_BASE: ${{ github.event.before }}");
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("pins every action and verifies the runtime and scanner before use", () => {
    const uses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)(?:\s+#\s+v\d+)?/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((sha) => /^[a-f0-9]{40}$/u.test(sha))).toBe(true);
    expect(workflow.match(/require\("\.\/package\.json"\)\.engines\.node/g)).toHaveLength(3);
    expect(workflow.match(/require\("\.\/package\.json"\)\.packageManager/g)).toHaveLength(3);
    expect(workflow).toContain("gitleaks_8.30.1_linux_x64.tar.gz");
    expect(workflow).toContain("551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb");
    expect(workflow).toContain("gitleaks git . --config config/gitleaks.toml --redact --no-banner");
  });

  it("runs the closed public root build instead of source-only prebuild machinery", () => {
    expect(workflow).toContain("npm run build");
    expect(workflow).not.toContain("--workspaces --if-present");
    expect(workflow).not.toContain("guard-hidden-sandbox-preview-env");
    expect(workflow).not.toContain("oss-split-install-proof");
  });

  it("scopes the test run to directories that still exist", () => {
    const scope = [...PUBLIC_TEST_SCOPE];
    expect(workflow).toContain("run: npm test");
    expect(workflow).not.toContain("npm test --");
    expect(PUBLIC_TEST_COMMAND).toBe(`node scripts/run-vitest.mjs run ${scope.join(" ")}`);
    expect(scope.length).toBeGreaterThan(10);
    expect(scope).toEqual(expect.arrayContaining(["scripts/oss-consume-engine.test.ts", "scripts/oss-consume-github-transport.test.ts"]));
    const tracked = execFileSync("git", ["ls-files", "-z", ...scope], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
    for (const target of scope) expect(tracked.some((path) => path === target || path.startsWith(`${target}/`))).toBe(true);
  });
});

describe("the public-only inventory check", () => {
  it("binds a public checkout without reading the private source catalogue", () => {
    const root = mkdtempSync(join(tmpdir(), "published-inventory-"));
    const digest = (contents: string) => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
    try {
      const policy = `${JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }, null, 2)}\n`;
      const baselinePath = "db/platform/migrations/00000000000000_platform_baseline.sql", baseline = "CREATE TABLE example(id integer);\n";
      const paths = [...new Set([baselinePath, "README.md", "config/openlup-policy-registry.json", "config/openlup-publication-catalog.json", "config/openlup-source-release-contract.json", "config/platform-migration-manifest.json", "src/integrations/supabase/types.ts", "package-lock.json", "packages/core/package-lock.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort();
      const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []).contents;
      const manifest = publicRootManifest();
      const lock = "{}\n";
      const migration = JSON.stringify({ schemaVersion: 1, baseline: { file: baselinePath, sha256: digest(baseline).slice(7) }, forward: [], objectInventorySha256: digest("objects").slice(7) }); const types = "export type Database = Record<string, any>;\n";
      const contract = createSourceReleaseContract({ inventoryDigest: publicPublicationCatalogDigests(catalogue).inventoryDigest, classDigest: digest(JSON.stringify(paths)), packageDigest: digest(manifest), rootLockDigest: digest(lock), coreLockDigest: digest(lock), migrationManifestDigest: digest(migration), databaseTypesDigest: digest(types), policyRegistryDigest: digest(policy), publicationCatalogDigest: digest(catalogue) }).contents;
      const files = new Map([["README.md", "# Public\n"], ["package-lock.json", lock], ["packages/core/package-lock.json", lock], ["config/platform-migration-manifest.json", migration], ["src/integrations/supabase/types.ts", types], ["config/openlup-policy-registry.json", policy], ["config/openlup-publication-catalog.json", catalogue], ["config/openlup-source-release-contract.json", contract]]);
      for (const [path, contents] of files) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); }
      mkdirSync(dirname(join(root, baselinePath)), { recursive: true }); writeFileSync(join(root, baselinePath), baseline);
      for (const path of PUBLIC_EXECUTION_ENTRYPOINTS) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "public\n"); }
      writePackageManifests(root);
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      const lines: string[] = [];
      expect(publicInventoryVerdict(root, (line) => lines.push(line))).toBe(true);
      expect(lines.join("\n")).toContain(`tracked public paths: ${paths.length}`);
      expect(() => readFileSync(join(root, "config", "oss-core-readiness-blockers.json"))).toThrow();
      writeFileSync(join(root, baselinePath), `${baseline}SELECT 1;\n`);
      const mismatched: string[] = [];
      expect(publicInventoryVerdict(root, (line) => mismatched.push(line))).toBe(false);
      expect(mismatched.join("\n")).toContain("SHA-256 mismatch");
      writeFileSync(join(root, baselinePath), baseline);
      writeFileSync(join(root, "package.json"), `${manifest}\n`);
      expect(publicInventoryVerdict(root, () => undefined)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the public-only typecheck contract", () => {
  const zeroDebt = {
    typecheck: {
      projects: ["tsconfig.public.json"],
      signedPreviewDebt: {
        unresolvedEdges: { mode: "exact-ratchet" as const, pairs: 0, importers: 0, targets: 0, digest: "sha256-e3b0c44298fc1c149afbf4c8996fb924", pairHashes: [] },
        inferenceCascades: { mode: "ceiling-ratchet" as const, diagnostics: 0 },
      },
    },
  };
  const releaseContract = (compatibility: typeof zeroDebt | null = zeroDebt) => {
    const value = `sha256-${"0".repeat(64)}`;
    return createSourceReleaseContract({ inventoryDigest: value, classDigest: value, packageDigest: value,
      rootLockDigest: value, coreLockDigest: value, migrationManifestDigest: value, databaseTypesDigest: value,
      policyRegistryDigest: value, publicationCatalogDigest: value, ...(compatibility === null ? {} : { compatibility }) }).contents;
  };

  it("compiles solely from the release contract when the private measurement baseline is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "published-typecheck-"));
    try {
      symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(join(root, "index.ts"), "export const publicValue: string = 'ok';\n");
      writeFileSync(join(root, "tsconfig.public.json"), JSON.stringify({ compilerOptions: { strict: true }, files: ["index.ts"] }));
      expect(() => readFileSync(join(root, "config", "oss-split-rehearsal-baseline.json"))).toThrow();
      const lines: string[] = [];
      expect(typecheckVerdict(root, releaseContract(), (line) => lines.push(line))).toBe(true);
      expect(lines.join("\n")).toContain("projects: tsconfig.public.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing or malformed public compatibility contract before compiling", () => {
    expect(() => typecheckVerdict(ROOT, releaseContract(null), () => undefined)).toThrow(/missing public typecheck/);
    const malformed = JSON.parse(releaseContract()) as { compatibility: typeof zeroDebt };
    malformed.compatibility.typecheck.signedPreviewDebt.unresolvedEdges.digest = "sha256-not-signed";
    expect(() => typecheckVerdict(ROOT, JSON.stringify(malformed), () => undefined)).toThrow(/malformed signed preview/);
  });

  it("refuses a zero-debt verdict when the compiler is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "published-typecheck-no-compiler-"));
    try {
      writeFileSync(join(root, "tsconfig.public.json"), "{}\n");
      expect(() => typecheckVerdict(root, releaseContract(), () => undefined)).toThrow(/compiler did not run/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("the exact neutralization registry", () => {
  // The registry stopped being a file the branch carries; it is computed from the sources of one
  // tree and published as an artifact. The fixture stays a hand-built registry document on purpose:
  // what these cases measure is that the computation and the parser still describe the SAME
  // document, which is the only reason the artifact is worth reading.
  const source = `export const endpoint = '${["https://github.com/example", "app"].join("/")}';\n`;
  const projected = projectOperationalCoordinates(source);
  const digest = (contents: string) => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
  const entry = { path: "runtime.ts", class: "framework-namespace", format: "text", rule: "private-operational-coordinate-v1", matches: projected.matches, sourceDigest: digest(source), outputDigest: digest(projected.contents) };
  const registry = (entries: unknown[] = [entry]) => ({ schemaVersion: 1, ruleSetDigest: NEUTRALIZATION_RULESET_DIGEST, reason: "Exact fixture.", entries });

  it("computes the exact path, source bytes, output bytes and match count from the sources alone", () => {
    const result = computeNeutralizations(new Map([["runtime.ts", source]]));
    expect(result.entries).toEqual([entry]);
    expect(result.writes).toEqual([{ path: "runtime.ts", contents: projected.contents }]);
    expect(result.registryDigest).toBe(digest(JSON.stringify([entry])));
    expect(result.ruleSetDigest).toBe(NEUTRALIZATION_RULESET_DIGEST);
  });

  it("sees a new carrier appear and a vanished one disappear, with no declaration to consult", () => {
    expect(computeNeutralizations(new Map([["runtime.ts", source], ["new.ts", source]])).entries.map(({ path }) => path)).toEqual(["new.ts", "runtime.ts"]);
    expect(computeNeutralizations(new Map()).entries).toEqual([]);
    expect(computeNeutralizations(new Map([["runtime.ts", "export const endpoint = undefined;\n"]])).entries).toEqual([]);
  });

  it("round-trips the published document through the parser, and refuses a mutated one", () => {
    expect(parseRegistry(registry()).entries).toEqual([entry]);
    for (const mutation of [
      { ...entry, matches: 0 },
      { ...entry, class: "something-else" },
      { ...entry, sourceDigest: "sha256-not-a-digest" },
      { ...entry, outputDigest: `sha256-${"0".repeat(63)}` },
    ]) expect(() => parseRegistry(registry([mutation]))).toThrow(/invalid entry/);
    expect(() => parseRegistry(registry([{ ...entry, path: "b.ts" }, { ...entry, path: "a.ts" }]))).toThrow(/sorted and unique/);
    expect(() => parseRegistry({ ...registry(), ruleSetDigest: `sha256-${"0".repeat(64)}` })).toThrow(/rule-set digest/);
  });
});

describe("the materialized output inventory", () => {
  it("reads filesystem writes and refuses added, deleted and swapped output paths", () => {
    const root = mkdtempSync(join(tmpdir(), "materialized-output-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "README.md"), "public\n");
      writeFileSync(join(root, "nested", "owned.txt"), "public\n");
      const expected = ["README.md", "nested/owned.txt"];
      expect(materializedOutputPaths(root)).toEqual(expected);
      expect(assertMaterializedOutputInventory(root, expected)).toEqual(expected);
      writeFileSync(join(root, "added.txt"), "unexpected\n");
      expect(() => assertMaterializedOutputInventory(root, expected)).toThrow(/extra added\.txt/);
      rmSync(join(root, "added.txt"));
      rmSync(join(root, "README.md"));
      expect(() => assertMaterializedOutputInventory(root, expected)).toThrow(/missing README\.md/);
      writeFileSync(join(root, "replacement.md"), "wrong output\n");
      expect(() => assertMaterializedOutputInventory(root, expected)).toThrow(/missing README\.md; extra replacement\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the materialized output bytes", () => {
  it("refuses a byte divergence after independently reading copied, flattened and projected outputs", () => {
    const source = mkdtempSync(join(tmpdir(), "materialized-source-"));
    const output = mkdtempSync(join(tmpdir(), "materialized-public-"));
    const writes = EXPLICIT_PUBLIC_PROJECTION_PATHS.map((path) => ({ path, contents: `projection ${path}\n` }));
    try {
      writeFileSync(join(source, "README.md"), "copied\n");
      for (const path of ["README.md", "history/0000_baseline.sql", ...EXPLICIT_PUBLIC_PROJECTION_PATHS]) {
        mkdirSync(dirname(join(output, path)), { recursive: true });
      }
      writeFileSync(join(output, "README.md"), "copied\n");
      writeFileSync(join(output, "history", "0000_baseline.sql"), "flattened\n");
      for (const write of writes) writeFileSync(join(output, write.path), write.contents);
      const input = {
        sourceRoot: source,
        publicRoot: output,
        copiedSourcePaths: ["README.md"],
        flattenedOutput: { path: "history/0000_baseline.sql", contents: "flattened\n" },
        projectionWrites: writes,
      };
      expect(() => assertMaterializedOutputBytes(input)).not.toThrow();
      writeFileSync(join(output, "README.md"), "tampered\n");
      expect(() => assertMaterializedOutputBytes(input)).toThrow(/bytes diverge at README\.md/);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });
});

describe("projection drift", () => {
  it("records every non-static output whose materialized bytes differ from its source", () => {
    const source = mkdtempSync(join(tmpdir(), "projection-source-"));
    const output = mkdtempSync(join(tmpdir(), "projection-output-"));
    try {
      writeFileSync(join(source, "runtime.ts"), "const endpoint = 'private';\n");
      writeFileSync(join(output, "runtime.ts"), "const endpoint = 'neutral';\n");
      const row = sourceReleaseProjectionDrift(source, output).find(({ selector }) => selector === "runtime.ts");
      expect(row).toMatchObject({ selector: "runtime.ts", sourceSelector: "runtime.ts", source: { disposition: "present" }, public: { disposition: "projected" } });
      expect(row?.source.digest).not.toBe(row?.public.digest);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });
});

describe("the materialized public catalogue", () => {
  it("expands the public seed to every output without importing private source paths", () => {
    const seed = JSON.stringify({
      schemaVersion: 1,
      publicPaths: [{ path: "README.md", class: "entrypoint" }],
      guardViability: [{
        id: "source-size-complexity",
        status: "withheld",
        reason: "No public command is registered.",
        withheldPaths: ["scripts/check-source-size.ts"],
        withheldCommands: ["guard:source-size"],
      }],
    });
    const materialized = materializePublicPublicationCatalog(["README.md", "src/public.ts"], seed);
    expect(JSON.parse(materialized.contents).publicPaths).toEqual([
      { path: "README.md", class: "entrypoint" },
      { path: "src/public.ts", class: "public-output" },
    ]);
    expect(() => materializePublicPublicationCatalog(["src/public.ts", "README.md"], seed)).toThrow(/sorted, unique/);
  });

  it("binds every public command name and value to the materialized manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "materialized-commands-"));
    const paths = [...new Set([".github/PUBLICATION_COMPLETENESS.md", ".github/workflows/published-tree-ci.yml", "CONTRIBUTING.md", "README.md", "packages/core/README.md", "packages/core/src/index.ts", "config/openlup-policy-registry.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort();
    const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []);
    try {
      for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); }
      writePackageManifests(root);
      expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); const missingRunbook = ["/docs/missing-private", "runbook.md"].join("-"); writeFileSync(join(root, "README.md"), `const runbook = "${missingRunbook}";\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/runtime runbook reference is absent/); const missingHook = [".agents/ho", "oks/missing-hook.sh"].join(""); writeFileSync(join(root, "README.md"), `const hook = "${missingHook}";\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/runtime support reference is absent/); const privateProvenance = ["Production runs ", "measured on 2026-01-01"].join(""); writeFileSync(join(root, "README.md"), privateProvenance); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/private schedule provenance/); writeFileSync(join(root, "README.md"), "public\n");
      writeFileSync(join(root, "README.md"), "Run `npm run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/README\.md: npm command is absent from package\.json: ci/); writeFileSync(join(root, "README.md"), "public\n"); writeFileSync(join(root, "CONTRIBUTING.md"), "Run `npm run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/CONTRIBUTING\.md: npm command is absent from package\.json: ci/); writeFileSync(join(root, "CONTRIBUTING.md"), "public\n"); for (const command of ["npm run-script ci", "npm --silent run ci", "npm run --silent ci", "npm rum ci", "npm urn ci"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/PUBLICATION_COMPLETENESS\.md: npm command is absent from package\.json: ci/); } for (const command of ["npm start", "npm --silent start"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/PUBLICATION_COMPLETENESS\.md: npm command is absent from package\.json: start/); } for (const command of ["npm --workspace=@openlup/core run test", "npm --workspace @openlup/core run test", "npm -w packages/core run test", "npm run --workspace=@openlup/core test", "npm run test --workspace=@openlup/core", "npm --workspaces run test", "npm --workspaces=true run test", "npm -ws=true run test"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/packages\/core\/package\.json: test/); } for (const command of ["npm --workspace=@openlup/core run ci", "npm --workspace packages/core run ci", "npm -w @openlup/core run ci", "npm run --workspace=packages/core ci", "npm --workspace=@openlup/core --workspace=packages/core run ci", "npm run ci --workspace=packages/core", "npm --workspaces run ci", "npm --workspaces=true run ci", "npm -ws=true run ci", "npm --workspaces=false run test", "npm -ws=false run test", "npm --workspaces --include-workspace-root run build"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); } for (const command of ["npm --workspaces --include-workspace-root run ci", "npm run ci --workspaces --include-workspace-root", "npm --workspaces=false run ci", "npm -ws=false run ci"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/package\.json: ci/); } writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --workspace=missing run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/workspace selector is unknown or ambiguous/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --workspaces --workspace=@openlup/core run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/cannot combine/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --workspaces=maybe run test`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/unsupported npm workspaces mode/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --workspaces=true --workspaces=false run test`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/workspace mode is contradictory/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --workspaces=false --workspace=@openlup/core run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/disabled npm workspaces cannot combine/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "public\n"); writeFileSync(join(root, "packages/core/README.md"), "Run `npm run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); writeFileSync(join(root, "packages/core/README.md"), "public\n"); writeFileSync(join(root, "README.md"), "Run `npm run missing-public-command`.\n");
      expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/npm command is absent/);
      writeFileSync(join(root, "README.md"), "Run `scripts/missing-public-command.ts` or `./tool verify`.\n");
      expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/inline-code repository path is missing/);
      writeFileSync(join(root, "README.md"), "public\n"); writeFileSync(join(root, "packages/core/README.md"), "`./src/index.js` `src/index.js` `../../scripts/oss-published-tree-check.ts` `.github/PUBLICATION_COMPLETENESS.md`\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); for (const missing of ["src/missing.js", "../../../outside.md"]) { writeFileSync(join(root, "packages/core/README.md"), `\`${missing}\`\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/inline-code repository path is missing/); } writeFileSync(join(root, "packages/core/README.md"), "public\n");
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); manifest.scripts.build = "true"; writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
      expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/packageCommands differ/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // The slash is escaped deliberately inside a Markdown command fixture.
  // eslint-disable-next-line no-useless-escape
  it("binds npm prefix and refuses unmodeled package context", () => { const root = mkdtempSync(join(tmpdir(), "materialized-prefix-")); const paths = [...new Set([".github/PUBLICATION_COMPLETENESS.md", ".github/workflows/published-tree-ci.yml", "CONTRIBUTING.md", "README.md", "packages/core/README.md", "config/openlup-policy-registry.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort(); const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []); try { for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); } writePackageManifests(root); for (const command of ["npm --prefix=packages/core run test", "npm --prefix packages/core run test", "npm -C packages/core run test", "npm run --prefix packages/core test", "npm run test --prefix packages/core"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/packages\/core\/package\.json: test/); } for (const command of ["npm --prefix=packages/core run ci", "npm --prefix packages/core run ci", "npm -C packages/core run ci", "npm --prefix . run test"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); } for (const command of ["npm --prefix ../private run test", "npm --prefix /tmp run test"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/normalized repository-local package path/); } writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --prefix packages/missing run test`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/no exact public package manifest/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --prefix packages/core --prefix . run test`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/prefix selection is contradictory/); writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm --prefix packages/core --workspace @openlup\/core run ci`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/prefix and workspace package contexts cannot be combined/); for (const command of ["npm --global run test", "npm -g run test", "npm --location=global run test", "npm --location global run test", "npm --userconfig=/tmp/npmrc run test", "npm --userconfig /tmp/npmrc run test"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/unmodeled npm option/); } writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), "Run `npm_config_prefix=packages/core npm run test`.\n"); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/environment configuration/); } finally { rmSync(root, { recursive: true, force: true }); } });
  it("models valued npm options without swallowing the runner", () => { const root = mkdtempSync(join(tmpdir(), "materialized-valued-options-")); const paths = [...new Set([".github/PUBLICATION_COMPLETENESS.md", ".github/workflows/published-tree-ci.yml", "CONTRIBUTING.md", "README.md", "packages/core/README.md", "config/openlup-policy-registry.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort(); const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []); try { for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); } writePackageManifests(root); for (const command of ["npm --loglevel silent run test", "npm --loglevel=silent run test", "npm run --loglevel silent test", "npm run test --loglevel silent", "npm --color false run test", "npm --color=false run test", "npm run test -- --prefix packages/core", 'npm run test -- "--prefix" packages/core']) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).not.toThrow(); } for (const command of ["npm --loglevel silent run ci", "npm --color false run ci"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/package\.json: ci/); } for (const command of ["npm --loglevel loud run test", "npm --color maybe run test"]) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/missing or unsupported value/); } for (const command of ['npm run "ci"', 'npm --loglevel "silent" run ci', 'npm "--userconfig=/tmp/does-not-exist" run ci', 'npm --prefix="packages/core" run test']) { writeFileSync(join(root, ".github/PUBLICATION_COMPLETENESS.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/unsupported shell quoting/); } } finally { rmSync(root, { recursive: true, force: true }); } });
  it("refuses fragment-quoted npm runners and options before the argv boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "materialized-fragment-quotes-"));
    const paths = [...new Set([".github/PUBLICATION_COMPLETENESS.md", ".github/workflows/published-tree-ci.yml", "CONTRIBUTING.md", "README.md", "packages/core/README.md", "config/openlup-policy-registry.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort(); const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []);
    try { for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); } writePackageManifests(root); for (const command of ['npm r"un" ci', 'npm --user"config" /tmp/does-not-exist run ci']) { writeFileSync(join(root, "CONTRIBUTING.md"), `Run \`${command}\`.\n`); expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/unsupported shell quoting/); } }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses every undeclared package execution-surface mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "materialized-package-surfaces-"));
    const paths = [...new Set([".github/workflows/published-tree-ci.yml", "CONTRIBUTING.md", "README.md", "config/openlup-policy-registry.json", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort();
    const catalogue = createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []);
    try {
      for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); }
      const reset = () => writePackageManifests(root);
      reset();
      for (const mutate of [
        (manifest: { scripts: Record<string, string>; bin?: Record<string, string> }) => { manifest.scripts.postinstall = "node scripts/oss-published-tree-check.ts"; },
        (manifest: { scripts: Record<string, string>; bin?: Record<string, string> }) => { manifest.scripts.test = "node scripts/run-vitest.mjs run"; },
        (manifest: { scripts: Record<string, string>; bin?: Record<string, string> }) => { manifest.bin = { openlup: "scripts/oss-published-tree-check.ts" }; },
      ]) {
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); mutate(manifest); writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
        expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/scripts\/bin execution surface|packageCommands differ/);
        reset();
      }
      const extra = "packages/undeclared/package.json"; mkdirSync(dirname(join(root, extra)), { recursive: true }); writeFileSync(join(root, extra), "{}");
      const extraPaths = [...paths, extra].sort();
      const extraCatalogue = createPublicPublicationCatalog(extraPaths.map((path) => ({ path, class: "public-output" })), []);
      expect(() => assertMaterializedPublicationCatalog(root, extraCatalogue.contents, extraPaths)).toThrow(/package manifest inventory/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a bland 100644 argv mutator outside the closed public entrypoints", () => {
    const root = mkdtempSync(join(tmpdir(), "materialized-entrypoint-"));
    const path = "scripts/neutral-helper.ts";
    const paths = [...new Set(["README.md", "config/openlup-policy-registry.json", path, ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort();
    const catalogue = createPublicPublicationCatalog(paths.map((item) => ({ path: item, class: "public-output" })), []);
    try {
      for (const item of paths) { mkdirSync(dirname(join(root, item)), { recursive: true }); writeFileSync(join(root, item), item === "config/openlup-policy-registry.json" ? JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }) : "public\n"); }
      writePackageManifests(root);
      writeFileSync(join(root, path), "const execute = process.argv.includes('--execute');\n");
      expect(PUBLIC_EXECUTION_ENTRYPOINTS).not.toContain(path);
      expect(() => assertMaterializedPublicationCatalog(root, catalogue.contents, paths)).toThrow(/unregistered direct execution entrypoint/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("the public-only policy check", () => {
  it("reads only the public registry, catalogue, and public paths they name", () => {
    const root = mkdtempSync(join(tmpdir(), "published-policy-"));
    try {
      mkdirSync(join(root, "config"), { recursive: true });
      mkdirSync(join(root, "docs", "platform"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# Public source\n");
      writeFileSync(join(root, "docs", "platform", "README.md"), "[Guide](AGENT_GUIDE.md)\n");
      writeFileSync(join(root, "docs", "platform", "AGENT_GUIDE.md"), "# Guide\n");
      for (const path of PUBLIC_EXECUTION_ENTRYPOINTS) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "public\n"); }
      writePackageManifests(root);
      writeFileSync(join(root, "config", "openlup-policy-registry.json"), JSON.stringify({
        schemaVersion: 1,
        activePaths: ["README.md"],
        contracts: [{ id: "entrypoint", owners: ["README.md"] }],
      }));
      const policyPaths = [...new Set(["README.md", "config/openlup-policy-registry.json", "config/openlup-publication-catalog.json", "docs/platform/README.md", "docs/platform/AGENT_GUIDE.md", ...packageManifestPaths, ...PUBLIC_EXECUTION_ENTRYPOINTS])].sort();
      writeFileSync(join(root, "config", "openlup-publication-catalog.json"), createPublicPublicationCatalog(policyPaths.map((path) => ({ path, class: "public-output" })), [{
          id: "source-size-complexity",
          status: "withheld",
          reason: "No public invocation is registered.",
          withheldPaths: ["scripts/check-source-size.ts"],
          withheldCommands: ["guard:source-size"],
        }]).contents);
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "installed.txt"), "untracked dependency\n"); writeFileSync(join(root, "node_modules", "private.md"), "untracked output\n"); writeFileSync(join(root, "config", "private-deployment.json"), "untracked output\n");
      const lines: string[] = [];
      expect(policyVerdict(root, (line) => lines.push(line))).toBe(true);
      expect(lines.join("\n")).toContain("public policy paths: 1");
      writeFileSync(join(root, "docs", "platform", "README.md"), "[untracked](../../node_modules/private.md)\n");
      expect(() => policyVerdict(root, () => undefined)).toThrow(/local Markdown link is missing/);
      writeFileSync(join(root, "docs", "platform", "README.md"), "`config/private-deployment.json`\n`server/adapters/<provider>/`\n`DOMAIN_ARCHITECTURE.md`\n");
      expect(() => policyVerdict(root, () => undefined)).toThrow(/inline-code repository path is missing config\/private-deployment\.json/);
      writeFileSync(join(root, "docs", "platform", "README.md"), "`server/adapters/<provider>/`\n`DOMAIN_ARCHITECTURE.md`\n");
      expect(policyVerdict(root, () => undefined)).toBe(true);
      writeFileSync(join(root, "docs", "platform", "README.md"), "[Guide](AGENT_GUIDE.md)\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { ...Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])), "guard:source-size": "node scripts/check-source-size.ts" } }));
      expect(() => policyVerdict(root, () => undefined)).toThrow(/packageCommands differ/);
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }));
      const forbiddenCoordinate = ["https://github.com/example", "app"].join("/"); const falseReliabilityClaim = ["An adopter conformance", "test"].join(" ");
      writeFileSync(join(root, "README.md"), `${forbiddenCoordinate}\n`);
      expect(() => policyVerdict(root, () => undefined)).toThrow(/prohibited private coordinate/);
      writeFileSync(join(root, "README.md"), "# Public source\n"); writeFileSync(join(root, "docs", "platform", "AGENT_GUIDE.md"), `${falseReliabilityClaim} cross-checks every declared signal.\n`); expect(() => policyVerdict(root, () => undefined)).toThrow(/unapproved adopter-owned materialized state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
