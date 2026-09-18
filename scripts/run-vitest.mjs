import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { coverageArtifactWaitMs, readCoverageStageBinding, readValidatedCoverageSidecar } from "./coverage-summary-protocol.ts";

// Vitest's optional dependency preflight can try to read parent package.json
// files outside the sandbox even when jsdom is installed locally. Keep the
// skip scoped to test commands and leave package.json scripts cross-platform.
process.env.VITEST_SKIP_INSTALL_CHECKS ??= "1";

const vitestArgs = process.argv.slice(2);
const exactExcludeFile = process.env.OPENLUP_VITEST_EXCLUDE_FILE;
if (exactExcludeFile) {
  // This used to push `--exclude <file>` per line. It excluded nothing. Vitest 4
  // copies only a closed allow-list of CLI options into each entry of
  // `test.projects`, and `exclude` is not on it, so a root-level `--exclude` is
  // dropped for every project. Measured: `vitest run server/domains/catalog`
  // collected 8 files with and without the flag. The exclusion is applied in
  // `vitest.config.ts` instead, which is the only level Vitest honours, and the
  // env var already reaches it through this process's environment.
  //
  // A run pointed at a different config cannot honour the contract - that config
  // never reads the variable. Refuse instead of running the files the caller
  // asked to skip.
  const configIndex = vitestArgs.findIndex((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
  if (configIndex !== -1) {
    const requested = readFileSync(exactExcludeFile, "utf8")
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
    console.error("OPENLUP_VITEST_EXCLUDE_FILE is honoured only by the repository root vitest.config.ts, "
      + `but this run passes ${vitestArgs[configIndex]}. Cannot exclude: ${requested.join(", ") || "(empty list)"}`);
    process.exit(2);
  }
}
const isCoverageRun = vitestArgs.includes("--coverage");
const coverageResource = process.env.OPENLUP_COVERAGE_RESOURCE ?? "openlup:coverage";
const coverageDir = resolve("coverage");
const hasExplicitCoverageDir = Boolean(process.env.VITEST_COVERAGE_DIR);
const tempCoverageDir = isCoverageRun && !hasExplicitCoverageDir
  ? join(tmpdir(), `openlup-coverage-${process.pid}`)
  : null;
const activeCoverageDir = tempCoverageDir ?? resolve(process.env.VITEST_COVERAGE_DIR ?? "coverage");
const activeCoverageSummaryPath = join(activeCoverageDir, "coverage-summary.json");
// The singleflight sidecar is written NEXT TO this marker. A relative marker
// resolves against the repo root, so it drops an untracked file into the working
// tree — and verify's run identity hashes untracked content, so that file reads
// as a mid-run change and supersedes every stage after coverage. Only an
// absolute marker is honoured; anything else disables singleflight, which is a
// supported no-op (both publish and restore return early on an empty marker).
const requestedProofPath = process.env.OPENLUP_COVERAGE_PROOF_PATH ?? "";
const requestedSingleflightMarker = process.env.OPENLUP_COVERAGE_SINGLEFLIGHT_MARKER ?? requestedProofPath;
let coverageSingleflightMarker = "";
let coverageStageBinding = null;
if (isCoverageRun && hasExplicitCoverageDir && isAbsolute(requestedSingleflightMarker)) {
  try {
    coverageStageBinding = readCoverageStageBinding(
      process.env.COVERAGE_STAGE_PROOF_BINDING_PATH ?? "",
      requestedProofPath,
      requestedSingleflightMarker,
    );
    coverageSingleflightMarker = requestedSingleflightMarker;
  } catch (error) {
    console.error(`coverage singleflight disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const expectsCoverageSummary = isCoverageRun && process.env.VITEST_COVERAGE_SHARD !== "1"
  && (Boolean(coverageStageBinding) || process.env.VITEST_COVERAGE_SUMMARY_ONLY === "1");
if (tempCoverageDir) {
  rmSync(tempCoverageDir, { recursive: true, force: true });
}

const env = {
  ...process.env,
  ...(tempCoverageDir ? { VITEST_COVERAGE_DIR: tempCoverageDir } : {}),
};
delete env.AI_RESOURCE_GATE_WAIT_SECONDS_FILE;
// Git injects repo-location vars into hook/wrapper processes. Tests spawn
// `git init`/`git add` in temp dirs; inheriting these points those calls back
// at the developer's real repository (a leaked `git init` once flipped
// core.bare and user identity on the shared repo config — see #1803).
const GIT_INJECTED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];
for (const name of GIT_INJECTED_ENV) delete env[name];

// A coverage-specific cap is an execution-safety limit, while broker CPU tokens
// account for the whole process (Vitest main thread, workers, V8 processing and
// I/O). Never promote those accounting tokens over the explicit worker cap.
if (env.OPENLUP_VITEST_MAX_WORKERS && !env.VITEST_MAX_WORKERS) {
  env.VITEST_MAX_WORKERS = env.OPENLUP_VITEST_MAX_WORKERS;
}

if (isCoverageRun && env.OPENLUP_VITEST_COVERAGE_MAX_WORKERS && !env.VITEST_MAX_WORKERS) {
  env.VITEST_MAX_WORKERS = env.OPENLUP_VITEST_COVERAGE_MAX_WORKERS;
}

if (isCoverageRun && env.AI_RESOURCE_GATE_CPU_TOKENS && !env.VITEST_MAX_WORKERS) {
  env.VITEST_MAX_WORKERS = env.AI_RESOURCE_GATE_CPU_TOKENS;
}

if (!env.VITEST_MAX_WORKERS && process.env.CI !== "true") {
  const cores = Math.max(1, cpus().length);
  const highLoad = loadavg()[0] > cores;
  const dockerHeavyActive = hasActiveLane("docker-heavy");
  if (isCoverageRun) {
    env.VITEST_MAX_WORKERS = highLoad || dockerHeavyActive ? "40%" : "50%";
  }
  else if (highLoad) env.VITEST_MAX_WORKERS = "50%";
}

process.exitCode = await runVitest();

async function runVitest() {
  try {
    if (isCoverageRun) {
      rmSync(activeCoverageSummaryPath, { force: true });
      if (tempCoverageDir) rmSync(join(coverageDir, "coverage-summary.json"), { force: true });
    }
    let result = await runCommand(buildCoverageGateArgs(true));
    if (result.signal) { process.kill(process.pid, result.signal); return 1; }
    if (result.code !== 0) return result.code ?? 1;

    if (coverageStageBinding && !existsSync(activeCoverageSummaryPath)
      && !restoreCoverageSummaryFromSingleflight()) {
      console.error("coverage singleflight artifact unavailable; executing through ordinary broker admission");
      result = await runCommand(buildCoverageGateArgs(false));
      if (result.signal) { process.kill(process.pid, result.signal); return 1; }
      if (result.code !== 0) return result.code ?? 1;
    }
    if (expectsCoverageSummary && !existsSync(activeCoverageSummaryPath)) {
      console.error("coverage execution completed without a fresh coverage-summary.json");
      return 1;
    }

    if (tempCoverageDir && existsSync(tempCoverageDir)) {
      rmSync(coverageDir, { recursive: true, force: true });
      cpSync(tempCoverageDir, coverageDir, { recursive: true });
    }
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    cleanupTempCoverage();
  }
}

function runCommand(gateArgs) {
  return new Promise((complete) => {
    const child = spawn(gateArgs.command, gateArgs.args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    child.on("exit", (code, signal) => complete({ code, signal }));
    child.on("error", (error) => { console.error(error); complete({ code: 1, signal: null }); });
  });
}

function cleanupTempCoverage() {
  if (!tempCoverageDir) return;
  rmSync(tempCoverageDir, { recursive: true, force: true });
}

function buildCoverageGateArgs(useSingleflight) {
  const alreadyInCoverageLane = process.env.AI_RESOURCE_GATE_ACTIVE === "1"
    && (process.env.AI_RESOURCE_GATE_LANE === "coverage"
      || process.env.AI_RESOURCE_GATE_RESOURCE?.startsWith(coverageResource));
  // GitHub Actions already isolates and schedules its matrix jobs. Sharing the
  // host-local developer broker from CI can make unrelated shards contend on a
  // persistent runner and fail with the broker's local rc=75 policy code.
  if (process.env.CI === "true" || !isCoverageRun || alreadyInCoverageLane) {
    return { command: "vitest", args: vitestArgs };
  }

  const args = ["scripts/ai-resource-gate.sh", "run"];
  if (process.env.OPENLUP_VERIFY_STAGE_WAIT_SECONDS_FILE) {
    env.AI_RESOURCE_GATE_WAIT_SECONDS_FILE = process.env.OPENLUP_VERIFY_STAGE_WAIT_SECONDS_FILE;
  }
  if (process.env.OPENLUP_COVERAGE_WAIT === "1") {
    args.push(
      "--wait",
      "--queue-timeout",
      process.env.OPENLUP_RESOURCE_QUEUE_TIMEOUT_SECONDS ?? "1800",
      "--execution-timeout",
      process.env.OPENLUP_COVERAGE_TIMEOUT_SECONDS ?? "900",
    );
  }
  if (useSingleflight && coverageStageBinding) {
    args.push("--skip-if-file", coverageSingleflightMarker);
    args.push("--success-marker", coverageSingleflightMarker);
  }
  args.push(coverageResource, "--", "vitest", ...vitestArgs);
  return { command: "bash", args };
}

function singleflightCoverageSummaryPath() {
  return coverageSingleflightMarker ? `${coverageSingleflightMarker}.coverage-summary.json` : "";
}

function restoreCoverageSummaryFromSingleflight() {
  const sidecar = singleflightCoverageSummaryPath();
  if (!sidecar || !coverageStageBinding) return false;
  const deadline = Date.now() + coverageArtifactWaitMs(process.env.OPENLUP_COVERAGE_ARTIFACT_WAIT_MS);
  let artifact = readValidatedCoverageSidecar(sidecar, process.cwd(), coverageStageBinding);
  while (artifact.status === "missing" && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    artifact = readValidatedCoverageSidecar(sidecar, process.cwd(), coverageStageBinding);
  }
  if (artifact.status !== "valid") {
    if (artifact.status === "invalid") console.error(`coverage singleflight artifact rejected: ${artifact.reason}`);
    return false;
  }
  mkdirSync(activeCoverageDir, { recursive: true });
  const tempPath = `${activeCoverageSummaryPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, artifact.bytes);
  renameSync(tempPath, activeCoverageSummaryPath);
  return true;
}

function hasActiveLane(lane) {
  const lockDir = process.env.AI_RESOURCE_GATE_LOCK_DIR ?? "/tmp/ai-dev-runtime/locks";
  if (!existsSync(lockDir)) return false;
  try {
    return readdirSync(lockDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const metadataPath = join(lockDir, entry.name, "owner.env");
      if (!existsSync(metadataPath)) return false;
      const metadata = readFileSync(metadataPath, "utf8");
      return metadata.includes(`lane=${lane}`) || metadata.includes(`lane='${lane}'`);
    });
  } catch {
    return false;
  }
}
