// Fixed local source witnesses. No supplied commands or historical receipt admission.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { readProcessEnvironment } from "../../server/_lib/observability/runtimeProvenance.ts";

const outcome = "LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION";
export function journeyReceipt(report, recovery = false) {
  assert.equal(report.outcome, outcome);
  assert.deepEqual(report.cleanupFailures, []);
  assert.equal(report.journey?.leg, "portable-to-portable");
  assert.equal(report.journey?.takeover, true);
  assert.equal(report.graphPublished, true);
  assert.equal(report.filesystemPublished, true);
  assert.equal(report.sourceWritesFrozen, true);
  const result = { status: "PASS", claim: "local self-host recipe receipt",
    leg: report.journey.leg, image: report.image, catalogue: report.catalogue,
    journey: report.journey, recoveredAcceptedEffects: report.recoveredAcceptedEffects,
    wholeStoreRtoMs: null, readyScope: report.readyScope,
    cleanup: { status: "PASS", failures: [] }, hostedQualification: false };
  if (recovery) {
    const measurement = report.recovery;
    assert.equal(measurement?.format, "openlup.local-older-snapshot-recovery.v1");
    for (const name of ["snapshotAgeSeconds", "effectiveRpoSeconds", "rtoSeconds"]) {
      assert(Number.isFinite(measurement[name]) && measurement[name] > 0);
    }
    assert(measurement.snapshotAgeSeconds >= 60);
    assert.equal(measurement.postFailureDiagnosticGraphUsedForRestore, false);
    assert.equal(measurement.noSloClaim, true);
    assert.equal(measurement.hostedQualification, false);
    result.measurement = measurement;
    result.measurementClaim = "declared-scope fixture measurement, not an SLO or hosted claim";
  }
  return result;
}

export async function runLocalJourney(root, image, recovery = false) {
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  const directory = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/postgres/runM14EffectHandover.ts", image,
      recovery ? "--older-snapshot" : "--catch-up"], {
      cwd: root, env: { PATH: readProcessEnvironment().PATH }, stdio: ["ignore", "pipe", "ignore"], timeout: 600000,
    });
    let bytes = "";
    child.stdout.on("data", chunk => { bytes += String(chunk); if (bytes.length > 1024 * 1024) child.kill("SIGTERM"); });
    child.once("error", () => reject(new Error("local_journey_unavailable")));
    child.once("close", code => {
      if (code !== 0) return reject(new Error("local_journey_failed; raw output suppressed"));
      try {
        // The witness emits cleanup diagnostics before its terminal JSON record.
        const last = JSON.parse(bytes.trim().split("\n").at(-1));
        const parent = resolve(root, ".context/scratch", recovery ? "oss-m14-older-snapshot-recovery" : "oss-m14-connected-catchup");
        assert(last.evidenceDirectory.startsWith(`${parent}/journey-`));
        assert.equal(resolve(last.evidenceDirectory), last.evidenceDirectory);
        assert.equal(last.outcome, outcome);
        done(last.evidenceDirectory);
      } catch { reject(new Error("local_journey_report_refused")); }
    });
  });
  return journeyReceipt(JSON.parse(readFileSync(join(directory, "report.json"), "utf8")), recovery);
}

export async function runLocalOidc(root, hosted) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      "import { main } from './tests/postgres/runOidcIdentityConformance.mjs'; let input = ''; for await (const chunk of process.stdin) input += chunk; main([], JSON.parse(input)).then(value => process.send(value, () => process.disconnect())).catch(() => { process.exitCode = 1; process.disconnect(); });"], {
      cwd: root, env: { PATH: readProcessEnvironment().PATH }, stdio: ["pipe", "ignore", "ignore", "ipc"], timeout: 600000,
    });
    let message;
    child.on("message", value => { message = value; });
    child.once("error", () => reject(new Error("local_oidc_unavailable")));
    child.once("close", code => {
      if (code !== 0 || message?.status !== "PASS" || message.cacheExpiryClock !== "wall"
        || !(message.cacheElapsedSeconds >= 300) || message.cleanup?.status !== "PASS"
        || (hosted && (message.issuer !== "hosted test Keycloak" || message.image !== hosted.issuerImage
          || message.tls?.status !== "PASS" || message.tls.ordinaryTrustStore !== true
          || message.tls.hostnameVerified !== true || message.cleanup.realmsAbsent !== true))) {
        reject(new Error("local_oidc_failed; raw output suppressed"));
      } else done(message);
    });
    child.stdin.end(JSON.stringify(hosted ?? null));
  });
}
