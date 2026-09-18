import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertReleaseSbomIdentity } from "./release-bundle.ts";

// The registry intermittently answers `npm audit --json` with a document that
// parses but carries no `metadata.vulnerabilities`. One such answer is not a
// verdict, so the check re-asks; a report WITH totals is never retried, which
// is what keeps a real vulnerability count from being retried away.
const AUDIT_ATTEMPTS = 3;
const AUDIT_RETRY_DELAYS_MS = [2000, 4000];
const AUDIT_REPORT_HEAD_CHARACTERS = 400;
// The second shape of the same fault: no answer at all. A retry loop cannot help
// a hang - it never gets control back - so each attempt is bounded, and a killed
// attempt is retried like an empty one. Three fit inside the 15-minute job cap.
const AUDIT_ATTEMPT_TIMEOUT_MS = 120_000;
const AUDIT_TIMED_OUT = `did not answer within ${AUDIT_ATTEMPT_TIMEOUT_MS / 1000} s`;
const AUDIT_NO_TOTALS = "returned no vulnerability totals";

type Manifest = {
  name?: string;
  version?: string;
  exports?: Record<string, Record<string, unknown>>;
};
type Gates = {
  audit: { maximumVulnerabilities: Record<string, number> };
  pack: {
    maxPackedBytes: number;
    maxUnpackedBytes: number;
    maxFiles: number;
    requiredFiles: string[];
  };
};
type LockEntry = { dev?: boolean; name?: string };
type Lock = { packages: Record<string, LockEntry> };
type Sbom = {
  bomFormat?: string;
  metadata?: {
    component?: {
      "bom-ref"?: string;
      name?: string;
      purl?: string;
      version?: string;
    };
  };
  components?: Array<{ name?: string }>;
};
type AuditReport = { metadata?: { vulnerabilities?: Record<string, number> } };
type CommandResult = Pick<
  SpawnSyncReturns<string>,
  "status" | "stdout" | "stderr"
> & {
  error?: Error & { code?: string };
  signal?: NodeJS.Signals | null;
};
type NpmRunner = (
  packageRoot: string,
  args: string[],
  timeoutMs?: number,
) => CommandResult;
type PackReport = {
  size: number;
  unpackedSize: number;
  entryCount: number;
  files?: Array<{ path: string }>;
};

