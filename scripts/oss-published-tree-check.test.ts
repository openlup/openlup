// Seeded falsifiers for checks that must run in a standalone published checkout. Source composition
// and withholding live in the private split harness; importing either here would make the public
// checker depend on the control plane it is meant to prove absent.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Keep documentation falsifiers under the test file explicitly invoked by Published Tree CI.
import "./documentation-impact.test.ts";
import "./documentation-bundle.test.ts";
import "./documentation-cli.test.ts";
import "./ast-grep/check-filewide-ignore.test.ts";

import {
  PUBLIC_EXECUTION_ENTRYPOINTS,
  createPublicPublicationCatalog,
  createSourceReleaseContract,
  publicPublicationCatalogDigests,
  validateSourceReleaseContract,
} from "./oss-publication-contract.ts";
import {
  assertMaterializedOutputInventory,
  assertMaterializedPublicationCatalog,
  materializedOutputPaths,
  policyVerdict,
  publicInventoryVerdict,
  typecheckVerdict,
} from "./oss-published-tree-check.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, PUBLIC_REQUIRED_TEST_COMMAND, PUBLIC_REQUIRED_TEST_SCOPE, PUBLIC_TEST_COMMAND, PUBLIC_TEST_SCOPE } from "./oss-publication-policy.ts";
import { carriesPrivateOperationalCoordinate } from "./oss-public-coordinate-detector.ts";

import { readManagedMigrationChain } from "./public-ci-pgtap.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/published-tree-ci.yml";
const workflow = readFileSync(join(ROOT, WORKFLOW), "utf8");
const sourcePreviewWorkflow = readFileSync(join(ROOT, ".github/workflows/publish-source-preview.yml"), "utf8");
// Frozen protected-main test command from d0b7e4d9a7ef1653bd0ecaa30d621b6fa72957e7, changed
// deliberately once since: the retired consume engine and consume transport tests left it with
// their modules, and the source preview release test took their place.
// Keep this independent of the policy's derived command: deleting a selector in
// both the package and policy must still fail the required coverage falsifier.
const requiredTestFloor = "node scripts/run-vitest.mjs run scripts/agent-review-queue.test.ts scripts/agent-review-session.test.ts scripts/agent-review-controller.test.ts scripts/agent-review-gate.test.ts scripts/agent-review-hosted.test.ts scripts/source-preview-release.test.ts scripts/packages packages/core server/_lib server/adapters/managed server/adapters/postgres server/bff/admin/commerce/catalog server/bff/commerce server/domains/accounting server/domains/channels server/domains/commerce server/domains/communications server/domains/fulfillment server/domains/payment server/domains/platform server/domains/support server/runtime/communications/newsletterProviderRegistry.test.ts server/runtime/payment/paymentAdapterRegistry.test.ts server/shared src/checkout/adapters src/checkout/machine src/components/admin src/domains/customers src/domains/payment src/domains/platform src/domains/shipping src/domains/subscription src/lib/coreDomains.test.ts src/lib/orderRef.test.ts src/lib/paymentControlPlaneBoundary.test.ts src/pages/account/v2/sections/PaymentCardSetup.test.tsx src/public-reference tests/" + ["str", "ipe"].join("");
const workflowJob = (name: string, source = workflow) => source.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? "";
const workflowCommands = (job: string) => [...job.matchAll(/^ {6}(?:- | {2})run: (?!\|)(.+)$/gmu)].map((match) => match[1]);

