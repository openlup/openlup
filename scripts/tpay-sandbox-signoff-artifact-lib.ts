import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluatePspSandboxE2ESignoff,
  type PspSandboxE2ESignoffDecision,
  type PspSandboxE2ESignoffInput,
} from "../src/domains/payment/sandboxE2ESignoff.ts";
import {
  assertEvidenceDir,
  buildCaseEvidence,
  displayPath,
  readExistingInput,
  requiredTpaySandboxSignoffCases,
  safetySummary,
  scanEvidenceTextForSecrets,
  TPAY_PROVIDER_SCOPE,
  TPAY_SANDBOX_SIGNOFF_INPUT_FILE,
  type SafetySummary,
  type SecretFinding,
} from "./tpay-sandbox-signoff-artifact-support.ts";

export {
  requiredTpaySandboxSignoffCases,
  scanEvidenceTextForSecrets,
  TPAY_SANDBOX_SIGNOFF_INPUT_FILE,
  type SecretFinding,
};

export const TPAY_SANDBOX_SIGNOFF_ARTIFACT_VERSION = "tpay_sandbox_signoff_artifact.v1";

type BuildOptions = {
  evidenceDir: string;
  publicActivationRequested?: boolean;
  cwd?: string;
};

type SuccessfulArtifactResult = {
  ok: true;
  mode: typeof TPAY_SANDBOX_SIGNOFF_ARTIFACT_VERSION;
  evidenceDir: string;
  input: PspSandboxE2ESignoffInput;
  decision: PspSandboxE2ESignoffDecision;
  secretFindings: [];
  warnings: string[];
  safety: SafetySummary;
};

type FailedArtifactResult = {
  ok: false;
  mode: typeof TPAY_SANDBOX_SIGNOFF_ARTIFACT_VERSION;
  evidenceDir: string;
  input: null;
  decision: null;
  secretFindings: SecretFinding[];
  warnings: string[];
  safety: SafetySummary;
};

export type TpaySandboxSignoffArtifactResult = SuccessfulArtifactResult | FailedArtifactResult;

export function buildTpaySandboxSignoffArtifact({
  evidenceDir,
  publicActivationRequested = true,
  cwd = process.cwd(),
}: BuildOptions): TpaySandboxSignoffArtifactResult {
  const resolvedEvidenceDir = resolve(evidenceDir);
  assertEvidenceDir(resolvedEvidenceDir);

  const warnings: string[] = [];
  const secretFindings = scanEvidenceTextForSecrets(resolvedEvidenceDir, cwd);
  const safety = safetySummary();
  const displayEvidenceDir = displayPath(resolvedEvidenceDir, cwd);

  if (secretFindings.length > 0) {
    warnings.push("secret-shaped text evidence found; refusing to build or write signoff input");
    return {
      ok: false,
      mode: TPAY_SANDBOX_SIGNOFF_ARTIFACT_VERSION,
      evidenceDir: displayEvidenceDir,
      input: null,
      decision: null,
      secretFindings,
      warnings,
      safety,
    };
  }

  const existing = readExistingInput(resolvedEvidenceDir, cwd, warnings);
  const cases = requiredTpaySandboxSignoffCases().map((caseId) =>
    buildCaseEvidence({ evidenceDir: resolvedEvidenceDir, cwd, caseId, existing, warnings }),
  );
  const input: PspSandboxE2ESignoffInput = {
    publicActivationRequested,
    providerScope: [...TPAY_PROVIDER_SCOPE],
    cases,
  };

  return {
    ok: true,
    mode: TPAY_SANDBOX_SIGNOFF_ARTIFACT_VERSION,
    evidenceDir: displayEvidenceDir,
    input,
    decision: evaluatePspSandboxE2ESignoff(input),
    secretFindings: [],
    warnings,
    safety,
  };
}

export function writeTpaySandboxSignoffInput(
  evidenceDir: string,
  input: PspSandboxE2ESignoffInput,
  cwd = process.cwd(),
): string {
  const resolvedEvidenceDir = resolve(evidenceDir);
  mkdirSync(resolvedEvidenceDir, { recursive: true });
  const secretFindings = scanEvidenceTextForSecrets(resolvedEvidenceDir, cwd);
  if (secretFindings.length > 0) {
    throw new Error("Refusing to write Tpay signoff input because text evidence contains secret-shaped values");
  }
  const outputPath = join(resolvedEvidenceDir, TPAY_SANDBOX_SIGNOFF_INPUT_FILE);
  writeFileSync(outputPath, `${JSON.stringify(input, null, 2)}\n`);
  return outputPath;
}
