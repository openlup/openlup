import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as PackageErrors from "@openlup/platform/account-support";
import { CustomerSupportCommandInvalidError as ReferenceInvalid, CustomerSupportCommandIdempotencyConflictError as ReferenceConflict,
  OperatorSubscriptionAuthorityUnavailableError as ReferenceUnavailable } from "../../domains/support/customerRecoveryCommand.js";
import { CustomerSupportOperatorInactiveError as ReferenceInactive, CustomerSupportOperatorNotProvisionedError as ReferenceNotProvisioned,
  CustomerSupportCommandRequiresHumanError as ReferenceHuman } from "../support/customerJourneyBinding.js";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createM12OperatorRecoveryBinding } from "./m12OperatorRecoveryBinding.js";
import type * as Local from "@openlup/platform/account-support/contracts";
import type { OperatorSubscriptionCommandResult, OperatorEmailCorrectionResult, OperatorPhoneCorrectionResult, CustomerRecoveryAuthorityResult } from "../../domains/support/customerRecoveryCommand.js";
import type { OperatorLeadAbsorptionResult } from "../../domains/support/leadAbsorption.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import type { OperatorQueryExecutor } from "@openlup/platform/account-support";
import type { LeadAbsorptionCarried } from "../../../src/domains/support/customerSubjectCorrectionContracts.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
export type ReferenceEquality = [
  Assert<Equal<Local.OperatorSubscriptionResult, OperatorSubscriptionCommandResult>>,
  Assert<Equal<Local.OperatorEmailCorrectionResult, OperatorEmailCorrectionResult>>,
  Assert<Equal<Local.OperatorPhoneCorrectionResult, OperatorPhoneCorrectionResult>>,
  Assert<Equal<Local.CustomerRecoveryAuthorityResult, CustomerRecoveryAuthorityResult>>,
  Assert<Equal<Local.OperatorLeadAbsorptionResult, OperatorLeadAbsorptionResult>>,
  Assert<Equal<Local.LeadAbsorptionCarried, LeadAbsorptionCarried>>,
  Assert<PgQueryExecutor extends OperatorQueryExecutor ? true : false>
];
it("checks current reference-owner DTOs, error vocabulary and the executor subset with the compiler", () => {
  expect({
    invalid: new PackageErrors.CustomerSupportCommandInvalidError().message,
    conflict: new PackageErrors.CustomerSupportCommandIdempotencyConflictError().message,
    unavailable: new PackageErrors.OperatorSubscriptionAuthorityUnavailableError().message,
    inactive: new PackageErrors.CustomerSupportOperatorInactiveError().message,
    notProvisioned: new PackageErrors.CustomerSupportOperatorNotProvisionedError().message,
    human: new PackageErrors.CustomerSupportCommandRequiresHumanError().message,
  }).toEqual({ invalid: new ReferenceInvalid().message, conflict: new ReferenceConflict().message,
    unavailable: new ReferenceUnavailable().message, inactive: new ReferenceInactive().message,
    notProvisioned: new ReferenceNotProvisioned().message, human: new ReferenceHuman().message });
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  const source = program.getSourceFile(file)!;
  expect(ts.formatDiagnosticsWithColorAndContext([...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)], {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);
it.each([undefined, false])("default-off enabled=%s opens no port", enabled => {
  const options = { enabled, graph: "native" } as Parameters<typeof createM12OperatorRecoveryBinding>[0];
  expect(createM12OperatorRecoveryBinding(options)).toBeNull();
});
it("enabled selection refuses incomplete ports", () => {
  expect(() => createM12OperatorRecoveryBinding({ enabled: true, graph: "native" } as never)).toThrow("ports_required");
});
it("selects the package managed admission/claim/settlement without opening identity for an unlinked subject", async () => {
  const calls: string[] = []; const identity = vi.fn();
  const binding = createM12OperatorRecoveryBinding({ enabled: true, graph: "managed", identity,
    accountLink: { findSubject: async () => null, resolveIdentityForEmail: async () => "unused" },
    options: { operatorId: "human", now: () => 0, recoveryPath: token => `/repair?token=${token}` },
    rpc: { rpc: async (name) => {
      calls.push(name);
      const data = name.includes("admit") ? { outcome: "admitted", authUserId: null, originalEmail: "old@example.invalid", newEmail: "new@example.invalid" }
        : name.includes("claim") ? { outcome: "claimed", authUserId: null, originalEmail: "old@example.invalid", newEmail: "new@example.invalid", idempotencyKey: "email-key", claimToken: "claim", sequence: "1" }
        : { outcome: "applied", authUserLinked: false };
      return { data, error: null };
    } },
  })!;
  expect(await binding.execute({ actor: { operatorId: "human", graph: "managed", role: "admin", isMachineActor: false }, subject: { subjectId: "subject" },
    command: { action: "correct_email", subjectId: "subject", expectedEmail: "old@example.invalid", newEmail: "new@example.invalid", idempotencyKey: "email-key" },
    idempotencyKey: "email-key", reason: null, expectedVersion: null, evidence: [] })).toEqual({ outcome: "applied", authUserLinked: false });
  expect(calls).toEqual(["customer_support_admit_subject_email_v1", "customer_support_claim_subject_email_v1", "customer_support_settle_subject_email_v1"]);
  expect(identity).not.toHaveBeenCalled();
});

it("selects native recovery with runtime crypto and the host recovery path", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ result: { outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" } }] }));
  const binding = createM12OperatorRecoveryBinding({ enabled: true, graph: "native",
    transaction: { run: work => work({ query }) },
    options: { operatorId: "human", now: () => 0, recoveryPath: token => `/host-recovery/${token}` },
  })!;
  expect(await binding.execute({ actor: { operatorId: "human", graph: "native", role: "admin", isMachineActor: false },
    subject: { subjectId: "subject" }, command: { action: "issue_recovery", subjectId: "subject", caseId: "case", idempotencyKey: "recovery-key" },
    idempotencyKey: "recovery-key", reason: null, expectedVersion: null, evidence: [] })).toEqual({ outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" });
  expect(query).toHaveBeenCalledTimes(1);
  const values = query.mock.calls[0]![1]!;
  const token = (values[7] as string).slice("/host-recovery/".length);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(values).toEqual(["human", "subject", "case", "recovery-key",
    createHash("sha256").update(JSON.stringify({ action: "issue_recovery", subjectId: "subject", caseId: "case" })).digest("hex"),
    createHash("sha256").update(token).digest("hex"), "1970-01-02T00:00:00.000Z", `/host-recovery/${token}`]);
});
