#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { fileURLToPath } from "node:url";
import { pinnedDurationMs } from "./ci-vitest-duration-keys.ts";
import {
  DEFAULT_QUARANTINE_PATH,
  loadCiQuarantine,
  splitQuarantinedFiles,
} from "./ci-quarantine.mjs";
import { isHostedCi, reportFlakyRetries } from "./ci-flaky-retry.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WEIGHTS_PATH = "config/vitest-shard-weights.json";
export const DEFAULT_POSTGRES_DURATION_MS = 45_000;
export const SHARD_PLAN_SCHEMA_VERSION = 1;
export { DEFAULT_QUARANTINE_PATH };
const DEFAULT_QUARANTINE_RETRY = 2;
// More failed files than this in one run is not a transient runner slowdown.
export const MAX_FLAKY_RETRY_FILES = 10;

export function fallbackDurationMs(filePath, defaultDurationMs) {
  return filePath.startsWith("tests/postgres/")
    ? Math.max(defaultDurationMs, DEFAULT_POSTGRES_DURATION_MS)
    : defaultDurationMs;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(rootDir, filePath) {
  const rel = relative(rootDir, resolve(rootDir, filePath)).split("\\").join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Test file escapes repository root: ${filePath}`);
  }
  return rel;
}

export function loadShardWeights(weightsPath = DEFAULT_WEIGHTS_PATH, rootDir = REPOSITORY_ROOT) {
  const absolutePath = resolve(rootDir, weightsPath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid shard weights manifest at ${weightsPath}: expected JSON object`);
  }
  const { defaultDurationMs, durationsMs } = parsed;
  if (typeof defaultDurationMs !== "number" || !Number.isFinite(defaultDurationMs) || defaultDurationMs <= 0) {
    throw new Error(`Invalid shard weights manifest at ${weightsPath}: defaultDurationMs must be a positive number`);
  }
  if (!durationsMs || typeof durationsMs !== "object" || Array.isArray(durationsMs)) {
    throw new Error(`Invalid shard weights manifest at ${weightsPath}: durationsMs must be an object`);
  }
  return {
    defaultDurationMs,
    durationsMs,
  };
}

/**
 * Deterministically partitions `files` into `totalShards` bins using Longest
 * Processing Time first (LPT) bin-packing with code-unit lexicographical
 * tie-breaking.
 */
export function partitionShards(files, totalShards, manifest) {
  if (!Number.isInteger(totalShards) || totalShards < 1) {
    throw new Error(`totalShards must be a positive integer, received: ${String(totalShards)}`);
  }
  const uniqueFiles = [...new Set(files)].sort(compareCodeUnits);
  const weighted = uniqueFiles.map((file) => ({
    file,
    weightMs: pinnedDurationMs(manifest.durationsMs, file) ?? fallbackDurationMs(file, manifest.defaultDurationMs),
  }));
  weighted.sort((left, right) => (right.weightMs - left.weightMs) || compareCodeUnits(left.file, right.file));

  const shards = Array.from({ length: totalShards }, (_, index) => ({
    shard: index + 1,
    estimatedDurationMs: 0,
    files: [],
  }));

  for (const item of weighted) {
    let target = shards[0];
    for (let index = 1; index < shards.length; index += 1) {
      if (shards[index].estimatedDurationMs < target.estimatedDurationMs) {
        target = shards[index];
      }
    }
    target.estimatedDurationMs += item.weightMs;
    target.files.push(item.file);
  }

  for (const shard of shards) {
    shard.files.sort(compareCodeUnits);
  }
  return shards;
}

export function listVitestFiles(rootDir = REPOSITORY_ROOT, env = processEnvironment) {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const output = execFileSync(npxCommand, ["--no", "--", "vitest", "list", "--filesOnly", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...env,
      VITEST_SKIP_INSTALL_CHECKS: env.VITEST_SKIP_INSTALL_CHECKS ?? "1",
    },
  });
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("vitest list --filesOnly --json did not return a JSON array");
  }
  const files = parsed.map((entry) => {
    if (!entry || typeof entry.file !== "string") {
      throw new Error("vitest list --filesOnly --json returned an entry without a file path");
    }
    return normalizeRelativePath(rootDir, entry.file);
  });
  return [...new Set(files)].sort(compareCodeUnits);
}

