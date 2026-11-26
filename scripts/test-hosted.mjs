// Runs named root Vitest files the way a hosted `test-full-shard` job runs them:
// through `npm test` (package build, scripts/run-vitest.mjs, vitest.config.ts),
// with CI=true, no coverage, no duration pins and no contributor Git identity.
// See CONTRIBUTING.md#test-scope-and-diagnostics.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { devNull } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";

// GitHub's standard Linux runner for public repositories has 4 vCPUs, and
// Vitest's run-mode default is one worker fewer than the CPU count.
export const HOSTED_VITEST_WORKERS = "3";

// GitHub Actions sets CI=true. scripts/run-vitest.mjs and vitest.config.ts
// compare with the string "true", so CI=1 would keep their local branches.
// GIT_CONFIG_GLOBAL hides the contributor's identity and defaults, and
// user.useConfigOnly stops Git from guessing an identity from the login and host
// name instead: a hosted runner cannot guess one, so a fixture commit without
// explicit identity fails there. GIT_CONFIG_NOSYSTEM hides a local system
// gitconfig the same way. TZ and LANG are the hosted Ubuntu runner's values, and
// local LC_* overrides are removed, so local clock and collation settings do not
// leak in either.
const HOSTED_ENVIRONMENT = {
  CI: "true",
  TZ: "UTC",
  LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
  VITEST_MAX_WORKERS: HOSTED_VITEST_WORKERS,
};

// Hosted shards supply none of these: identity, ad hoc Git config, locale
// overrides, coverage, external duration pins, exact exclusions, local worker
// pins or a stacked review base.
const REMOVED_PREFIXES = ["GIT_AUTHOR_", "GIT_COMMITTER_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", "LC_",
  "VITEST_COVERAGE_", "OPENLUP_COVERAGE_", "OPENLUP_VITEST_COVERAGE_"];
const REMOVED_NAMES = new Set(["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "NODE_V8_COVERAGE",
  "COVERAGE_STAGE_PROOF_BINDING_PATH", "OPENLUP_VITEST_DURATIONS_FILE", "OPENLUP_VITEST_EXCLUDE_FILE",
  "OPENLUP_VITEST_MAX_WORKERS", "OPENLUP_STACK_BASE"]);

const isCoverageArgument = (arg) => arg === "--coverage" || arg.startsWith("--coverage=") || arg.startsWith("--coverage.");

/**
 * The child command for `npm run test:hosted -- <files> [vitest options]`.
 * Files are the arguments that do not start with "-"; pass option values with
 * "=" (for example `--testNamePattern=name`). Without a file the run is
 * refused, so it never starts the whole suite.
 */
export function hostedTestRun(argv, environment) {
  const ignored = argv.filter(isCoverageArgument);
  const args = argv.filter((arg) => !isCoverageArgument(arg));
  const files = args.filter((arg) => !arg.startsWith("-"));
  if (files.length === 0) {
    return { refusal: "test:hosted needs at least one test file: npm run test:hosted -- <files> [vitest options]" };
  }
  const env = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || REMOVED_NAMES.has(name) || REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return { command: "npm", args: ["test", "--", ...args], env: { ...env, ...HOSTED_ENVIRONMENT }, files, ignored };
}

export const HOSTED_POSTGRES_QUEUE_TIMEOUT_SECONDS = 600;
export const HOSTED_POSTGRES_EXECUTION_TIMEOUT_SECONDS = 1800;

const isExecutableFile = (candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const isPostgresTestFile = (file) => /^(?:\.\/)?tests\/postgres(?:\/|$)/u.test(file);

/**
 * Optionally wraps local `tests/postgres/` invocations in `ai-resource-gate`
 * on the `supabase-db` lane without mutating `hostedTestRun()`'s pure contract.
 */
export function resolveHostedPostgresGate(
  run,
  callerEnv = processEnvironment,
  cwd = process.cwd(),
  checkExecutable = isExecutableFile,
) {
  if (callerEnv.CI === "true" || callerEnv.AI_RESOURCE_GATE_ACTIVE === "1" || callerEnv.OPENLUP_DISABLE_RESOURCE_GATE === "1") {
    return null;
  }
  if (!run.files.some(isPostgresTestFile)) return null;
  const broker = (callerEnv.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "ai-resource-gate"))
    .find(checkExecutable);
  if (!broker) return null;
  const suffix = createHash("sha256").update(resolve(cwd)).digest().readBigUInt64BE().toString(10);
  const key = `openlup:postgres:wt${suffix}`;
  return {
    command: broker,
    args: [
      "run",
      "--wait",
      "--lane",
      "supabase-db",
      "--queue-timeout",
      String(HOSTED_POSTGRES_QUEUE_TIMEOUT_SECONDS),
      "--execution-timeout",
      String(HOSTED_POSTGRES_EXECUTION_TIMEOUT_SECONDS),
      key,
      "--",
      run.command,
      ...run.args,
    ],
    key,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = hostedTestRun(process.argv.slice(2), processEnvironment);
  if (run.refusal) {
    console.error(run.refusal);
    process.exit(2);
  }
  if (run.ignored.length > 0) console.error(`test:hosted: ignoring ${run.ignored.join(" ")}; hosted shards run without coverage`);
  console.error(`test:hosted: CI=true, no coverage, no Git identity, ${HOSTED_VITEST_WORKERS} workers, flat test timeout`);
  const gated = resolveHostedPostgresGate(run, processEnvironment, process.cwd());
  const spawnCommand = gated ? gated.command : run.command;
  const spawnArgs = gated ? gated.args : run.args;
  const child = spawn(spawnCommand, spawnArgs, { stdio: "inherit", env: run.env, shell: !gated && process.platform === "win32" });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
