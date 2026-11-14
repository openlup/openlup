// The registry tutorial follows publication in its own read-only workflow.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const REGISTRY_GATE = "if: ${{ github.repository == 'openlup/openlup' && github.event.workflow_run.repository.full_name == 'openlup/openlup' && github.event.workflow_run.head_repository.full_name == 'openlup/openlup' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'release' && startsWith(github.event.workflow_run.head_branch, 'openlup-core-v') }}";
const REGISTRY_READY = "        if: steps.registry.outputs.ready == 'true'";
const REGISTRY_CLEANUP = "        if: always() && steps.postgres.outcome != 'skipped'";
const REGISTRY_STEP = "Guide tutorial against the npm registry";
const REGISTRY_WAIT = "Wait for the published set on npm";
const RELEASE_PAGE = "Read the release's tutorial page";

describe("the blocking registry tutorial after publication", () => {
  const tutorial = job(workflow, "registry-tutorial");
  const wait = script(step(tutorial, REGISTRY_WAIT));

  it("runs separately after successful core release publication with only read access and a trusted default-branch checkout", () => {
    const publisher = readFileSync(join(ROOT, ".github/workflows/publish-packages.yml"), "utf8");
    expect(publisher).toContain("name: Publish Packages\n");
    expect(publisher).toContain("on:\n  release:\n    types: [published]\n");
    expect(workflow).toContain("name: Guide tutorial against the npm registry\n");
    expect(triggers(workflow)).toEqual(["workflow_run"]);
    expect(workflow).toContain("  workflow_run:\n    workflows: [Publish Packages]\n    types: [completed]\n");
    expect(workflow).toContain("# workflow_run executes trusted default-branch workflow and runner code.");
    expect(workflow).toContain("concurrency:\n  group: registry-tutorial-${{ github.event.workflow_run.head_branch }}\n  cancel-in-progress: false\n");
    expect(conditions(workflow)).toEqual([`    ${REGISTRY_GATE}`, REGISTRY_READY, REGISTRY_READY, REGISTRY_CLEANUP]);
    expect(permissionBlocks(workflow)).toEqual(["permissions: {}\n", "    permissions:\n      contents: read\n"]);
    expect(workflow).not.toMatch(/secrets\.|github\.token|id-token|environment:|strategy:|needs:|continue-on-error|npm (?:ci|install)\b/u);
    expect([...workflow.split("\njobs:\n")[1]!.matchAll(/^ {2}([a-z][a-z-]*):$/gmu)].map(match => match[1])).toEqual(["registry-tutorial"]);
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
    expect(page).toContain("RELEASE_TAG: ${{ github.event.workflow_run.head_branch }}");
    expect(page).toContain("HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(script(page)).toContain('git fetch --no-tags --depth=1 origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"');
    expect(script(page)).toContain('if [ "$(git rev-list -n 1 "refs/tags/$RELEASE_TAG")" != "$HEAD_SHA" ]; then');
    expect(script(page)).toContain('git show "refs/tags/$RELEASE_TAG:packages/core/docs/guide/start/tutorial.md" > "$RUNNER_TEMP/tutorial.md"');
  });

  function releasePage(matches: boolean) {
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
        cwd: workspace, env: { ...env, RELEASE_TAG: tag, HEAD_SHA: matches ? published : main, RUNNER_TEMP: temporary }, encoding: "utf8", timeout: 5000,
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

  it("refuses a release tag whose commit differs from HEAD_SHA without writing a page", () => {
    const result = releasePage(false);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("::error::Release tag commit does not match the completed publication run");
    expect(result.page).toBeUndefined();
  });

  it("refuses malformed or non-core tags before checkout or any registry request", () => {
    const validation = step(tutorial, "Validate the core release tag");
    expect(validation).toContain("RELEASE_TAG: ${{ github.event.workflow_run.head_branch }}");
    const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
    for (const tag of ["openlup-core-v0.13.1", "openlup-core-v1.0.0", "", "main", "refs/tags/openlup-core-v0.13.1", "openlup-platform-v0.13.1", "openlup-core-v", "openlup-core-v01.13.1", "openlup-core-v0.013.1", "openlup-core-v0.13.01", "openlup-core-v0.13.1-preview.1", "openlup-core-v0.13.1+build", "openlup-core-v0.13.1\necho unexpected"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script(validation)], { env: { ...inherited, RELEASE_TAG: tag }, encoding: "utf8", timeout: 5000 });
      const valid = ["openlup-core-v0.13.1", "openlup-core-v1.0.0"].includes(tag);
      expect(result.status, tag).toBe(valid ? 0 : 1);
      expect(result.stdout, tag).toBe(valid ? "" : "::error::Expected an openlup-core-vMAJOR.MINOR.PATCH release tag\n");
    }
  });

  it("uses the existing PostgreSQL pin, readiness probe and cleanup around the verbatim blocking runner", () => {
    const candidateWorkflow = readFileSync(join(ROOT, ".github/workflows/published-tree-ci.yml"), "utf8");
    const startName = "Start the pinned package-proof PostgreSQL service";
    const start = step(tutorial, startName);
    expect(start).toContain('pullWithRetry(readCiImage("install-proof-postgres"))');
    // The database lifecycle is the candidate's, with public pull fallback because this job has no credentials.
    for (const line of script(step(candidateWorkflow, startName)).split("\n").filter(line => /^(?:container=|echo )/u.test(line))) expect(start).toContain(line);
    const readiness = "for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres -t 1 && exit 0; sleep 1; done; exit 1";
    expect(readFileSync(join(ROOT, "scripts/packages/platform-cold-consumer.ts"), "utf8")).toContain(readiness);
    expect(start).toContain(`docker exec "$container" sh -c '${readiness}'`);
    expect(step(tutorial, "Remove the package-proof PostgreSQL service")).toBe(`${REGISTRY_CLEANUP}\n        run: docker rm -f install-proof-postgres\n`);
    expect(step(tutorial, REGISTRY_STEP)).toBe(`${REGISTRY_READY}\n        timeout-minutes: 4\n        env:\n          OPENLUP_PROOF_SERVICE_PORT: \${{ steps.postgres.outputs.port }}\n        run: node --experimental-strip-types scripts/packages/guide-tutorial.ts --registry --page "$RUNNER_TEMP/tutorial.md" --database-url "postgresql://postgres@127.0.0.1:$OPENLUP_PROOF_SERVICE_PORT/postgres"\n`);
    const advisoryComment = "      # --advisory reports a failed tutorial as a warning and exits 0. Remove it after two green\n      # merge-group runs on main to make the step blocking (documentation programme, decision D4).\n";
    expect(candidateWorkflow).not.toContain(advisoryComment);
    expect(tutorial).not.toContain(advisoryComment);
    expect(tutorial).not.toContain("--advisory");
    expect(workflow).not.toContain("(advisory)");
    expect(tutorial).toContain(`    name: ${REGISTRY_STEP}\n`);
    const candidate = step(candidateWorkflow, "Guide tutorial against the packed candidate");
    expect(candidate).toContain("run: node --experimental-strip-types scripts/packages/guide-tutorial.ts --page");
    expect(candidate).not.toContain("--advisory");
    expect(candidateWorkflow).not.toContain("Guide tutorial against the packed candidate (advisory)");
  });

  function registryWait(answers: Array<{ version?: string; fail?: boolean }>, expire = false) {
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
        cwd: ROOT, env: { ...inherited, PATH: `${bin}:${inherited.PATH}`, RELEASE_TAG: "openlup-core-v0.13.1", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8", timeout: 5000,
      });
      return { ...result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), requests: readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("retries registry errors and stale versions, waiting for the full set and core's latest value", () => {
    expect(step(tutorial, REGISTRY_WAIT)).toContain("RELEASE_TAG: ${{ github.event.workflow_run.head_branch }}");
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

  it("warns and defers without running the tutorial when the bounded propagation wait expires", () => {
    const result = registryWait([], true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("");
    expect(result.stdout).toContain("::warning title=Guide tutorial::");
    expect(result.summary).toContain("Guide tutorial: deferred");
    expect(result.summary).not.toContain("(advisory)");
    expect(result.summary).toContain("0.13.1 was not visible on npm within 10 minutes.");
    expect(result.requests).toEqual([]);
    expect(step(tutorial, "Start the pinned package-proof PostgreSQL service")).toContain(REGISTRY_READY);
    expect(step(tutorial, REGISTRY_STEP)).toContain(REGISTRY_READY);
  });
});

