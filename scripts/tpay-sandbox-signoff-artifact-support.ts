import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PSP_SANDBOX_E2E_CASES,
  PSP_SANDBOX_E2E_CASE_PROVIDERS,
  type PspSandboxE2ECase,
  type PspSandboxE2ECaseEvidence,
  type PspSandboxE2ECaseStatus,
  type PspSandboxE2EProvider,
} from "../src/domains/payment/sandboxE2ESignoff.ts";

export const TPAY_PROVIDER_SCOPE: PspSandboxE2EProvider[] = ["tpay"];
export const TPAY_SANDBOX_SIGNOFF_INPUT_FILE = "signoff-input.json";

export type SecretFinding = {
  file: string;
  line: number;
  kind: string;
};

export type SafetySummary = {
  mutatingProviderCalls: false;
  credentialsRequired: false;
  providerScope: PspSandboxE2EProvider[];
  publicActivationAllowedByTool: false;
};

type ExistingInput = {
  cases: Map<PspSandboxE2ECase, PspSandboxE2ECaseEvidence>;
};

type SecretPattern = {
  kind: string;
  regex: RegExp;
};

const TEXT_EVIDENCE_EXTENSIONS = new Set([".csv", ".json", ".log", ".md", ".sql", ".txt"]);
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "stripe_secret_key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/ },
  { kind: "stripe_webhook_secret", regex: /\bwhsec_[A-Za-z0-9]{12,}\b/ },
  { kind: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "supabase_service_role_key", regex: /\bSUPABASE_SERVICE_ROLE_KEY\s*=/i },
  { kind: "supabase_service_role_value", regex: /\bservice_role\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}/i },
  { kind: "tpay_client_secret", regex: /\bTPAY_(?:CLIENT_)?SECRET(?:_[A-Z0-9_]+)?\s*=/i },
  { kind: "oauth_client_secret", regex: /\bclient_secret\s*=\s*[A-Za-z0-9._~+/-]{8,}/i },
  { kind: "authorization_bearer", regex: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{12,}/i },
  { kind: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i },
  { kind: "jws_signature", regex: /\bx-jws-signature\s*:\s*[A-Za-z0-9._-]{20,}/i },
  { kind: "blik_code", regex: /\b(?:blik(?:\s+code|_code| token)?|TPAY_SMOKE_BLIK_CODE)\s*[:=]\s*["']?\d{6}\b/i },
];

export function requiredTpaySandboxSignoffCases(): PspSandboxE2ECase[] {
  return PSP_SANDBOX_E2E_CASES.filter((caseId) =>
    PSP_SANDBOX_E2E_CASE_PROVIDERS[caseId].includes("tpay"),
  );
}

export function scanEvidenceTextForSecrets(evidenceDir: string, cwd = process.cwd()): SecretFinding[] {
  return collectTextEvidenceFiles(evidenceDir).flatMap((file) => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    return lines.flatMap((line, index) =>
      SECRET_PATTERNS
        .filter((pattern) => pattern.regex.test(line))
        .map((pattern) => ({
          file: displayPath(file, cwd),
          line: index + 1,
          kind: pattern.kind,
        })),
    );
  });
}

export function buildCaseEvidence({
  evidenceDir,
  cwd,
  caseId,
  existing,
  warnings,
}: {
  evidenceDir: string;
  cwd: string;
  caseId: PspSandboxE2ECase;
  existing: ExistingInput | null;
  warnings: string[];
}): PspSandboxE2ECaseEvidence {
  const caseDir = join(evidenceDir, caseId);
  if (!existsSync(caseDir)) return existing?.cases.get(caseId) ?? missingCaseEvidence(caseId);
  if (!statSync(caseDir).isDirectory()) {
    warnings.push(`${displayPath(caseDir, cwd)} is not a directory; treating ${caseId} as not_run`);
    return missingCaseEvidence(caseId);
  }

  const summaryPath = join(caseDir, "summary.md");
  const summaryText = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  const providerDashboardEvidence = findEvidenceRef(caseDir, "provider-dashboard", cwd);
  const localDatabaseEvidence = findEvidenceRef(caseDir, "local-db", cwd);
  return {
    caseId,
    status: statusFromSummary(summaryText),
    providerDashboardEvidence,
    localDatabaseEvidence,
    notes: notesFromSummary({
      summaryText,
      hasSummary: Boolean(summaryText.trim()),
      providerDashboardEvidence,
      localDatabaseEvidence,
    }),
  };
}

