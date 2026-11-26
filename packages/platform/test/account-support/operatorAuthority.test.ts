import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createManagedOperatorAuthority, operatorAuthorityCapabilities, nativeSubscriptionCommand, subscriptionCommand } from "../../src/account-support/operatorAuthority.js";
import { withManagedOperatorDeadlockRetry } from "../../src/account-support/index.js";
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
    if (graph === "native" && action === "address") {
      expect(cap[action], action).toEqual({ supported: true });
      continue;
    }
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

const subscriptionRpc = "customer_support_apply_subscription_action_v1";
const recoveryRpc = "customer_support_issue_recovery";
const deadlock = { data: null, error: { code: "40P01", message: "private database detail" } };
const managedOptions = {
  operatorId: "operator",
  now: () => 0,
  recoveryPath: (token: string) => `/repair?token=${token}`,
};
const commands = [
  {
    rpc: subscriptionRpc,
    run: (authority: ReturnType<typeof createManagedOperatorAuthority>) => authority.applySubscriptionAction({
      operatorId: "operator", subscriptionId: "subscription", subscriptionAction: "resume",
      expectedVersion: 2, idempotencyKey: "subscription-key", payload: { confirmedChargeTiming: true },
    }),
    expectedArgs: {
      p_idempotency_key: "subscription-key", p_expected_version: 2, p_now: "1970-01-01T00:00:00.000Z",
      p_payload: { confirmedChargeTiming: true },
    },
    success: { outcome: "applied", subscriptionStatus: "active", templateVersion: 3 },
    refusal: { outcome: "refused", refusalCode: "version_conflict" },
    failure: "customer_support_subscription_command_failed: 40P01",
  },
  {
    rpc: recoveryRpc,
    run: (authority: ReturnType<typeof createManagedOperatorAuthority>) => authority.issueRecovery({
      operatorId: "operator", subjectId: "subject", caseId: "case", idempotencyKey: "recovery-key",
    }),
    expectedArgs: {
      p_idempotency_key: "recovery-key", p_expires_at: "1970-01-02T00:00:00.000Z",
      p_token_hash: createHash("sha256").update("synthetic-token").digest("hex"),
      p_recovery_path: "/repair?token=synthetic-token",
    },
    success: { outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" },
    refusal: { outcome: "refused", refusalCode: "case_not_open" },
    failure: "customer_support_recovery_failed",
  },
] as const;

it.each(commands)("$rpc retries in the existing authority with one argument envelope", async command => {
  const response = { data: command.success, error: null };
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => response as { data: unknown; error: unknown })
    .mockResolvedValueOnce(deadlock).mockResolvedValueOnce(deadlock);
  const waitBeforeRetry = vi.fn(async () => undefined);
  const onDeadlock = vi.fn();
  const now = vi.fn(() => 0);
  const createOpaqueToken = vi.fn(() => "synthetic-token");
  const authority = createManagedOperatorAuthority(
    withManagedOperatorDeadlockRetry({ rpc }, { waitBeforeRetry, onDeadlock }),
    { ...managedOptions, now, createOpaqueToken },
  );

  await expect(command.run(authority)).resolves.toMatchObject(command.success);
  expect(rpc).toHaveBeenCalledTimes(3);
  const args = rpc.mock.calls[0]![1];
  expect(args).toMatchObject(command.expectedArgs);
  for (const [name, attemptArgs] of rpc.mock.calls) {
    expect(name).toBe(command.rpc);
    expect(attemptArgs).toBe(args);
  }
  expect(now).toHaveBeenCalledTimes(1);
  expect(createOpaqueToken).toHaveBeenCalledTimes(command.rpc === recoveryRpc ? 1 : 0);
  expect(waitBeforeRetry.mock.calls).toEqual([[1], [2]]);
  expect(onDeadlock.mock.calls).toEqual([[{ rpc: command.rpc, sqlstate: "40P01", phase: "first" }]]);
});

