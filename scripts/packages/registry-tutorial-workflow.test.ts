// The advisory tutorial and exact-set qualification follow publication independently of PR CI.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertReleaseProvenance, buildQualifiedImage, proveNeutralStarterConsumer, qualificationReceipt, qualifyReleasedSet, verifiedReleasePackages } from "./exact-set-qualification.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(join(ROOT, ".github/workflows/registry-tutorial.yml"), "utf8");
const job = (source: string, name: string) => source.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? "";
const step = (source: string, name: string) => source.split(`      - name: ${name}\n`)[1]?.split(/^ {6}- /mu)[0] ?? "";
const script = (stepText: string) => (stepText.split("        run: |\n")[1] ?? "").replace(/^ {10}/gmu, "");
const triggers = (source: string) => [...(source.split("\non:\n")[1]?.split("\npermissions:")[0] ?? "").matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]);
const stepList = (jobText: string) => jobText.split(/^ {6}- /mu).slice(1).map((text) => text.slice(text.startsWith("name: ") ? 6 : 0, text.indexOf("\n")));
const stepTexts = (jobText: string) => jobText.split(/^ {6}- /mu).slice(1).map((text) => text.replace(/\n+$/u, "\n").replace(/(?: {6}#[^\n]*\n)+$/u, ""));
const permissionBlocks = (source: string) => [...source.matchAll(/^( *)permissions:(.*)\n((?:\1 {2}\S.*\n)*)/gmu)].map((match) => `${match[1]}permissions:${match[2]}\n${match[3]}`);
const conditions = (source: string) => [...source.matchAll(/^ *if:.*$/gmu)].map((match) => match[0]);
const CHECKOUT = "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n          fetch-depth: 1\n";
const SETUP_NODE = "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6\n        with:\n          node-version: 24.21.0\n          package-manager-cache: false\n";
// Only this repository's successful release runs, with this repository as the head repository.
// A release has no pull-request context; checkout keeps the trusted default branch.
const REGISTRY_GATE = "if: ${{ github.repository == 'openlup/openlup' && ((github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) || (github.event_name == 'workflow_run' && github.event.workflow_run.repository.full_name == 'openlup/openlup' && github.event.workflow_run.head_repository.full_name == 'openlup/openlup' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'release' && startsWith(github.event.workflow_run.head_branch, 'openlup-core-v'))) }}";
const REGISTRY_READY = "        if: steps.registry.outputs.ready == 'true'";
const REGISTRY_CLEANUP = "        if: always() && steps.postgres.outcome != 'skipped'";
const REGISTRY_STEP = "Guide tutorial against the npm registry (advisory)";
const REGISTRY_WAIT = "Wait for the published set on npm";
const RELEASE_PAGE = "Read the release's tutorial page";

describe("the advisory registry tutorial after publication", () => {
  const tutorial = job(workflow, "registry-tutorial");
  const wait = script(step(tutorial, REGISTRY_WAIT));

  it("runs separately after successful core release publication with only read access and a trusted default-branch checkout", () => {
    const publisher = readFileSync(join(ROOT, ".github/workflows/publish-packages.yml"), "utf8");
    expect(publisher).toContain("name: Publish Packages\n");
    expect(publisher).toContain("on:\n  release:\n    types: [published]\n");
    expect(workflow).toContain("name: Guide tutorial against the npm registry\n");
    expect(triggers(workflow)).toEqual(["workflow_run", "workflow_dispatch"]);
    expect(workflow).toContain("  workflow_run:\n    workflows: [Publish Packages]\n    types: [completed]\n");
    expect(workflow).toContain("# workflow_run executes trusted default-branch workflow and runner code.");
    expect(workflow).toContain("concurrency:\n  group: registry-tutorial-${{ inputs.release_tag || github.event.workflow_run.head_branch }}\n  cancel-in-progress: false\n");
    expect(conditions(tutorial)).toEqual([`    ${REGISTRY_GATE}`, REGISTRY_READY, REGISTRY_READY, REGISTRY_CLEANUP]);
    expect(permissionBlocks(tutorial)).toEqual(["    permissions:\n      contents: read\n"]);
    expect(tutorial).not.toMatch(/secrets\.|github\.token|id-token|environment:|strategy:|needs:|continue-on-error|npm (?:ci|install)\b/u);
    expect([...workflow.split("\njobs:\n")[1]!.matchAll(/^ {2}([a-z][a-z-]*):$/gmu)].map(match => match[1])).toEqual(["registry-tutorial", "exact-set-qualification", "publish-qualified-image"]);
    expect(tutorial).toContain("    timeout-minutes: 20\n");
    expect(stepTexts(tutorial)[1]).toBe(CHECKOUT);
    expect(stepTexts(tutorial)[2]).toBe(SETUP_NODE);
    expect(stepList(tutorial)).toEqual([
      "Validate the core release tag", CHECKOUT.split("\n")[0], SETUP_NODE.split("\n")[0], RELEASE_PAGE, REGISTRY_WAIT,
      "Start the pinned package-proof PostgreSQL service", REGISTRY_STEP, "Remove the package-proof PostgreSQL service",
    ]);
  });

  it("never checks out a fork or pull-request ref", () => {
    expect(conditions(tutorial)[0]).toContain("github.event.workflow_run.head_repository.full_name == 'openlup/openlup'");
    expect(workflow).not.toMatch(/pull_request|head_ref|head\.ref/u);
    expect(workflow).not.toMatch(/^\s*ref:/mu);
    for (const text of stepTexts(tutorial)) expect(text.split("        run: ")[1] ?? "").not.toContain("${{ github.event.");
  });

  it("reads only the release tag's page after verifying its commit against the completed run", () => {
    const page = step(tutorial, RELEASE_PAGE);
    expect(page).toContain("RELEASE_TAG: ${{ inputs.release_tag || github.event.workflow_run.head_branch }}");
    expect(page).toContain("HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(script(page)).toContain('git fetch --no-tags --depth=1 origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"');
    expect(script(page)).toContain('if [ -n "$HEAD_SHA" ] && [ "$commit" != "$HEAD_SHA" ]; then');
    expect(script(page)).toContain('git show "refs/tags/$RELEASE_TAG:packages/core/docs/guide/start/tutorial.md" > "$RUNNER_TEMP/tutorial.md"');
  });

  function releasePage(matches: boolean | "manual") {
    const directory = mkdtempSync(join(tmpdir(), "openlup-release-page-"));
    try {
      const origin = join(directory, "origin"), workspace = join(directory, "workspace"), temporary = join(directory, "runner-temp");
      mkdirSync(origin); mkdirSync(temporary);
      const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
      const env = { ...inherited, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
      const git = (cwd: string, args: string[], input?: string) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      git(origin, ["init", "--quiet", "--initial-branch=main"]);
      const pagePath = "packages/core/docs/guide/start/tutorial.md";
      // Build disposable fixture commits directly, without staging or committing this worktree.
      const commit = (page: string, parent?: string) => {
        const blob = git(origin, ["hash-object", "-w", "--stdin"], page);
        git(origin, ["update-index", "--add", "--cacheinfo", "100644", blob, pagePath]);
        const tree = git(origin, ["write-tree"]);
        const sha = git(origin, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Tutorial fixture"]);
        git(origin, ["update-ref", "refs/heads/main", sha]);
        return sha;
      };
      const released = "# Released tutorial\n", trusted = "# Default-branch tutorial\n";
      const published = commit(released), main = commit(trusted, published);
      const tag = "openlup-core-v0.13.1";
      git(origin, ["tag", "-a", tag, published, "-m", "Release fixture"]);
      git(directory, ["clone", "--quiet", "--no-tags", origin, workspace]);
      expect(git(workspace, ["tag", "--list"])).toBe("");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script(step(tutorial, RELEASE_PAGE))], {
        cwd: workspace, env: { ...env, RELEASE_TAG: tag, HEAD_SHA: matches === "manual" ? "" : matches ? published : main, RUNNER_TEMP: temporary, GITHUB_OUTPUT: join(temporary, "output") }, encoding: "utf8", timeout: 5000,
      });
      const page = join(temporary, "tutorial.md");
      expect(git(workspace, ["rev-list", "-n", "1", `refs/tags/${tag}`])).toBe(published);
      expect(git(workspace, ["rev-parse", "HEAD"])).toBe(main);
      expect(readFileSync(join(workspace, pagePath), "utf8")).toBe(trusted);
      return { ...result, page: existsSync(page) ? readFileSync(page, "utf8") : undefined, released };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("fetches a matching release tag and writes its page without changing the trusted checkout", () => {
    const result = releasePage(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.page).toBe(result.released);
  });

  it("reads an existing tag for manual qualification without requiring a completed run SHA", () => {
    const result = releasePage("manual");
    expect(result.status, result.stderr).toBe(0);
    expect(result.page).toBe(result.released);
  });

  it("refuses a release tag whose commit differs from HEAD_SHA without writing a page", () => {
    const result = releasePage(false);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("::error::Release tag commit does not match the completed publication run");
    expect(result.page).toBeUndefined();
  });

  it("refuses malformed or non-core tags before checkout or any registry request", () => {
    const validation = step(tutorial, "Validate the core release tag");
    expect(validation).toContain("RELEASE_TAG: ${{ inputs.release_tag || github.event.workflow_run.head_branch }}");
    const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
    for (const tag of ["openlup-core-v0.13.1", "openlup-core-v1.0.0", "", "main", "refs/tags/openlup-core-v0.13.1", "openlup-platform-v0.13.1", "openlup-core-v", "openlup-core-v01.13.1", "openlup-core-v0.013.1", "openlup-core-v0.13.01", "openlup-core-v0.13.1-preview.1", "openlup-core-v0.13.1+build", "openlup-core-v0.13.1\necho unexpected"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script(validation)], { env: { ...inherited, RELEASE_TAG: tag }, encoding: "utf8", timeout: 5000 });
      const valid = ["openlup-core-v0.13.1", "openlup-core-v1.0.0"].includes(tag);
      expect(result.status, tag).toBe(valid ? 0 : 1);
      expect(result.stdout, tag).toBe(valid ? "" : "::error::Expected an openlup-core-vMAJOR.MINOR.PATCH release tag\n");
    }
  });

  it("uses the existing PostgreSQL pin, readiness probe and cleanup around the verbatim advisory runner", () => {
    const candidateWorkflow = readFileSync(join(ROOT, ".github/workflows/published-tree-ci.yml"), "utf8");
    const startName = "Start the pinned package-proof PostgreSQL service";
    const start = step(tutorial, startName);
    expect(start).toContain('pullWithRetry(readCiImage("install-proof-postgres"))');
    // The database lifecycle is the candidate's, with public pull fallback because this job has no credentials.
    for (const line of script(step(candidateWorkflow, startName)).split("\n").filter(line => /^(?:container=|echo )/u.test(line))) expect(start).toContain(line);
    const readiness = "for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres -t 1 && exit 0; sleep 1; done; exit 1";
    expect(readFileSync(join(ROOT, "scripts/packages/platform-cold-consumer.ts"), "utf8")).toContain(readiness);
    expect(start).toContain(`docker exec "$container" sh -c '${readiness}'`);
    expect(step(tutorial, "Remove the package-proof PostgreSQL service").trimEnd()).toBe(`${REGISTRY_CLEANUP}\n        run: docker rm -f install-proof-postgres`);
    expect(step(tutorial, REGISTRY_STEP)).toBe(`${REGISTRY_READY}\n        timeout-minutes: 4\n        env:\n          OPENLUP_PROOF_SERVICE_PORT: \${{ steps.postgres.outputs.port }}\n        run: node --experimental-strip-types scripts/packages/guide-tutorial.ts --advisory --registry --page "$RUNNER_TEMP/tutorial.md" --database-url "postgresql://postgres@127.0.0.1:$OPENLUP_PROOF_SERVICE_PORT/postgres"\n`);
    const advisoryComment = "      # --advisory reports a failed tutorial as a warning and exits 0. Remove it after two green\n      # merge-group runs on main to make the step blocking (documentation programme, decision D4).\n";
    expect(candidateWorkflow).not.toContain(advisoryComment);
    expect(tutorial).toContain(advisoryComment);
    const candidate = step(candidateWorkflow, "Guide tutorial against the packed candidate");
    expect(candidate).toContain("run: node --experimental-strip-types scripts/packages/guide-tutorial.ts --page");
    expect(candidate).not.toContain("--advisory");
    expect(candidateWorkflow).not.toContain("Guide tutorial against the packed candidate (advisory)");
  });

  function registryWait(answers: Array<{ version?: string; fail?: boolean }>, expire = false, event = "workflow_run") {
    const directory = mkdtempSync(join(tmpdir(), "openlup-registry-wait-"));
    try {
      const bin = join(directory, "bin"), log = join(directory, "requests"), output = join(directory, "output"), summary = join(directory, "summary");
      mkdirSync(bin);
      // The real node command still reads the repository's package inventory. Only network and time are fixtures.
      writeFileSync(log, ""); writeFileSync(output, ""); writeFileSync(summary, "");
      writeFileSync(join(bin, "npm"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const log = ${JSON.stringify(log)}, answers = ${JSON.stringify(answers)};
const index = readFileSync(log, "utf8").split("\\n").filter(Boolean).length;
appendFileSync(log, JSON.stringify(Reflect.get(process, "argv").slice(2)) + "\\n");
const answer = answers[index] ?? { fail: true };
if (answer.fail) process.exit(1);
console.log(answer.version);
`);
      writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
      for (const name of ["npm", "sleep", "timeout"]) chmodSync(join(bin, name), 0o755);
      const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
      const source = expire ? wait.replace("SECONDS + 600", "SECONDS + 0") : wait;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", source], {
        cwd: ROOT, env: { ...inherited, PATH: `${bin}:${inherited.PATH}`, RELEASE_TAG: "openlup-core-v0.13.1", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, EVENT_NAME: event }, encoding: "utf8", timeout: 5000,
      });
      return { ...result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), requests: readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("retries registry errors and stale versions, waiting for the full set and core's latest value", () => {
    expect(step(tutorial, REGISTRY_WAIT)).toContain("RELEASE_TAG: ${{ inputs.release_tag || github.event.workflow_run.head_branch }}");
    expect(wait).toContain('version="${RELEASE_TAG##*-v}"');
    expect(wait).toContain("deadline=$((SECONDS + 600))");
    expect(wait).toContain('timeout "$remaining" npm view "$spec" version');
    expect(wait).toContain("if (( delay < 30 )); then delay=$((delay + 5)); fi");
    const packages = JSON.parse(readFileSync(join(ROOT, "config/openlup-packages.json"), "utf8")).packages.filter((entry: { publish: boolean }) => entry.publish).map((entry: { name: string }) => `${entry.name}@0.13.1`);
    const green = packages.map(() => ({ version: "0.13.1" }));
    const result = registryWait([{ fail: true }, { version: "0.12.0" }, ...green, { version: "0.12.0" }, ...green, { version: "0.13.1" }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("ready=true\n");
    expect(result.summary).toBe("");
    expect(result.requests.map(args => args.slice(0, 3))).toEqual([packages[0], packages[0], ...packages, "@openlup/core", ...packages, "@openlup/core"].map(spec => ["view", spec, "version"]));
    for (const args of result.requests) expect(args.slice(3)).toEqual(["--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=10000"]);
  });

  it("qualifies historical dispatch versions without waiting for latest", () => {
    const count = JSON.parse(readFileSync(join(ROOT, "config/openlup-packages.json"), "utf8")).packages.filter((entry: { publish: boolean }) => entry.publish).length;
    const result = registryWait(Array.from({ length: count }, () => ({ version: "0.13.1" })), false, "workflow_dispatch");
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("ready=true\n");
    expect(result.requests).toHaveLength(count);
  });

  it("warns and defers without running the tutorial when the bounded propagation wait expires", () => {
    const result = registryWait([], true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("");
    expect(result.stdout).toContain("::warning title=Guide tutorial::");
    expect(result.summary).toContain("Guide tutorial: deferred (advisory)");
    expect(result.summary).toContain("0.13.1 was not visible on npm within 10 minutes.");
    expect(result.requests).toEqual([]);
    expect(step(tutorial, "Start the pinned package-proof PostgreSQL service")).toContain(REGISTRY_READY);
    expect(step(tutorial, REGISTRY_STEP)).toContain(REGISTRY_READY);
  });
});


describe("exact published-set qualification", () => {
  const qualification = job(workflow, "exact-set-qualification");
  const commit = "a".repeat(40), version = "0.41.0", name = "@openlup/core";
  const tag = "openlup-core-v0.41.0", integrity = "sha512-" + Buffer.alloc(64).toString("base64");
  const signer = `URI:https://github.com/openlup/openlup/.github/workflows/publish-packages.yml@refs/tags/${tag}`;
  const statement = () => ({ predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/%40openlup/core@0.41.0", digest: { sha512: "00".repeat(64) } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/openlup/openlup", ref: `refs/tags/${tag}`, path: ".github/workflows/publish-packages.yml" } },
      resolvedDependencies: [{ uri: `git+https://github.com/openlup/openlup@refs/tags/${tag}`, digest: { gitCommit: commit } }] } } });

  it("shares the trust gates, refuses absent visibility, authenticates mirror-only pulls and retains one receipt for 90 days", () => {
    expect(qualification).toContain("needs: registry-tutorial");
    expect(qualification).toContain(REGISTRY_GATE.replace("if: ${{ ", "if: ${{ always() && (").replace(" }}", ") }}"));
    expect(permissionBlocks(qualification)).toEqual(["    permissions:\n      contents: read\n      packages: read\n"]);
    expect(qualification).toContain('if [ "$OPENLUP_REGISTRY_READY" != true ]; then');
    expect(qualification).toContain('image.sources = image.sources.slice(0, 1)');
    expect(qualification.indexOf('docker login ghcr.io')).toBeLessThan(qualification.indexOf('pullWithRetry(image)'));
    expect(qualification).toContain('docker run --pull=never');
    expect(qualification).toContain('retention-days: 90');
    expect(step(qualification, "Qualify the exact published set")).toContain("timeout-minutes: 2");
    expect(qualification).not.toMatch(/secrets\.|continue-on-error|sleep|while|npm publish|release upload/);
    expect(step(qualification, "Retain the qualification receipt")).toContain('if: always()');
  });

  it("records a failed-by-default receipt and refuses malformed released inputs", () => {
    const receipt = qualificationReceipt(tag, commit, { image: "fixture" });
    expect(receipt).toMatchObject({ schemaVersion: 1, setVersion: version, tag, tagCommit: commit, result: "FAIL", packages: [], checks: [], extraction: null, endedAt: null, runnerImage: { image: "fixture" } });
    expect(Number.isFinite(Date.parse(receipt.startedAt))).toBe(true);
    for (const invalid of ["main", "openlup-core-v01.41.0", tag + "-preview.1", tag + "\n"]) expect(() => qualificationReceipt(invalid, commit, {})).toThrow("invalid core release tag");
    expect(() => qualificationReceipt(tag, "short", {})).toThrow("full SHA");
  });

  it.each([
    ["image=", undefined, "failure"], ["container=", undefined, "failure"],
    ["", undefined, "skipped"], ["", undefined, "success"], ["", "FAIL", "success"], ["", "PASS", "failure"],
    ["", "PASS", "cancelled"], ["", "PASS", "success"],
  ])("seals schema setup %s / result %s / outcome %s without retaining an earlier PASS", async (stop, result, outcome) => {
    const directory = mkdtempSync(join(tmpdir(), "qualification-schema-")), path = join(directory, "exact-set-qualification.json");
    const env = { ...Reflect.get(process, "env"), RUNNER_TEMP: directory, SCHEMA_OUTCOME: outcome };
    const schema = step(qualification, "Qualify released-pair schema compatibility and code rollback");
    const seal = step(qualification, "Seal an incomplete qualification receipt");
    try {
      writeFileSync(path, JSON.stringify({ ...qualificationReceipt(tag, commit), result: "PASS", endedAt: new Date(0).toISOString(), upgrade: { result: "PASS" }, ...(result ? { schemaUpgrade: { result } } : {}) }));
      expect(schema).toContain("id: schema"); expect(seal).toContain("SCHEMA_OUTCOME: ${{ steps.schema.outcome }}");
      if (stop) {
        const prefix = script(schema).split(stop)[0]!.replace(/^image=.*$/mu, "image=fixture");
        expect(spawnSync("bash", ["-e", "-c", prefix + "\nexit 23"], { cwd: ROOT, env }).status).toBe(23);
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ result: "FAIL", endedAt: null, schemaUpgrade: { result: "FAIL", startedAt: expect.any(String) } });
        if (stop === "image=") {
          vi.stubEnv("OPENLUP_QUALIFICATION_DATABASE_URL", undefined);
          try { await expect(qualifyReleasedSet(tag, commit, path, false, true)).rejects.toThrow("qualification PostgreSQL connection required"); }
          finally { vi.unstubAllEnvs(); }
        }
      }
      const sealed = spawnSync("bash", ["-e", "-c", seal.split("        run: ")[1]!], { cwd: ROOT, env, encoding: "utf8" });
      expect(sealed.status, sealed.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      expect(receipt.result).toBe(result === "PASS" && outcome === "success" ? "PASS" : "FAIL");
      expect(receipt.endedAt).toBeTruthy();
      if (receipt.schemaUpgrade) expect(receipt.schemaUpgrade.result).toBe(receipt.result);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses invisible sets before any command and retains the failed receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "qualification-receipt-")), path = join(directory, "receipt.json");
    vi.stubEnv("OPENLUP_REGISTRY_READY", "false");
    try {
      expect(() => qualifyReleasedSet(tag, commit, path)).toThrow("published set not visible on npm");
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      expect(receipt).toMatchObject({ result: "FAIL", checks: [], packages: [], tag, tagCommit: commit });
      expect(Date.parse(receipt.endedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("extracts a candidate from an existing working directory before requiring package tarballs", () => {
    const checkout = mkdtempSync(join(tmpdir(), "qualification-candidate-")), starter = join(checkout, "examples/neutral-store");
    try {
      mkdirSync(join(starter, "test"), { recursive: true });
      writeFileSync(join(starter, "ownership.json"), JSON.stringify({ owned: [], managed: [] }));
      writeFileSync(join(starter, "test/source.test.mjs"), 'import { test } from "node:test"; test("source fixture", () => {});');
      writeFileSync(join(starter, "extract.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { argv } from "node:process";
const target = argv[2]; mkdirSync(target); writeFileSync(target + "/package.json", "{}");
execFileSync("git", ["init", "--quiet", target]);`);
      expect(() => proveNeutralStarterConsumer(checkout, new Map())).toThrow("Candidate starter needs locked dependency tarballs");
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  });

  it("refuses a changed released lock or unknown input mode before installing or executing the application", () => {
    const application = realpathSync(mkdtempSync(join(tmpdir(), "qualification-lock-"))), run = vi.fn((_name: string, _args: string[], _cwd: string) => application), verifyInstalled = vi.fn();
    try {
      writeFileSync(join(application, "package.json"), "{}");
      writeFileSync(join(application, "package-lock.json"), "{}");
      const input = { mode: "released", application, environment: {}, run, verifyInstalled, packages: [name], lockfileSha256: "unverified" };
      expect(() => proveNeutralStarterConsumer(ROOT, input)).toThrow("lock changed before installation");
      expect(run.mock.calls.every(call => call[0] !== "npm")).toBe(true);
      expect(() => proveNeutralStarterConsumer(ROOT, { ...input, mode: "unknown" })).toThrow("Unknown starter consumer input mode");
      expect(verifyInstalled).not.toHaveBeenCalled();
    } finally { rmSync(application, { recursive: true, force: true }); }
  });

  it("parses successful npm audit bundles with each publishable package's own certificate and tag", () => {
    const directory = mkdtempSync(join(tmpdir(), "qualification-certificates-"));
    try {
      const packages = JSON.parse(readFileSync(join(ROOT, "config/openlup-packages.json"), "utf8")).packages.filter((entry: { publish: boolean }) => entry.publish);
      const verified = packages.map(({ name }: { name: string }, index: number) => {
        const packageTag = `openlup-${name.slice(9)}-v${version}`, identity = signer.replace(tag, packageTag);
        // Synthetic self-signed certificates exercise parsing/identity; npm owns cryptographic verification.
        const certificate = execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "key.pem"), "-subj", "/CN=fixture", "-addext", `subjectAltName=${identity}`, "-outform", "DER"], { stdio: ["ignore", "pipe", "ignore"] }).toString("base64");
        const payload = JSON.stringify(statement()).replaceAll("openlup-core-v", `openlup-${name.slice(9)}-v`).replaceAll("%40openlup/core@", `%40openlup/${name.slice(9)}@`);
        return { name, version, attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { verificationMaterial: index % 2 ? { x509CertificateChain: { certificates: [{ rawBytes: certificate }] } } : { certificate: { rawBytes: certificate } }, dsseEnvelope: { payload: Buffer.from(payload).toString("base64") } } }] };
      });
      const audit = JSON.parse(JSON.stringify({ invalid: [], missing: [], verified }));
      expect(verifiedReleasePackages(audit, packages.map(({ name }: { name: string }) => ({ name, integrity })), version, commit)).toEqual(packages.map(({ name }: { name: string }) => ({ name, version, integrity, verificationSource: "npm audit signatures --json --include-attestations", provenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })));
      audit.verified[1].attestationBundles[0].bundle.verificationMaterial = audit.verified[0].attestationBundles[0].bundle.verificationMaterial;
      expect(() => verifiedReleasePackages(audit, packages.map(({ name }: { name: string }) => ({ name, integrity })), version, commit)).toThrow("signer mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts only the exact release subject, signer, repository, workflow, tag and commit", () => {
    expect(() => assertReleaseProvenance(statement(), signer, name, integrity, version, commit)).not.toThrow();
    for (const mutate of [
      (s: ReturnType<typeof statement>) => { s.subject[0]!.digest.sha512 = "ff".repeat(64); },
      (s: ReturnType<typeof statement>) => { s.subject[0]!.name = "pkg:npm/other@0.41.0"; },
      (s: ReturnType<typeof statement>) => { s.predicate.buildDefinition.externalParameters.workflow.repository += "-fork"; },
      (s: ReturnType<typeof statement>) => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; },
      (s: ReturnType<typeof statement>) => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; },
      (s: ReturnType<typeof statement>) => { s.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "b".repeat(40); },
    ]) { const next = statement(); mutate(next); expect(() => assertReleaseProvenance(next, signer, name, integrity, version, commit)).toThrow(name + "@" + version); }
    expect(() => assertReleaseProvenance(statement(), signer.replace("openlup/openlup", "other/fork"), name, integrity, version, commit)).toThrow("signer mismatch");
    for (const audit of [{ invalid: [], missing: [], verified: [] }, { invalid: [], missing: [], verified: [{ name, version, attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1" }] }] }, { invalid: [{ name }], missing: [] }, { invalid: [], missing: [{ name }] }]) {
      expect(() => verifiedReleasePackages(audit, [{ name, integrity }], version, commit)).toThrow(name);
    }
  });
});

describe("qualified image publication", () => {
  const publish = job(workflow, "publish-qualified-image"), body = script(step(publish, "Verify and publish the qualified archive"));
  it("isolates writes from candidate execution and defaults dispatch to verification only", () => {
    expect(publish).toContain("needs: exact-set-qualification");
    expect(publish).toContain("if: ${{ needs.exact-set-qualification.result == 'success' }}");
    expect(permissionBlocks(publish)).toEqual(["    permissions: {packages: write}\n"]);
    expect(publish).not.toMatch(/checkout@|setup-node@|npm |id-token|attestations|timeout|sleep|retry/u);
    expect(workflow).toContain("type: boolean\n        default: false");
    expect(publish).toContain("github.event_name == 'workflow_run' || inputs.publish_image == true");
    expect(body).toContain('skopeo copy --preserve-digests');
  });
  it.each(["FROM node:latest\n", "FROM node:24.21.0-bookworm-slim AS application\nFROM alpine:latest\n"])("refuses unqualified bases before building", dockerfile => {
    const application = mkdtempSync(join(tmpdir(), "qualified-base-"));
    try { writeFileSync(join(application, "Dockerfile"), dockerfile); expect(() => buildQualifiedImage(application, "unused", "unused")).toThrow("qualified_image_base_unexpected"); }
    finally { rmSync(application, { recursive: true, force: true }); }
  });
  it.each(["published", "existing", "skipped-dispatch", "archive-mismatch", "tag-move", "readback-mismatch", "denied", "bom-mismatch"])("checks archive, immutable tag and registry equality: %s", mode => {
    const directory = mkdtempSync(join(tmpdir(), "qualified-image-")), input = join(directory, "qualified-image"); mkdirSync(input);
    const manifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}', digest = "sha256:" + createHash("sha256").update(manifest).digest("hex");
    const bom = JSON.stringify({ formatVersion: 3, kind: "openlup-exact-set-bom", setVersion: "0.41.0", image: { name: "ghcr.io/openlup/neutral-store-starter", platform: "linux/amd64", manifestDigest: digest } });
    writeFileSync(join(input, "exact-set-qualification.json.bom.json"), bom);
    writeFileSync(join(input, "exact-set-qualification.json"), JSON.stringify({ result: "PASS", image: { manifestDigest: digest }, bom: { sha256: mode === "bom-mismatch" ? "wrong" : createHash("sha256").update(bom).digest("hex") } }));
    writeFileSync(join(directory, "skopeo"), `#!/bin/bash
case "$1" in
  login) cat >/dev/null;;
  copy) touch "$RUNNER_TEMP/pushed";;
  inspect)
    if [[ "$3" == oci-archive:* ]]; then printf '%s' "$ARCHIVE_MANIFEST";
    elif [ -f "$RUNNER_TEMP/pushed" ]; then printf '%s' "$READBACK_MANIFEST";
    elif [ "$MODE" = denied ]; then echo unauthorized >&2; exit 1;
    elif [[ "$MODE" == existing || "$MODE" == tag-move ]]; then printf '%s' "$REGISTRY_MANIFEST";
    else echo 'manifest unknown' >&2; exit 1; fi;;
esac
`); chmodSync(join(directory, "skopeo"), 0o700);
    try {
      const env = { ...Reflect.get(process, "env"), PATH: directory + ":" + Reflect.get(process, "env").PATH, RUNNER_TEMP: directory, RELEASE_TAG: "openlup-core-v0.41.0", PUBLISH_IMAGE: String(mode !== "skipped-dispatch"), GHCR_TOKEN: "synthetic", GHCR_ACTOR: "fixture", MODE: mode,
        ARCHIVE_MANIFEST: mode === "archive-mismatch" ? "altered" : manifest, READBACK_MANIFEST: mode === "readback-mismatch" ? "altered" : manifest, REGISTRY_MANIFEST: mode === "tag-move" ? "altered" : manifest };
      const run = spawnSync("bash", ["-e", "-o", "pipefail", "-c", body], { env, encoding: "utf8" });
      const success = ["published", "existing", "skipped-dispatch"].includes(mode), receipt = JSON.parse(readFileSync(join(input, "exact-set-qualification.json"), "utf8"));
      expect(run.status, run.stderr).toBe(success ? 0 : 1);
      expect(receipt.image.publishResult).toBe(success ? mode === "skipped-dispatch" ? mode : "published" : "refused");
      expect(receipt.result).toBe(success ? "PASS" : "FAIL");
      expect(existsSync(join(directory, "pushed"))).toBe(["published", "existing", "readback-mismatch"].includes(mode));
      if (success && mode !== "skipped-dispatch") expect(receipt.image.registryReadback).toBe(digest);
      if (mode === "tag-move") expect(run.stdout).toContain("qualified_image_tag_move_refused");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