export function readExistingInput(
  evidenceDir: string,
  cwd: string,
  warnings: string[],
): ExistingInput | null {
  const inputPath = join(evidenceDir, TPAY_SANDBOX_SIGNOFF_INPUT_FILE);
  if (!existsSync(inputPath)) return null;

  const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
    throw new Error(`${displayPath(inputPath, cwd)} must contain a signoff input object with cases[]`);
  }

  const providerScope = Array.isArray(parsed.providerScope) ? parsed.providerScope : [];
  if (providerScope.length !== 1 || providerScope[0] !== "tpay") {
    warnings.push(`${displayPath(inputPath, cwd)} providerScope is overridden to ["tpay"]`);
  }

  const requiredCases = new Set(requiredTpaySandboxSignoffCases());
  const cases = new Map<PspSandboxE2ECase, PspSandboxE2ECaseEvidence>();
  for (const rawCase of parsed.cases) {
    if (!isRecord(rawCase)) continue;
    const caseId = rawCase.caseId;
    if (!isPspCase(caseId)) {
      warnings.push(`${displayPath(inputPath, cwd)} contains unknown caseId ${String(caseId)}`);
      continue;
    }
    if (!requiredCases.has(caseId)) continue;
    if (!isStatus(rawCase.status)) {
      throw new Error(`${displayPath(inputPath, cwd)} case ${caseId} has invalid status`);
    }
    cases.set(caseId, {
      caseId,
      status: rawCase.status,
      providerDashboardEvidence: asNullableString(rawCase.providerDashboardEvidence),
      localDatabaseEvidence: asNullableString(rawCase.localDatabaseEvidence),
      notes: asNullableString(rawCase.notes),
    });
  }
  return { cases };
}

export function assertEvidenceDir(evidenceDir: string): void {
  if (!existsSync(evidenceDir)) throw new Error(`Evidence directory does not exist: ${evidenceDir}`);
  if (!statSync(evidenceDir).isDirectory()) throw new Error(`Evidence path is not a directory: ${evidenceDir}`);
}

export function safetySummary(): SafetySummary {
  return {
    mutatingProviderCalls: false,
    credentialsRequired: false,
    providerScope: [...TPAY_PROVIDER_SCOPE],
    publicActivationAllowedByTool: false,
  };
}

export function displayPath(path: string, cwd: string): string {
  const rel = relative(resolve(cwd), resolve(path));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return resolve(path);
}

function statusFromSummary(summaryText: string): PspSandboxE2ECaseStatus {
  const explicitStatus = summaryText.match(/^\s*Status\s*:\s*(passed|failed|not[_ -]?run)\b/im)?.[1];
  const normalized = explicitStatus?.toLowerCase().replace(/[- ]/g, "_");
  if (normalized === "passed" || normalized === "failed" || normalized === "not_run") return normalized;
  return "not_run";
}

function notesFromSummary({
  summaryText,
  hasSummary,
  providerDashboardEvidence,
  localDatabaseEvidence,
}: {
  summaryText: string;
  hasSummary: boolean;
  providerDashboardEvidence: string | null;
  localDatabaseEvidence: string | null;
}): string {
  const missing = [
    !hasSummary ? "summary.md" : "",
    !providerDashboardEvidence ? "provider-dashboard.*" : "",
    !localDatabaseEvidence ? "local-db*" : "",
  ].filter(Boolean);
  const body = summaryText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#/.test(line) && !/^Status\s*:/i.test(line))
    .join(" ")
    .slice(0, 800);
  if (missing.length === 0) return body || "Evidence references present.";
  const missingNote = `Missing required evidence: ${missing.join(", ")}.`;
  return body ? `${missingNote} ${body}` : missingNote;
}

function findEvidenceRef(caseDir: string, prefix: string, cwd: string): string | null {
  const match = readdirSync(caseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .find((name) =>
      name === prefix ||
      name.startsWith(`${prefix}.`) ||
      name.startsWith(`${prefix}-`) ||
      name.startsWith(`${prefix}_`)
    );
  return match ? displayPath(join(caseDir, match), cwd) : null;
}

function collectTextEvidenceFiles(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return collectTextEvidenceFiles(path);
      if (entry.isFile() && TEXT_EVIDENCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) return [path];
      return [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function missingCaseEvidence(caseId: PspSandboxE2ECase): PspSandboxE2ECaseEvidence {
  return {
    caseId,
    status: "not_run",
    providerDashboardEvidence: null,
    localDatabaseEvidence: null,
    notes: "Missing case evidence directory; sandbox proof not provided.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPspCase(value: unknown): value is PspSandboxE2ECase {
  return typeof value === "string" && PSP_SANDBOX_E2E_CASES.includes(value as PspSandboxE2ECase);
}

function isStatus(value: unknown): value is PspSandboxE2ECaseStatus {
  return value === "not_run" || value === "failed" || value === "passed";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
