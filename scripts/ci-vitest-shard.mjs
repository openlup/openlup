#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, relative, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { fileURLToPath } from "node:url";
import { pinnedDurationMs } from "./ci-vitest-duration-keys.ts";
import {
  DEFAULT_QUARANTINE_PATH,
  loadCiQuarantine,
  splitQuarantinedFiles,
} from "./ci-quarantine.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WEIGHTS_PATH = "config/vitest-shard-weights.json";
export { DEFAULT_QUARANTINE_PATH };
const DEFAULT_QUARANTINE_RETRY = 2;

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
    weightMs: pinnedDurationMs(manifest.durationsMs, file) ?? manifest.defaultDurationMs,
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

export function parseShardArgs(argv) {
  let shard;
  let total;
  let weightsPath = DEFAULT_WEIGHTS_PATH;
  let quarantinePath = DEFAULT_QUARANTINE_PATH;
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
      "Usage: node scripts/ci-vitest-shard.mjs --shard <1..N> --total <N> [--weights <path>] [--quarantine <path>] [--print-files] [--skip-pretest] [-- <vitest-args...>]",
    );
  }
  if (!Number.isInteger(shard) || shard < 1 || shard > total) {
    throw new Error(`--shard must be an integer between 1 and ${total}, received: ${String(shard)}`);
  }
  if (!weightsPath) {
    throw new Error("--weights requires a non-empty file path");
  }
  if (!quarantinePath) {
    throw new Error("--quarantine requires a non-empty file path");
  }

  return { shard, total, weightsPath, quarantinePath, printFiles, skipPretest, extraArgs };
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

export function runShardInvocations(
  invocations,
  { cwd = REPOSITORY_ROOT, env = processEnvironment, spawnImpl = spawnSync } = {},
) {
  let exitCode = 0;
  for (const invocation of invocations) {
    const result = spawnImpl(invocation.command, invocation.args, {
      cwd,
      stdio: "inherit",
      env,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0 && exitCode === 0) {
      exitCode = status;
    }
  }
  return exitCode;
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
  const { shard, total, weightsPath, quarantinePath, printFiles, skipPretest, extraArgs } = parseShardArgs(argv);
  const manifest = loadShardWeights(weightsPath, REPOSITORY_ROOT);
  const quarantineManifest = loadCiQuarantine(quarantinePath, REPOSITORY_ROOT);
  const files = listVitestFiles(REPOSITORY_ROOT, processEnvironment);
  const shards = partitionShards(files, total, manifest);
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
  return runShardInvocations(plan.invocations, { cwd: REPOSITORY_ROOT, env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