export function digestFileContents(absolutePath) {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

export function resolveExcludeDigest(env = processEnvironment, rootDir = REPOSITORY_ROOT) {
  const excludeFile = env.OPENLUP_VITEST_EXCLUDE_FILE?.trim();
  if (!excludeFile) {
    return "none";
  }
  return digestFileContents(resolve(rootDir, excludeFile));
}

export function buildShardPlan(files, totalShards, manifest, { weightsDigest, excludeDigest }) {
  if (typeof weightsDigest !== "string" || !weightsDigest) {
    throw new Error("buildShardPlan requires a non-empty weightsDigest");
  }
  if (typeof excludeDigest !== "string" || !excludeDigest) {
    throw new Error("buildShardPlan requires a non-empty excludeDigest");
  }
  const shards = partitionShards(files, totalShards, manifest);
  if (shards.every((entry) => entry.files.length === 0)) {
    throw new Error("buildShardPlan requires at least one test file");
  }
  return {
    schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
    totalShards,
    weightsDigest,
    excludeDigest,
    shards,
  };
}

export function writeShardPlan(planOutPath, plan, rootDir = REPOSITORY_ROOT) {
  const absolutePath = resolve(rootDir, planOutPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export function loadShardPlan(
  planPath,
  expectedTotalShards,
  { rootDir = REPOSITORY_ROOT, weightsPath = DEFAULT_WEIGHTS_PATH, env = processEnvironment } = {},
) {
  if (!Number.isInteger(expectedTotalShards) || expectedTotalShards < 1) {
    throw new Error(`expectedTotalShards must be a positive integer, received: ${String(expectedTotalShards)}`);
  }
  const absolutePath = resolve(rootDir, planPath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid shard plan at ${planPath}: expected JSON object`);
  }
  if (parsed.schemaVersion !== SHARD_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `Invalid shard plan at ${planPath}: unsupported schemaVersion ${String(parsed.schemaVersion)} (expected ${SHARD_PLAN_SCHEMA_VERSION})`,
    );
  }
  if (parsed.totalShards !== expectedTotalShards) {
    throw new Error(
      `Shard plan at ${planPath} was built for ${String(parsed.totalShards)} shards, expected ${expectedTotalShards}`,
    );
  }
  const expectedWeightsDigest = digestFileContents(resolve(rootDir, weightsPath));
  if (parsed.weightsDigest !== expectedWeightsDigest) {
    throw new Error(`Shard plan at ${planPath} weightsDigest does not match ${weightsPath}`);
  }
  const expectedExcludeDigest = resolveExcludeDigest(env, rootDir);
  if (parsed.excludeDigest !== expectedExcludeDigest) {
    throw new Error(`Shard plan at ${planPath} excludeDigest does not match current OPENLUP_VITEST_EXCLUDE_FILE`);
  }
  if (!Array.isArray(parsed.shards) || parsed.shards.length !== expectedTotalShards) {
    throw new Error(`Invalid shard plan at ${planPath}: expected ${expectedTotalShards} shard entries`);
  }

  const seen = new Set();
  const normalizedShards = [];
  for (let index = 0; index < parsed.shards.length; index += 1) {
    const entry = parsed.shards[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid shard plan at ${planPath}: shard entry ${index + 1} must be an object`);
    }
    if (entry.shard !== index + 1) {
      throw new Error(`Invalid shard plan at ${planPath}: expected shard ${index + 1}, received ${String(entry.shard)}`);
    }
    if (
      typeof entry.estimatedDurationMs !== "number"
      || !Number.isFinite(entry.estimatedDurationMs)
      || entry.estimatedDurationMs < 0
    ) {
      throw new Error(`Invalid shard plan at ${planPath}: shard ${index + 1} has invalid estimatedDurationMs`);
    }
    if (!Array.isArray(entry.files)) {
      throw new Error(`Invalid shard plan at ${planPath}: shard ${index + 1} files must be an array`);
    }
    const files = [];
    for (const file of entry.files) {
      if (typeof file !== "string" || !file) {
        throw new Error(`Invalid shard plan at ${planPath}: shard ${index + 1} contains non-string file entry`);
      }
      const normalized = normalizeRelativePath(rootDir, file);
      if (normalized !== file) {
        throw new Error(`Invalid shard plan at ${planPath}: non-canonical test path ${file}`);
      }
      if (seen.has(normalized)) {
        throw new Error(`Invalid shard plan at ${planPath}: duplicate test path ${normalized}`);
      }
      seen.add(normalized);
      files.push(normalized);
    }
    normalizedShards.push({
      shard: entry.shard,
      estimatedDurationMs: entry.estimatedDurationMs,
      files,
    });
  }

  if (seen.size === 0) {
    throw new Error(`Invalid shard plan at ${planPath}: plan contains 0 test files`);
  }
  return normalizedShards;
}

export function parseShardArgs(argv) {
  let shard;
  let total;
  let weightsPath = DEFAULT_WEIGHTS_PATH;
  let quarantinePath = DEFAULT_QUARANTINE_PATH;
  let planPath = null;
  let planOutPath = null;
  let printFiles = false;
  let skipPretest = false;
  const extraArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      extraArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--shard") {
      shard = Number(argv[++index]);
    } else if (arg.startsWith("--shard=")) {
      shard = Number(arg.slice("--shard=".length));
    } else if (arg === "--total") {
      total = Number(argv[++index]);
    } else if (arg.startsWith("--total=")) {
      total = Number(arg.slice("--total=".length));
    } else if (arg === "--weights") {
      weightsPath = argv[++index] ?? "";
    } else if (arg.startsWith("--weights=")) {
      weightsPath = arg.slice("--weights=".length);
    } else if (arg === "--quarantine") {
      quarantinePath = argv[++index] ?? "";
    } else if (arg.startsWith("--quarantine=")) {
      quarantinePath = arg.slice("--quarantine=".length);
    } else if (arg === "--plan") {
      planPath = argv[++index] ?? "";
    } else if (arg.startsWith("--plan=")) {
      planPath = arg.slice("--plan=".length);
    } else if (arg === "--plan-out") {
      planOutPath = argv[++index] ?? "";
    } else if (arg.startsWith("--plan-out=")) {
      planOutPath = arg.slice("--plan-out=".length);
    } else if (arg === "--print-files") {
      printFiles = true;
    } else if (arg === "--skip-pretest") {
      skipPretest = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(total) || total < 1) {
    throw new Error(
      "Usage: node scripts/ci-vitest-shard.mjs (--shard <1..N> --total <N> [--plan <path>] | --total <N> --plan-out <path>) [--weights <path>] [--quarantine <path>] [--print-files] [--skip-pretest] [-- <vitest-args...>]",
    );
  }
  if (planPath === "") {
    throw new Error("--plan requires a non-empty file path");
  }
  if (planOutPath === "") {
    throw new Error("--plan-out requires a non-empty file path");
  }
  if (planPath !== null && planOutPath !== null) {
    throw new Error("--plan and --plan-out are mutually exclusive");
  }
  if (planOutPath !== null) {
    if (shard !== undefined) {
      throw new Error("--plan-out cannot be combined with --shard");
    }
    if (printFiles || skipPretest || extraArgs.length > 0) {
      throw new Error("--plan-out cannot be combined with --print-files, --skip-pretest, or extra vitest arguments");
    }
  } else if (!Number.isInteger(shard) || shard < 1 || shard > total) {
    throw new Error(`--shard must be an integer between 1 and ${total}, received: ${String(shard)}`);
  }
  if (!weightsPath) {
    throw new Error("--weights requires a non-empty file path");
  }
  if (!quarantinePath) {
    throw new Error("--quarantine requires a non-empty file path");
  }

  return { shard, total, weightsPath, quarantinePath, planPath, planOutPath, printFiles, skipPretest, extraArgs };
}