export function createNpmReleaseChecks(input: {
  packageRoot: string;
  manifest: Manifest;
  gates: Gates;
  lock: Lock;
  run?: NpmRunner;
  sleep?: (milliseconds: number) => void;
}): { sbom: () => void; audit: () => void; pack: () => void } {
  const { packageRoot, manifest, gates, lock } = input;
  const run = input.run ?? runNpm;
  const sleep = input.sleep ?? sleepSync;
  // Both retryable shapes log and back off identically; only the reason differs.
  const retryAudit = (attempt: number, reason: string): void => {
    const retrying = attempt < AUDIT_ATTEMPTS;
    console.log(
      `npm audit ${reason} (attempt ${attempt} of ${AUDIT_ATTEMPTS})${retrying ? "; retrying" : ""}`,
    );
    if (retrying) sleep(AUDIT_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  };

  return {
    sbom: () => {
      const result = run(packageRoot, [
        "sbom",
        "--omit=dev",
        "--package-lock-only",
        "--sbom-format=cyclonedx",
        "--sbom-type=library",
        "--workspaces=false",
      ]);
      assert(result.status === 0, `npm sbom failed:\n${result.stderr}`);
      const sbom = parseCommandJson<Sbom>(result, "npm sbom");
      assert(manifest.name, "package manifest must declare a name");
      assert(manifest.version, "package manifest must declare a version");
      assertReleaseSbomIdentity(
        sbom,
        { name: manifest.name, version: manifest.version },
        basename(packageRoot),
      );
      const componentNames = new Set(
        (sbom.components ?? []).map((component) => component.name),
      );
      for (const [path, entry] of productionLockEntries(lock)) {
        if (path === "") continue;
        const name = lockPackageName(path, entry);
        assert(
          componentNames.has(name),
          `SBOM omitted production dependency ${name}`,
        );
      }
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (path !== "" && entry.dev === true) {
          const name = lockPackageName(path, entry);
          assert(
            !componentNames.has(name),
            `SBOM included dev-only dependency ${name}`,
          );
        }
      }
      console.log(
        `production CycloneDX SBOM ok (${componentNames.size} components)`,
      );
    },
    audit: () => {
      const auditArgs = [
        "audit",
        "--omit=dev",
        "--package-lock-only",
        "--json",
        "--workspaces=false",
      ];
      let lastReport = "";
      let lastAttemptTimedOut = false;
      for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
        const result = run(packageRoot, auditArgs, AUDIT_ATTEMPT_TIMEOUT_MS);
        // `spawnSync` reports a timeout as ETIMEDOUT and its own kill as a
        // signal. Checked before parsing, because a killed child's empty stdout
        // would otherwise be reported as "no JSON output" - the wrong fault.
        lastAttemptTimedOut =
          result.error?.code === "ETIMEDOUT" || Boolean(result.signal);
        if (lastAttemptTimedOut) {
          retryAudit(attempt, AUDIT_TIMED_OUT);
          continue;
        }
        lastReport = result.stdout ?? "";
        const report = parseCommandJson<AuditReport>(result, "npm audit");
        const actual = report.metadata?.vulnerabilities;
        if (!actual) {
          retryAudit(attempt, AUDIT_NO_TOTALS);
          continue;
        }
        const violations = [];
        for (const [severity, maximum] of Object.entries(
          gates.audit.maximumVulnerabilities,
        )) {
          const count = actual[severity] ?? 0;
          if (count > maximum)
            violations.push(`${severity}: ${count} > ${maximum}`);
        }
        assert(
          violations.length === 0,
          `production audit budget exceeded:\n${violations.join("\n")}`,
        );
        console.log("production dependency audit ok");
        return;
      }
      // The empty-report wording is #3455's, kept verbatim.
      if (lastAttemptTimedOut)
        throw new Error(
          `npm audit ${AUDIT_TIMED_OUT} on the last of ${AUDIT_ATTEMPTS} attempts`,
        );
      throw new Error(
        `npm audit report is missing vulnerability totals after ${AUDIT_ATTEMPTS} attempts; first ${AUDIT_REPORT_HEAD_CHARACTERS} characters of the last report:\n${lastReport.slice(0, AUDIT_REPORT_HEAD_CHARACTERS)}`,
      );
    },
    pack: () => {
      const result = run(packageRoot, [
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--workspaces=false",
      ]);
      assert(
        result.status === 0,
        `npm pack --dry-run failed:\n${result.stderr}`,
      );
      const reports = parseCommandJson<PackReport[]>(
        result,
        "npm pack --dry-run",
      );
      assert(
        Array.isArray(reports) && reports.length === 1,
        "npm pack emitted an unexpected report",
      );
      const report = reports[0];
      const files = new Set((report.files ?? []).map((file) => file.path));
      assert(
        report.size <= gates.pack.maxPackedBytes,
        `packed bytes ${report.size} exceed ${gates.pack.maxPackedBytes}`,
      );
      assert(
        report.unpackedSize <= gates.pack.maxUnpackedBytes,
        `unpacked bytes ${report.unpackedSize} exceed ${gates.pack.maxUnpackedBytes}`,
      );
      assert(
        report.entryCount <= gates.pack.maxFiles,
        `pack files ${report.entryCount} exceed ${gates.pack.maxFiles}`,
      );
      for (const required of gates.pack.requiredFiles)
        assert(files.has(required), `packed artifact is missing ${required}`);
      assert(manifest.exports, "package manifest must declare exports");
      for (const [subpath, conditions] of Object.entries(manifest.exports)) {
        for (const [condition, target] of Object.entries(conditions)) {
          if (typeof target !== "string" || !target.startsWith("./")) continue;
          assert(
            files.has(target.slice(2)),
            `packed ${subpath} ${condition} target is missing: ${target.slice(2)}`,
          );
        }
      }
      console.log(
        `pack budget ok (${report.size} packed bytes, ${report.unpackedSize} unpacked bytes, ${report.entryCount} files)`,
      );
    },
  };
}

function productionLockEntries(lock: Lock): Array<[string, LockEntry]> {
  return Object.entries(lock.packages).filter(
    ([, entry]) => entry.dev !== true,
  );
}

function lockPackageName(path: string, entry: LockEntry): string {
  return (
    entry.name ??
    path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)
  );
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runNpm(
  packageRoot: string,
  args: string[],
  timeoutMs?: number,
): CommandResult {
  const cache = mkdtempSync(join(tmpdir(), "core-package-npm-cache-"));
  try {
    return spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [...args, "--cache", cache],
      {
        cwd: packageRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // Undefined for the sbom and pack callers: their options are unchanged.
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function parseCommandJson<Parsed>(
  result: CommandResult,
  command: string,
): Parsed {
  assert(
    result.stdout,
    `${command} produced no JSON output:\n${result.stderr}`,
  );
  try {
    return JSON.parse(result.stdout) as Parsed;
  } catch (error) {
    throw new Error(
      `${command} emitted invalid JSON: ${(error as Error).message}\n${result.stdout}`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