it.each(commands)("$rpc exhausts with its original authority failure and fail-soft diagnostics", async command => {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => deadlock);
  const waitBeforeRetry = vi.fn(async () => undefined);
  const onDeadlock = vi.fn<NonNullable<Parameters<typeof withManagedOperatorDeadlockRetry>[1]["onDeadlock"]>>()
    .mockImplementationOnce(() => { throw new Error("observer failed"); })
    .mockRejectedValueOnce(new Error("observer rejected"));
  const authority = createManagedOperatorAuthority(
    withManagedOperatorDeadlockRetry({ rpc }, { waitBeforeRetry, onDeadlock }),
    { ...managedOptions, createOpaqueToken: () => "synthetic-token" },
  );

  await expect(command.run(authority)).rejects.toThrow(command.failure);
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(waitBeforeRetry.mock.calls).toEqual([[1], [2]]);
  expect(onDeadlock.mock.calls).toEqual([
    [{ rpc: command.rpc, sqlstate: "40P01", phase: "first" }],
    [{ rpc: command.rpc, sqlstate: "40P01", phase: "exhausted" }],
  ]);
});

it.each(commands)("$rpc delivers the existing business refusal and replay on their first response", async command => {
  const replay = { ...command.success, outcome: "replayed" };
  const rpc = vi.fn()
    .mockResolvedValueOnce({ data: command.refusal, error: null })
    .mockResolvedValueOnce({ data: replay, error: null });
  const waitBeforeRetry = vi.fn(async () => undefined);
  const authority = createManagedOperatorAuthority(
    withManagedOperatorDeadlockRetry({ rpc }, { waitBeforeRetry }),
    { ...managedOptions, createOpaqueToken: () => "synthetic-token" },
  );

  await expect(command.run(authority)).resolves.toEqual(command.refusal);
  expect(rpc).toHaveBeenCalledTimes(1);
  await expect(command.run(authority)).resolves.toMatchObject(replay);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(waitBeforeRetry).not.toHaveBeenCalled();
});

it.each(["23505", "40001", "55P03", "PGRST202", "42501", "40p01", undefined])(
  "passes through a returned %s result without waiting", async code => {
    const result = { data: null, error: { code, message: "40P01 in prose" } };
    const rpc = vi.fn(async () => result);
    const waitBeforeRetry = vi.fn(async () => undefined);
    const executor = withManagedOperatorDeadlockRetry({ rpc }, { waitBeforeRetry });
    await expect(executor.rpc(subscriptionRpc, {})).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  },
);

it("passes through a thrown transport failure and does not retry another RPC", async () => {
  const transport = Object.assign(new Error("network response lost"), { code: "40P01" });
  const rpc = vi.fn(async () => deadlock).mockRejectedValueOnce(transport);
  const waitBeforeRetry = vi.fn(async () => undefined);
  const executor = withManagedOperatorDeadlockRetry({ rpc }, { waitBeforeRetry });

  await expect(executor.rpc(recoveryRpc, {})).rejects.toBe(transport);
  await expect(executor.rpc("customer_support_correct_subject_phone_v1", {})).resolves.toBe(deadlock);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(waitBeforeRetry).not.toHaveBeenCalled();
});

it("keeps the existing single-attempt managed default", async () => {
  const rpc = vi.fn(async () => deadlock);
  const authority = createManagedOperatorAuthority(
    { rpc }, { ...managedOptions, createOpaqueToken: () => "synthetic-token" },
  );
  await expect(commands[0].run(authority)).rejects.toThrow(commands[0].failure);
  await expect(commands[1].run(authority)).rejects.toThrow(commands[1].failure);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("names the partial native outcome and refuses malformed scope without widening managed decoding", () => {
  const partial = { outcome: "applied_from_next_parcel", subscriptionStatus: "active", nextCycleAt: null,
    templateVersion: 2, eventId: "event", appliedBy: null, appliesFrom: "next_parcel",
    futureDestinationId: "destination", replayed: false };
  expect(nativeSubscriptionCommand(partial)).toEqual(partial);
  expect(() => subscriptionCommand(partial)).toThrow("response_invalid");
  for (const change of [{ appliesFrom: "current_parcel" }, { futureDestinationId: "" }, { replayed: undefined }]) {
    expect(() => nativeSubscriptionCommand({ ...partial, ...change })).toThrow("response_invalid");
  }
});