export function hasRetryArg(extraArgs = []) {
  return extraArgs.some((arg) => arg === "--retry" || arg.startsWith("--retry="));
}

export function buildQuarantineRetryArgs(extraArgs = [], retryCount = DEFAULT_QUARANTINE_RETRY) {
  if (hasRetryArg(extraArgs)) {
    return [...extraArgs];
  }
  return [...extraArgs, `--retry=${retryCount}`];
}

export function formatQuarantineBanner(quarantinedEntries) {
  const lines = [
    `[ci-quarantine] Running ${quarantinedEntries.length} quarantined test file(s) with retry isolation:`,
  ];
  for (const entry of quarantinedEntries) {
    lines.push(
      `[ci-quarantine]   - ${entry.testPath} (owner=${entry.owner}, trackingRef=${entry.trackingRef}, expiresAt=${entry.expiresAt})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildShardCommand(files, { skipPretest = false, extraArgs = [], platform = process.platform, execPath = process.execPath } = {}) {
  if (skipPretest) {
    return {
      command: execPath,
      args: ["scripts/run-vitest.mjs", "run", ...files, ...extraArgs],
    };
  }
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  return {
    command: npmCommand,
    args: ["test", "--", ...files, ...extraArgs],
  };
}

export function buildShardExecutionPlan(
  selectedFiles,
  quarantineManifest,
  { skipPretest = false, extraArgs = [], platform = process.platform, execPath = process.execPath } = {},
) {
  const { normalFiles, quarantinedEntries } = splitQuarantinedFiles(selectedFiles, quarantineManifest);
  if (quarantinedEntries.length === 0) {
    return {
      quarantinedEntries: [],
      invocations: [
        {
          kind: "normal",
          files: selectedFiles,
          ...buildShardCommand(selectedFiles, { skipPretest, extraArgs, platform, execPath }),
        },
      ],
    };
  }

  const invocations = [];
  if (normalFiles.length > 0) {
    invocations.push({
      kind: "normal",
      files: normalFiles,
      ...buildShardCommand(normalFiles, { skipPretest, extraArgs, platform, execPath }),
    });
  }
  const quarantinedFiles = quarantinedEntries.map((entry) => entry.testPath);
  invocations.push({
    kind: "quarantined",
    files: quarantinedFiles,
    ...buildShardCommand(quarantinedFiles, {
      skipPretest,
      extraArgs: buildQuarantineRetryArgs(extraArgs, DEFAULT_QUARANTINE_RETRY),
      platform,
      execPath,
    }),
  });

  return {
    quarantinedEntries,
    invocations,
  };
}

/**
 * Decides the single hosted-CI file retry. `failedFiles` is null when the run left
 * no readable report, so the failure cannot be attributed to files.
 */
export function decideFileRetry(failedFiles, { maxFiles = MAX_FLAKY_RETRY_FILES } = {}) {
  if (failedFiles === null) return { retry: false, files: [], reason: "no readable test report" };
  if (failedFiles.length === 0) return { retry: false, files: [], reason: "no failed test file" };
  if (failedFiles.length > maxFiles) {
    return { retry: false, files: [], reason: `${failedFiles.length} failed test files exceed the retry cap of ${maxFiles}` };
  }
  return { retry: true, files: [...failedFiles], reason: null };
}

/** The shard passes only if the retry exited cleanly and its report shows no failed file. */
export function settleFileRetry(retriedFiles, { status, failedFiles }) {
  return status === 0 && Array.isArray(failedFiles) && failedFiles.length === 0
    ? { pass: true, flaky: [...retriedFiles] }
    : { pass: false, flaky: [] };
}

export function readFailedFiles(reportPath, rootDir = REPOSITORY_ROOT) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.testResults)) return null;
  const failed = [];
  for (const result of report.testResults) {
    if (!result || typeof result.name !== "string") return null;
    if (result.status !== "failed") continue;
    try {
      failed.push(normalizeRelativePath(rootDir, result.name));
    } catch {
      return null;
    }
  }
  return [...new Set(failed)].sort(compareCodeUnits);
}

/** Adds a JSON report next to the reporters the run would otherwise use. */
export function jsonReportArgs(args, reportPath, env = processEnvironment) {
  const explicitReporter = args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));
  const reporters = explicitReporter
    ? []
    : ["--reporter=default", ...(env.GITHUB_ACTIONS === "true" ? ["--reporter=github-actions"] : [])];
  return [...reporters, "--reporter=json", `--outputFile.json=${reportPath}`];
}

export function argsForFiles(invocation, files) {
  const start = invocation.args.indexOf(invocation.files[0]);
  if (start < 0) throw new Error(`Invocation arguments do not contain its files: ${invocation.kind}`);
  return [...invocation.args.slice(0, start), ...files, ...invocation.args.slice(start + invocation.files.length)];
}

function spawnStatus(spawnImpl, command, args, cwd, env) {
  const result = spawnImpl(command, args, { cwd, stdio: "inherit", env });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return null;
  }
  return result.status ?? 1;
}

function runWithFileRetry(invocation, { cwd, env, spawnImpl, reportDir, reportFlaky, log }) {
  const firstReport = join(reportDir, `${invocation.kind}-first.json`);
  const first = spawnStatus(spawnImpl, invocation.command, [...invocation.args, ...jsonReportArgs(invocation.args, firstReport, env)], cwd, env);
  if (first === null || first === 0) return first;
  const decision = decideFileRetry(readFailedFiles(firstReport, cwd));
  if (!decision.retry) {
    log(`[ci-retry] Not retrying: ${decision.reason}.`);
    return first;
  }
  log(`[ci-retry] Retrying ${decision.files.length} failed test file(s) once: ${decision.files.join(", ")}`);
  const retryReport = join(reportDir, `${invocation.kind}-retry.json`);
  const retryArgs = argsForFiles(invocation, decision.files);
  const second = spawnStatus(spawnImpl, invocation.command, [...retryArgs, ...jsonReportArgs(retryArgs, retryReport, env)], cwd, env);
  if (second === null) return null;
  const settled = settleFileRetry(decision.files, { status: second, failedFiles: readFailedFiles(retryReport, cwd) });
  if (settled.pass) {
    reportFlaky(settled.flaky);
    return 0;
  }
  log("[ci-retry] The retry failed too; the shard fails.");
  return second !== 0 ? second : first;
}

export function runShardInvocations(
  invocations,
  {
    cwd = REPOSITORY_ROOT,
    env = processEnvironment,
    spawnImpl = spawnSync,
    retryFailedFiles = false,
    reportFlaky = reportFlakyRetries,
    log = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  const reportDir = retryFailedFiles ? mkdtempSync(join(tmpdir(), "ci-vitest-shard-")) : null;
  try {
    let exitCode = 0;
    for (const invocation of invocations) {
      const status = reportDir
        ? runWithFileRetry(invocation, { cwd, env, spawnImpl, reportDir, reportFlaky, log })
        : spawnStatus(spawnImpl, invocation.command, invocation.args, cwd, env);
      if (status === null) {
        return 1;
      }
      if (status !== 0 && exitCode === 0) {
        exitCode = status;
      }
    }
    return exitCode;
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
}

function withLocalBinOnPath(env, rootDir = REPOSITORY_ROOT) {
  const localBin = resolve(rootDir, "node_modules", ".bin");
  const currentPath = env.PATH ?? "";
  const entries = currentPath ? currentPath.split(delimiter) : [];
  if (entries.includes(localBin)) {
    return env;
  }
  return {
    ...env,
    PATH: currentPath ? `${localBin}${delimiter}${currentPath}` : localBin,
  };
}

function main(argv = process.argv.slice(2)) {
  const { shard, total, weightsPath, quarantinePath, planPath, planOutPath, printFiles, skipPretest, extraArgs } = parseShardArgs(argv);

  if (planOutPath !== null) {
    const manifest = loadShardWeights(weightsPath, REPOSITORY_ROOT);
    const weightsDigest = digestFileContents(resolve(REPOSITORY_ROOT, weightsPath));
    const excludeDigest = resolveExcludeDigest(processEnvironment, REPOSITORY_ROOT);
    const files = listVitestFiles(REPOSITORY_ROOT, processEnvironment);
    const plan = buildShardPlan(files, total, manifest, { weightsDigest, excludeDigest });
    writeShardPlan(planOutPath, plan, REPOSITORY_ROOT);
    process.stderr.write(`Precomputed ${total} Vitest shard(s) across ${files.length} files -> ${planOutPath}\n`);
    return 0;
  }

  const quarantineManifest = loadCiQuarantine(quarantinePath, REPOSITORY_ROOT);
  const shards = planPath !== null
    ? loadShardPlan(planPath, total, {
        rootDir: REPOSITORY_ROOT,
        weightsPath,
        env: processEnvironment,
      })
    : partitionShards(
        listVitestFiles(REPOSITORY_ROOT, processEnvironment),
        total,
        loadShardWeights(weightsPath, REPOSITORY_ROOT),
      );
  const selected = shards[shard - 1];

  if (printFiles) {
    for (const file of selected.files) {
      process.stdout.write(`${file}\n`);
    }
    return 0;
  }

  if (selected.files.length === 0) {
    process.stderr.write(`Weighted Vitest shard ${shard}/${total}: 0 files (nothing to run)\n`);
    return 0;
  }

  const estimatedSeconds = Math.round(selected.estimatedDurationMs / 1000);
  process.stderr.write(
    `Weighted Vitest shard ${shard}/${total}: ${selected.files.length} files (estimated ${estimatedSeconds}s)\n`,
  );

  const plan = buildShardExecutionPlan(selected.files, quarantineManifest, { skipPretest, extraArgs });
  if (plan.quarantinedEntries.length > 0) {
    process.stderr.write(formatQuarantineBanner(plan.quarantinedEntries));
  }

  const env = skipPretest ? withLocalBinOnPath(processEnvironment, REPOSITORY_ROOT) : processEnvironment;
  // Hosted CI reruns failed files once in this job, before the check reports.
  return runShardInvocations(plan.invocations, { cwd: REPOSITORY_ROOT, env, retryFailedFiles: isHostedCi(processEnvironment) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