describe("maintainer-controlled source preview workflow", () => {
  it("is inert without the repository variable and the protected main environment", () => {
    expect(sourcePreviewWorkflow).toContain("workflow_dispatch:");
    expect(sourcePreviewWorkflow).toContain("target_commit:");
    expect(sourcePreviewWorkflow).toContain("preview_number:");
    expect(sourcePreviewWorkflow).toContain("release_notes:");
    expect(sourcePreviewWorkflow).toContain("github.repository == 'openlup/openlup' && github.ref == 'refs/heads/main' && vars.OPENLUP_SOURCE_RELEASE == 'enabled'");
    expect(sourcePreviewWorkflow).toContain("environment: release");
    expect(sourcePreviewWorkflow).toContain("group: publish-source-preview\n  cancel-in-progress: false");
    expect(sourcePreviewWorkflow).toContain("persist-credentials: false");
    expect(sourcePreviewWorkflow).not.toMatch(/^ {6}contents: write$/mu);
    expect(sourcePreviewWorkflow).not.toContain("${{ inputs.target_commit }}\"\n");
  });

  it("reuses the package workflow's required-context check exactly", () => {
    const packages = readFileSync(join(ROOT, ".github/workflows/publish-packages.yml"), "utf8");
    const loop = (text: string) => / {10}for context in [\s\S]*? {10}done/u.exec(text)?.[0];
    expect(loop(sourcePreviewWorkflow)).toBe(loop(packages)?.replaceAll("GITHUB_SHA", "TARGET_COMMIT"));
    expect(sourcePreviewWorkflow).toContain('git merge-base --is-ancestor "$TARGET_COMMIT" FETCH_HEAD');
    expect(sourcePreviewWorkflow).toContain('test "$(git rev-parse HEAD)" = "$TARGET_COMMIT"');
  });

  it("gates release on a single packed tarball and a checksum-pinned pre-tag scan", () => {
    const preflight = workflowJob("package-preflight", sourcePreviewWorkflow);
    const release = workflowJob("release", sourcePreviewWorkflow);
    const required = [
      'git merge-base --is-ancestor "$TARGET_COMMIT" FETCH_HEAD',
      'for context in dco typecheck install-proof test self-check gitleaks; do',
      'npm ci --ignore-scripts --no-audit --fund=false',
      'scripts/source-preview-release.ts packages',
      'repos/gitleaks/gitleaks/releases/assets/378332058',
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
      'tar -xzf "$tarball" -C "$target"',
      'gitleaks dir "$RUNNER_TEMP/scan" --config config/gitleaks.toml --redact --no-banner',
    ];
    let last = -1;
    for (const step of required) {
      const next = preflight.indexOf(step);
      expect(next, step).toBeGreaterThan(last);
      last = next;
    }
    expect(preflight).not.toContain("OPENLUP_RELEASE_APP_PRIVATE_KEY");
    expect(preflight).not.toContain("permission-contents: write");
    expect(preflight).not.toContain("source-preview-release.ts prepare");
    expect(release).toContain("needs: package-preflight");
  });

  it("pins actions and uses an environment App token for tag and release writes", () => {
    const uses = [...sourcePreviewWorkflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)].map((match) => match[1]);
    expect(uses).toHaveLength(5);
    expect(uses.every((sha) => /^[a-f0-9]{40}$/u.test(sha))).toBe(true);
    expect(sourcePreviewWorkflow).toContain("secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY");
    expect(sourcePreviewWorkflow).toContain("vars.OPENLUP_RELEASE_APP_CLIENT_ID");
    expect(sourcePreviewWorkflow).toContain("repositories: openlup\n          permission-contents: write\n          permission-administration: read");
    for (const name of ["Create the exact annotated tag with the release identity", "Create the draft prerelease", "Publish the immutable prerelease with the release identity"]) {
      const step = sourcePreviewWorkflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
      expect(step).toContain("GH_TOKEN: ${{ steps.release-identity.outputs.token }}");
    }
    expect(sourcePreviewWorkflow).toContain("contents: read\n      checks: read\n      attestations: read\n");
    expect(sourcePreviewWorkflow).not.toMatch(/id-token: write|attestations: write|attest-build-provenance|gh release upload|openlup-source-receipt/u);
    expect(sourcePreviewWorkflow).not.toMatch(/--clobber|git push.*--force|--method DELETE/u);
  });

  it("verifies the previous attestation, checks the draft before publishing and verifies the attested release afterward", () => {
    const steps = ['gh release verify "openlup-source-preview/$((PREVIEW_NUMBER - 1))"', "source-preview-release.ts prepare", "Create the exact annotated tag", "gh release create", "source-preview-release.ts check-draft", "gh release edit", "source-preview-release.ts verify", 'gh release verify "openlup-source-preview/$PREVIEW_NUMBER"'];
    const positions = steps.map((step) => sourcePreviewWorkflow.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(sourcePreviewWorkflow).toContain("--verify-tag --draft --prerelease");
    expect(sourcePreviewWorkflow.match(/--notes-file "\$RELEASE_OUTPUT_DIR\/notes.md"/gu)).toHaveLength(2);
    expect(sourcePreviewWorkflow.match(/immutable-releases/gu)).toHaveLength(2);
    expect(sourcePreviewWorkflow).toContain("Recovery requires the maintainer");
  });
});
describe("complete public CI", () => {
  it("keeps lint fatal after installation and never filters the diagnostic root command", () => {
    const typecheck = workflowJob("typecheck");
    expect(workflowCommands(typecheck)).toEqual(["npm ci", "npm run lint", "npm run oss:published-tree -- --typecheck"]);
    expect(workflowCommands(workflowJob("test-full"))).toEqual(["npm ci", "npm test"]);
    expect(PUBLIC_TEST_COMMAND).toBe("node scripts/run-vitest.mjs run");
    expect(workflow).not.toMatch(/--exclude|continue-on-error|\|\|\s*true|set \+e/u);
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain("src/**/*.{test,spec}.ts");
  });
  it("installs the locked workspace before invoking the pgTAP command", () => {
    const job = workflowJob("pgtap");
    expect(job).toContain("npm ci --prefer-offline --no-audit --fund=false");
    expect(job.indexOf("npm ci ")).toBeLessThan(job.indexOf("node scripts/public-ci-pgtap.mjs"));
    expect(job).toContain("node-version-file: .nvmrc");
  });
  it("uses the pinned local CLI and checks neutrality against the event base", () => {
    expect(workflow).toContain("supabase/setup-cli@45a513f8c64c0bc8e0e3dfe572b5c95be85f6359");
    expect(workflow).toContain("version: 2.98.2");
    expect(workflow).toContain("run: node scripts/public-ci-pgtap.mjs");
    expect(workflow).toContain("github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before");
    expect(workflow).toContain('run: node scripts/public-ci-neutrality.mjs --base-commit "$NEUTRALITY_BASE_COMMIT"');
    expect(workflow).toContain("run: node --experimental-strip-types packages/ui/smoke/neutrality.ts");
  });
  it("preserves every required selector and the subsequent existing steps with fatal neutrality", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(createHash("sha256").update(requiredTestFloor).digest("hex")).toBe("51484fa2f1ef215691d86a1e08f18446147e7ebf7271a621925bb82cd162fe64");
    expect(PUBLIC_REQUIRED_TEST_COMMAND).toBe(requiredTestFloor);
    expect(manifest.scripts["test:required"]).toBe(requiredTestFloor);
    expect(PUBLIC_REQUIRED_TEST_SCOPE).toEqual(requiredTestFloor.split(" ").slice(3));
    expect(manifest.scripts.test).toBe(PUBLIC_TEST_COMMAND);
    expect(manifest.scripts).not.toHaveProperty("test:full");
    expect(workflowCommands(workflowJob("test"))).toEqual([
      "npm ci",
      "npm run test:required",
      "npx vitest run server/runtime/public-reference src/pages/account/v2/subscriptions/modals/RescheduleModal.test.tsx",
      "npm --workspace ./packages/core run ci",
      "npx vitest run scripts/oss-published-tree-check.test.ts",
      "npx vitest run scripts/public-ci-neutrality.test.ts",
    ]);
    const tracked = execFileSync("git", ["ls-files", "-z", ...PUBLIC_REQUIRED_TEST_SCOPE], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
    for (const target of PUBLIC_REQUIRED_TEST_SCOPE) {
      expect(tracked.some((path) => (path === target || path.startsWith(`${target}/`)) && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)), target).toBe(true);
    }
  });
  it("runs root and database diagnostics independently of each other and the required tests", () => {
    for (const name of ["test", "test-full", "pgtap"]) expect(workflowJob(name)).not.toMatch(/^ {4}needs:/mu);
    expect(workflowCommands(workflowJob("pgtap"))).toEqual(["npm ci --prefer-offline --no-audit --fund=false", "node scripts/public-ci-pgtap.mjs"]);
    expect(workflowCommands(workflowJob("self-check"))).toEqual([
      "npm run oss:published-tree -- --policy", "npm run oss:published-tree -- --inventory",
      "node --experimental-strip-types packages/ui/smoke/neutrality.ts",
      'node scripts/public-ci-neutrality.mjs --base-commit "$NEUTRALITY_BASE_COMMIT"',
    ]);
  });
  it("passes the full and frozen required argv to Vitest unchanged and propagates failure", () => {
    const scratch = join(ROOT, ".context/scratch");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "public-test-argv-"));
    const binary = join(directory, "vitest"), log = join(directory, "argv.json");
    try {
      writeFileSync(join(directory, "package.json"), '{"type":"commonjs"}\n');
      writeFileSync(binary, `#!${process.execPath}\nconst environment = Reflect.get(process, 'env'); require('node:fs').writeFileSync(environment.PUBLIC_TEST_ARGV_LOG, JSON.stringify(process.argv.slice(2))); process.exit(Number(environment.PUBLIC_TEST_EXIT));\n`);
      chmodSync(binary, 0o755);
      const run = (args: string[], code: number) => spawnSync(process.execPath, [join(ROOT, "scripts/run-vitest.mjs"), ...args], {
        cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { PATH: directory, CI: "true", PUBLIC_TEST_ARGV_LOG: log, PUBLIC_TEST_EXIT: String(code) },
      });
      const full = run(["run"], 0);
      expect(full.error).toBeUndefined();
      expect(full.status).toBe(0);
      expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(["run"]);
      const required = run(["run", ...PUBLIC_REQUIRED_TEST_SCOPE], 29);
      expect(required.error).toBeUndefined();
      expect(required.status).toBe(29);
      expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(requiredTestFloor.split(" ").slice(2));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
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
  it("runs every required context for main merge groups and isolates their concurrency by event and SHA", () => {
    expect(workflow).toContain("  merge_group:\n    types: [checks_requested]\n    branches: [main]\n");
    expect(workflow).toContain("group: published-tree-ci-${{ github.event_name }}-${{ github.ref }}-${{ github.event_name == 'merge_group' && github.sha || '' }}");
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    const selfCheck = workflow.split("  self-check:\n")[1]?.split("\n  gitleaks:")[0];
    expect(selfCheck).toContain("fetch-depth: 0");
    expect(selfCheck).toContain("run: npm run oss:published-tree -- --policy");
    expect(selfCheck).toContain("run: npm run oss:published-tree -- --inventory");
  });
  it("exposes six required contexts, two raw diagnostics and optional native admission with trusted event fences", () => {
    const jobs = [...(workflow.split("\njobs:\n")[1] ?? "").matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1]);
    expect(jobs).toEqual(["dco", "typecheck", "install-proof", "test", "test-full", "self-check", "gitleaks", "pgtap", "native-review"]);
    expect(workflow).not.toContain("needs: applies");
    const predicate = "    if: ${{ github.event.repository.private == false && (github.event_name != 'pull_request' || (github.event.pull_request.draft == false && (github.event.pull_request.user.login != 'dependabot[bot]' || (github.event.action == 'ready_for_review' && github.event.sender.type == 'User')))) }}";
    expect(workflow.split("\n").filter((line) => line === predicate)).toHaveLength(8);
    for (const job of jobs.filter((name) => name !== "native-review")) expect(workflow).toContain(`  ${job}:\n    name: ${job}\n${predicate}\n`);
    expect(workflow.replace("    name: dco", "    name: dco-renamed")).not.toContain(`  dco:\n    name: dco\n${predicate}\n`);
    expect(workflow.replace(predicate, `${predicate.slice(0, -3)} && false }}`)).not.toContain(`  dco:\n    name: dco\n${predicate}\n`);
  });
  it("native admission uses trusted main and refuses every non-success mechanical result", () => {
    const admission = workflow.split("  native-review:\n")[1]!;
    expect(admission).toContain("always() && vars.OPENLUP_NATIVE_QUEUE == 'enabled'");
    expect(admission).toContain("github.event.repository.private == false");
    expect(admission).toContain("github.event_name == 'merge_group'");
    expect(admission).toContain("github.event_name == 'pull_request' && github.event.pull_request.draft == false");
    expect(admission).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(admission).toContain("needs: [dco, typecheck, install-proof, test, self-check, gitleaks]");
    expect(admission).toContain("timeout-minutes: 25");
    expect(admission).toContain("actions: read\n      contents: read\n      pull-requests: read");
    expect(admission).not.toMatch(/(?:actions|contents|pull-requests): write/u);
    expect(admission).toContain("ref: main\n          fetch-depth: 0\n          persist-credentials: false");
    expect(admission).toContain("run: node scripts/agent-review-queue.mjs wait");
    expect(admission).not.toContain("npm ci");
    const command = admission.split("        run: |\n")[1]?.split("      - uses:")[0]?.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
    expect(command).toBeTruthy();
    const names = ["NEEDS_DCO", "NEEDS_TYPECHECK", "NEEDS_INSTALL_PROOF", "NEEDS_TEST", "NEEDS_SELF_CHECK", "NEEDS_GITLEAKS"];
    const successes = Object.fromEntries(names.map((name) => [name, "success"]));
    const run = (patch = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command!], { env: { ...process.env, ...successes, ...patch }, encoding: "utf8", timeout: 5000 });
    expect(run().status).toBe(0);
    for (const name of names) for (const result of ["skipped", "failure", "cancelled", ""]) {
      const refused = run({ [name]: result }); expect(refused.status).toBe(1); expect(refused.stderr).toContain("six actual mechanical successes");
    }
  });

  it("holds every pull request to the sign-off the contributing document promises", () => {
    // The promise: CONTRIBUTING.md documents the trailer and says `git commit -s` writes it. Until
    // the `dco` job existed nothing read a commit message, so the requirement was enforced against
    // nobody. These two assertions are what keep the document and the automation the same rule.
    const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(/^Signed-off-by: .+ <.+@.+>$/m.test(contributing)).toBe(true);
    expect(workflow).toContain('npm run check:dco-signoff -- "$RANGE_BASE" "$RANGE_HEAD"');
    expect(workflow).toContain("RANGE_BASE: ${{ github.event.before }}");
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("checks the actual main-push DCO step for root, descendant and refusal ranges", () => {
    const root = mkdtempSync(join(tmpdir(), "public-main-dco-"));
    const environment = { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=A Contributor", "-c", "user.email=contributor@example.com", ...args], { cwd: root, env: environment, encoding: "utf8" }).trim();
    const step = workflow.split("      - name: Sign-off on every main push\n")[1]?.split("\n  typecheck:")[0];
    const command = step?.split("        run: |\n")[1]?.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
    expect(command).toBeTruthy();
    try {
      writeFileSync(join(root, "dco-signoff-check.ts"), readFileSync(join(ROOT, "scripts/dco-signoff-check.ts")));
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "check:dco-signoff": "node --experimental-strip-types dco-signoff-check.ts" } }));
      git("init", "--quiet", "--initial-branch=main");
      const commit = (signed: boolean) => { git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", ...(signed ? ["-s"] : []), "-m", "public DCO fixture"); return git("rev-parse", "HEAD"); };
      const initial = commit(true), descendant = commit(true);
      commit(false);
      const afterUnsigned = commit(true);
      const run = (base: string, head: string) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command!], { cwd: root, env: { ...environment, RANGE_BASE: base, RANGE_HEAD: head }, encoding: "utf8", timeout: 20_000 });
      expect(run("0".repeat(40), initial).status).toBe(0);
      expect(run(initial, descendant).status).toBe(0);
      const missing = run(descendant, afterUnsigned);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain("without a sign-off: 1");
      expect(run(descendant, descendant).status).toBe(1);
      expect(run("0".repeat(40), descendant).status).toBe(2);
      expect(run("invalid", descendant).status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("checks the actual group DCO range and refuses unsigned contributions, unsigned group tips and event drift", () => {
    const root = mkdtempSync(join(tmpdir(), "public-queue-dco-"));
    const environment = { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=A Contributor", "-c", "user.email=contributor@example.com", ...args], { cwd: root, env: environment, encoding: "utf8" }).trim();
    const step = workflow.split("      - name: Sign-off on every merge-group commit\n")[1]?.split("      - name: Sign-off on every main push\n")[0];
    const command = step?.split("        run: |\n")[1]?.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
    expect(command).toBeTruthy();
    expect(step).toContain("RANGE_BASE: ${{ github.event.merge_group.base_sha }}");
    expect(step).toContain("RANGE_HEAD: ${{ github.event.merge_group.head_sha }}");
    try {
      writeFileSync(join(root, "dco-signoff-check.ts"), readFileSync(join(ROOT, "scripts/dco-signoff-check.ts")));
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "check:dco-signoff": "node --experimental-strip-types dco-signoff-check.ts" } }));
      git("init", "--quiet", "--initial-branch=main"); git("add", "."); git("commit", "--quiet", "--no-gpg-sign", "-s", "-m", "baseline");
      const base = git("rev-parse", "HEAD"); let serial = 0;
      const group = (sourceSigned: boolean, mergeSigned: boolean) => {
        serial += 1; const topic = `topic-${serial}`;
        git("checkout", "-qb", topic, base);
        git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", ...(sourceSigned ? ["-s"] : []), "-m", "first contribution");
        git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-s", "-m", "signed tip contribution");
        git("checkout", "-qb", `group-${serial}`, base);
        git("merge", "--quiet", "--no-ff", "--no-gpg-sign", ...(mergeSigned ? ["--signoff"] : []), "-m", "Queue group", topic);
        return git("rev-parse", "HEAD");
      };
      const ref = "refs/heads/gh-readonly-queue/main/pr-1-fixture";
      const run = (head: string, patch: Record<string, string> = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command!], {
        cwd: root, env: { ...environment, QUEUE_ACTION: "checks_requested", RANGE_BASE: base, RANGE_HEAD: head,
          RANGE_BASE_REF: "refs/heads/main", RANGE_REF: ref, GITHUB_REF: ref, GITHUB_SHA: head, ...patch }, encoding: "utf8", timeout: 20_000,
      });
      const signed = group(true, true); const pass = run(signed);
      expect(pass.status).toBe(0); expect(pass.stdout).toContain("- commits read: 3");
      for (const patch of [{ QUEUE_ACTION: "destroyed" }, { RANGE_BASE: "" }, { RANGE_BASE: "invalid" }, { RANGE_BASE: "0".repeat(40) },
        { RANGE_BASE: signed }, { RANGE_HEAD: "f".repeat(40) }, { RANGE_BASE_REF: "refs/heads/other" },
        { RANGE_REF: "refs/heads/main" }, { GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-2-fixture" }, { GITHUB_SHA: base }])
        expect(run(signed, patch).status).not.toBe(0);
      const unsignedContribution = run(group(false, true));
      expect(unsignedContribution.status).toBe(1); expect(unsignedContribution.stdout).toContain("without a sign-off: 1");
      const unsignedGroup = run(group(true, false));
      expect(unsignedGroup.status).toBe(1); expect(unsignedGroup.stdout).toContain("without a sign-off: 1");
      expect(run(signed).status).not.toBe(0); // Event head no longer matches the actual checkout.
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("pins every action and verifies the runtime and scanner before use", () => {
    const uses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)(?:\s+#\s+v\d+)?/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((sha) => /^[a-f0-9]{40}$/u.test(sha))).toBe(true);
    expect(readFileSync(join(ROOT, ".nvmrc"), "utf8").trim()).toBe("24");
    for (const name of ["typecheck", "install-proof", "test", "test-full", "pgtap"]) {
      const job = workflowJob(name);
      expect(job).toContain('test "$(node -p \'process.versions.node.split(".")[0]\')" = "24"');
      expect(job).toContain('test "$(npm --version)" = "11.19.0"');
      expect(job).toContain('test "$(node -p \'require("./package.json").engines.node\')" = "24.x"');
      expect(job).toContain('test "$(node -p \'require("./package.json").packageManager\')" = "npm@11.19.0"');
      expect(job).toContain("node-version-file: .nvmrc");
    }
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
    expect(PUBLIC_TEST_COMMAND).toBe("node scripts/run-vitest.mjs run");
    expect(scope).toEqual(["api", "mcp", "scripts", "server", "src", "tests"]);
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

  it("refuses a contract that still carries the retired downstream sourceSeed field", () => {
    const zero = `sha256-${"0".repeat(64)}`;
    const contract = JSON.parse(createSourceReleaseContract({ inventoryDigest: zero, classDigest: zero, packageDigest: zero, rootLockDigest: zero, coreLockDigest: zero, migrationManifestDigest: zero, databaseTypesDigest: zero, policyRegistryDigest: zero, publicationCatalogDigest: zero }).contents) as Record<string, unknown>;
    expect(() => validateSourceReleaseContract(JSON.stringify(contract))).not.toThrow();
    for (const sourceSeed of [{ publicationCatalogInventoryDigest: zero, publicationCatalogClassDigest: zero }, {}, null]) {
      expect(() => validateSourceReleaseContract(JSON.stringify({ ...contract, sourceSeed }))).toThrow(/sourceSeed is a retired downstream field/);
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

describe("the materialized public catalogue", () => {
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
        (manifest: { scripts: Record<string, string>; bin?: Record<string, string> }) => { manifest.scripts.test = "node scripts/run-vitest.mjs run scripts"; },
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
      writeFileSync(join(root, "docs", "platform", "README.md"), "[Guide](AGENT_GUIDE.md)\n[Directory](../../docs/platform/)\n");
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
          id: "example-withheld",
          status: "withheld",
          reason: "No public invocation is registered.",
          withheldPaths: ["scripts/example-withheld-guard.ts"],
          withheldCommands: ["guard:example-withheld"],
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
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { ...Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])), "guard:example-withheld": "node scripts/example-withheld-guard.ts" } }));
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


describe("committed managed migration inventory", () => {
  function fixture(files: Record<string, string>, check: (directory: string) => void) {
    const scratch = join(ROOT, ".context/scratch");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "migration-inventory-test-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
    try {
      git("init", "--quiet");
      mkdirSync(join(directory, "supabase/migrations"), { recursive: true });
      for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, "supabase/migrations", name), bytes);
      git("add", "supabase/migrations");
      git("-c", "user.name=Bartłomiej Roszkowski", "-c", "user.email=dev@openlup.com", "commit", "--quiet", "-s", "-m", "Synthetic migration inventory fixture");
      check(directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const baseline = "00000000000000_platform_schema_baseline.sql";
  const forward = "20260927090000_forward.sql";
  const chain = { [baseline]: "SELECT 1;\n", [forward]: "SELECT 2;\n" };
  it("uses exactly the committed baseline and ordered forward bytes", () => {
    fixture(chain, directory => expect(readManagedMigrationChain(directory)).toEqual([
      { name: baseline, contents: chain[baseline] }, { name: forward, contents: chain[forward] },
    ]));
  });
  it("refuses duplicate committed versions before replay", () => {
    fixture({ ...chain, "20260927090000_duplicate.sql": "SELECT 3;" }, directory => {
      expect(() => readManagedMigrationChain(directory)).toThrow(/duplicate managed migration version/);
    });
  });
  it.each(["missing", "modified", "untracked", "symlink", "executable"])("refuses a %s working migration", variant => {
    fixture(chain, directory => {
      const path = join(directory, "supabase/migrations", forward);
      if (variant === "missing" || variant === "symlink") unlinkSync(path);
      if (variant === "modified") writeFileSync(path, "SELECT 99;");
      if (variant === "executable") chmodSync(path, 0o755);
      if (variant === "untracked") writeFileSync(join(directory, "supabase/migrations/20260928000000_extra.sql"), "SELECT 3;");
      if (variant === "symlink") symlinkSync(baseline, path);
      expect(() => readManagedMigrationChain(directory)).toThrow(/managed migration/);
    });
  });
  it("refuses malformed committed identities", () => {
    fixture({ [baseline]: "SELECT 1;", "invalid.sql": "SELECT 2;" }, directory => {
      expect(() => readManagedMigrationChain(directory)).toThrow(/invalid committed managed migration identity/);
    });
  });
});

describe("owned pgTAP command lifecycle", () => {
  type Observation = { stage: string; args: string[]; input: string; tests?: Record<string, string>; config?: string };
  // Execute the shipped runner, with every external command replaced on PATH.
  // These subprocesses cannot find the host's Docker, Supabase or Git binaries.
  function observe(scenario: string, check: (result: ReturnType<typeof spawnSync>, calls: Observation[], directory: string) => void) {
    const scratch = join(ROOT, ".context/scratch");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pgtap-lifecycle-test-"));
    const baseline = "00000000000000_platform_schema_baseline.sql", forward = "20260927090000_forward.sql";
    const migrations = { [baseline]: "SELECT 'baseline replay';\n", [forward]: "SELECT 'ordered forward';\n" };
    const inventory = Object.entries(migrations).map(([name, bytes]) => `100644 blob ${createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex")}\tsupabase/migrations/${name}\0`).join("");
    try {
      writeFileSync(join(directory, "package.json"), '{"type":"commonjs"}\n');
      for (const folder of ["scripts/public-reference", "config", "supabase/migrations", "supabase/tests", "bin"]) mkdirSync(join(directory, folder), { recursive: true });
      writeFileSync(join(directory, "scripts/public-ci-pgtap.mjs"), readFileSync(join(ROOT, "scripts/public-ci-pgtap.mjs")));
      writeFileSync(join(directory, "scripts/public-reference/subscription-prereqs.sql"), "SELECT 'prerequisites';\n");
      writeFileSync(join(directory, "config/public-reference-subscription-supabase.toml"), readFileSync(join(ROOT, "config/public-reference-subscription-supabase.toml")));
      for (const [name, bytes] of Object.entries(migrations)) writeFileSync(join(directory, "supabase/migrations", name), bytes);
      if (scenario === "inventory") writeFileSync(join(directory, "supabase/migrations", forward), "SELECT 'uncommitted';\n");
      writeFileSync(join(directory, "supabase/tests/first_test.sql"), "BEGIN; SELECT 'first assertion'; ROLLBACK;\n");
      writeFileSync(join(directory, "supabase/tests/second_test.sql"), "BEGIN; SELECT 'second assertion'; ROLLBACK;\n");
      const standIn = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const environment = Reflect.get(process, 'env');
const scenario = environment.PGTAP_STAND_IN_SCENARIO;
const input = fs.readFileSync(0, 'utf8');
const stage = command === 'git' ? 'inventory' : command === 'supabase' ? (args[0] === '--version' ? 'version' : args[0]) : args[0] === 'restart' ? 'restart' : args.includes('-1') ? 'replay' : args.includes('-i') ? 'formatter' : 'readback';
const row = { stage, args, input };
if (stage === 'start' || stage === 'test') {
  const directory = args[args.indexOf('--workdir') + 1];
  row.config = fs.readFileSync(path.join(directory, 'supabase/config.toml'), 'utf8');
  if (stage === 'test') row.tests = Object.fromEntries(fs.readdirSync(path.join(directory, 'supabase/tests')).map(name => [name, fs.readFileSync(path.join(directory, 'supabase/tests', name), 'utf8')]));
}
fs.appendFileSync(environment.PGTAP_STAND_IN_LOG, JSON.stringify(row) + '\\n');
if (stage === 'inventory') {
  if (JSON.stringify(args.slice(0, 3)) !== JSON.stringify(['--no-replace-objects', '-C', process.cwd()]) || args[3] !== 'ls-tree') process.exit(90);
  process.stdout.write(JSON.parse(environment.PGTAP_STAND_IN_INVENTORY));
} else if (stage === 'version') process.stdout.write(scenario === 'version' ? '2.98.1\\n' : '2.98.2\\n');
else if (stage === 'readback') process.stdout.write(scenario === 'readback' ? 'f\\n' : 't\\n');
else if (stage === 'test') {
  process.stdout.write('raw pgTAP stdout\\n');
  process.stderr.write('raw pgTAP stderr\\n');
  if (scenario === 'signal') process.kill(process.pid, 'SIGTERM');
}
if ((scenario === stage && !['inventory', 'version', 'readback'].includes(stage)) || (scenario === 'cleanup' && stage === 'stop')) {
  process.stderr.write('stand-in ' + stage + ' failure\\n');
  process.exit(stage === 'test' ? 37 : 42);
}
`;
      for (const command of ["git", "supabase", "docker"]) {
        const path = join(directory, "bin", command);
        writeFileSync(path, standIn);
        chmodSync(path, 0o755);
      }
      const log = join(directory, "calls.jsonl");
      const result = spawnSync(process.execPath, [join(directory, "scripts/public-ci-pgtap.mjs")], {
        cwd: directory, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
        env: { PATH: join(directory, "bin"), PGTAP_STAND_IN_SCENARIO: scenario, PGTAP_STAND_IN_LOG: log, PGTAP_STAND_IN_INVENTORY: JSON.stringify(inventory) },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Observation);
      check(result, calls, directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  it("replays the ordered chain in one transaction and runs every SQL file unchanged before own cleanup", () => {
    observe("pass", (result, calls) => {
      expect(result.status).toBe(0);
      expect(calls.map(({ stage }) => stage)).toEqual(["inventory", "version", "start", "formatter", "restart", "readback", "replay", "test", "stop"]);
      const start = calls.find(({ stage }) => stage === "start")!, replay = calls.find(({ stage }) => stage === "replay")!, tests = calls.find(({ stage }) => stage === "test")!, stop = calls.at(-1)!;
      expect(start.args).toContain("--exclude");
      expect(start.config).toMatch(/project_id = "openlup-ci-[a-f0-9]{16}"/u);
      expect(start.config).not.toContain("{{");
      const id = /project_id = "([^"]+)"/u.exec(start.config!)![1];
      for (const call of calls.filter(({ stage }) => ["formatter", "restart", "readback", "replay"].includes(stage))) expect(call.args).toContain(`supabase_db_${id}`);
      expect(replay.args).toContain("-1");
      expect(replay.args).toContain("ON_ERROR_STOP=1");
      expect(replay.input.indexOf("SELECT 'baseline replay'")).toBeLessThan(replay.input.indexOf("SELECT 'ordered forward'"));
      expect(replay.input).toContain("SET ROLE postgres;");
      expect(replay.input).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;");
      expect(replay.input).toContain("WHERE e.extname = 'pgtap' AND d.deptype = 'e'");
      expect(replay.input).not.toMatch(/GRANT EXECUTE ON ALL FUNCTIONS|GRANT ALL/u);
      expect(calls.find(({ stage }) => stage === "formatter")!.input).toBe("ALTER SYSTEM SET supautils.hint_roles = '';");
      expect(calls.find(({ stage }) => stage === "readback")!.args).toContain("SELECT current_setting('supautils.hint_roles') = ''");
      expect(tests.tests).toEqual({
        "first_test.sql": "BEGIN; SELECT 'first assertion'; ROLLBACK;\n",
        "second_test.sql": "BEGIN; SELECT 'second assertion'; ROLLBACK;\n",
      });
      expect(tests.args).toContain("--db-url");
      expect(tests.args.at(-1)).toMatch(/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/u);
      expect(stop.args).toEqual(["stop", "--workdir", start.args[start.args.indexOf("--workdir") + 1], "--no-backup"]);
    });
  });
  it("preserves a raw test failure, both output streams and its log while cleaning up", () => {
    observe("test", (result, calls, directory) => {
      expect(result.status).toBe(37);
      expect(result.stdout).toContain("raw pgTAP stdout");
      expect(result.stderr).toContain("raw pgTAP stderr");
      expect(readFileSync(join(directory, ".context/scratch/pgtap/latest.log"), "utf8")).toContain("stand-in test failure");
      expect(calls.at(-1)!.stage).toBe("stop");
    });
  });
  it.each(["start", "formatter", "restart", "readback", "replay"])("refuses a %s infrastructure failure and still cleans up only its attempted project", scenario => {
    observe(scenario, (result, calls) => {
      expect(result.status).toBe(1);
      expect(calls.some(({ stage }) => stage === "test")).toBe(false);
      const start = calls.find(({ stage }) => stage === "start")!;
      expect(calls.at(-1)!.args).toEqual(["stop", "--workdir", start.args[start.args.indexOf("--workdir") + 1], "--no-backup"]);
      expect(result.stderr).toContain(scenario === "readback" ? "workaround did not take effect" : `stand-in ${scenario} failure`);
    });
  });
  it("refuses cleanup failure even when all assertions passed", () => {
    observe("cleanup", (result, calls) => {
      expect(calls.some(({ stage }) => stage === "test")).toBe(true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Owned stack cleanup failed");
    });
  });
  it("treats a signalled test transport as failure and still cleans up", () => {
    observe("signal", (result, calls) => {
      expect(result.status).toBe(1);
      expect(calls.at(-1)!.stage).toBe("stop");
    });
  });
  it.each(["version", "inventory"])("refuses %s before any stack lifecycle call", scenario => {
    observe(scenario, (result, calls) => {
      expect(result.status).toBe(1);
      expect(calls.some(({ stage }) => ["start", "stop", "test"].includes(stage))).toBe(false);
      expect(result.stderr).toContain(scenario === "version" ? "requires Supabase CLI 2.98.2" : "bytes differ from committed candidate");
    });
  });
});
