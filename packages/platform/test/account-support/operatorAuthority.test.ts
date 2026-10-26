import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createManagedOperatorAuthority, operatorAuthorityCapabilities, nativeSubscriptionCommand, subscriptionCommand } from "../../src/account-support/operatorAuthority.js";
import type * as Local from "../../src/account-support/contracts/index.js";
import type { SubscriptionCommandReceipt } from "../../src/subscriptions/contracts/index.js";
import type { SubscriptionQueryExecutor } from "../../src/subscriptions/index.js";
import type { OperatorQueryExecutor } from "../../src/account-support/postgresOperatorAuthority.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
type Codes<T> = T extends { refusalCode: infer Code } ? Code : never;
export type PackagedOwnerEquality = [
  Assert<Equal<Pick<Local.OperatorOwnerReceipt, "actorId" | "idempotencyKey" | "commandFingerprint">,
    Pick<SubscriptionCommandReceipt, "actorId" | "idempotencyKey" | "commandFingerprint">>>,
  Assert<Local.OperatorSubscriptionResult extends Local.NativeOperatorSubscriptionResult ? true : false>,
  Assert<Equal<Exclude<Codes<Local.NativeOperatorSubscriptionResult>, Local.OperatorSubscriptionRefusal | undefined>, "operator_subscription_authority_unavailable">>,
  Assert<SubscriptionQueryExecutor extends OperatorQueryExecutor ? true : false>
];
it("checks packaged owner fields, native superset and narrow executor fit with the compiler", () => {
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  const source = program.getSourceFile(file)!;
  expect(ts.formatDiagnosticsWithColorAndContext([...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)], {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);
it.each(["managed", "native"] as const)("reports the truthful %s action/subcase table", graph => {
  const cap = operatorAuthorityCapabilities(graph);
  for (const action of ["email", "phone", "link", "address", "shortBand", "unpaidResume", "preparedAttemptPause"] as const) {
    expect(cap[action], action).toEqual(graph === "managed" ? { supported: true } : { supported: false, refusalCode: "operator_subscription_authority_unavailable" });
  }
  expect([cap.pause, cap.resume, cap.slide]).toEqual([{ supported: true }, { supported: true }, { supported: true }]);
});
it("managed decoder refuses the native-only literal while the native decoder carries real owner evidence", async () => {
  const unavailable = { outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" };
  expect(() => subscriptionCommand(unavailable)).toThrow("response_invalid");
  expect(nativeSubscriptionCommand(unavailable)).toEqual(unavailable);
  const calls: unknown[] = [];
  const port = createManagedOperatorAuthority({ rpc: async (name, args) => { calls.push([name, args]); return { data: { outcome: "conflict", refusalCode: "version_conflict" }, error: null }; } },
    { operatorId: "operator", now: () => 0, recoveryPath: token => `/repair?token=${token}` });
  expect(await port.applySubscriptionAction({ operatorId: "operator", subscriptionId: "subscription", subscriptionAction: "resume", expectedVersion: 3, idempotencyKey: "support-key", payload: {} }))
    .toEqual({ outcome: "conflict", refusalCode: "version_conflict" });
  expect(calls).toEqual([["customer_support_apply_subscription_action_v1", { p_operator_id: "operator", p_subscription_id: "subscription", p_action: "resume", p_expected_version: 3,
    p_payload: {}, p_idempotency_key: "support-key", p_now: "1970-01-01T00:00:00.000Z" }]]);
});

it("managed recovery sends Web Crypto hashes and a fresh opaque token to the authority", async () => {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: { outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" }, error: null }));
  const port = createManagedOperatorAuthority({ rpc }, { operatorId: "operator", now: () => 0, recoveryPath: token => `/repair?token=${token}` });
  const input = { operatorId: "operator", subjectId: "subject", caseId: "case", idempotencyKey: "recovery-key" };
  expect(await port.issueRecovery(input)).toEqual({ outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" });
  const [name, args] = rpc.mock.calls[0]!;
  const token = (args.p_recovery_path as string).split("token=")[1]!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token, "base64url")).toHaveLength(32);
  expect([name, args]).toEqual(["customer_support_issue_recovery", {
    p_operator_id: "operator", p_subject_id: "subject", p_case_id: "case", p_idempotency_key: "recovery-key",
    p_token_hash: createHash("sha256").update(token).digest("hex"),
    p_payload_fingerprint: createHash("sha256").update(JSON.stringify({ action: "issue_recovery", subjectId: "subject", caseId: "case" })).digest("hex"),
    p_expires_at: "1970-01-02T00:00:00.000Z", p_recovery_path: `/repair?token=${token}`,
  }]);
  await port.issueRecovery(input);
  expect(rpc.mock.calls[1]![1]).not.toHaveProperty("p_token_hash", args.p_token_hash);
});
