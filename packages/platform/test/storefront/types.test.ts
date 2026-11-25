import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

// One probe per line: each `@ts-expect-error` names the line after it.
const probes = `import { storefrontAnchor, toAttemptNumber, toCommandKey, toContinuationId } from "@openlup/platform/storefront";
import type { AttemptNumber, ChangedPayloadPolicy, ClientEventReporter, CommandKey, ContinuationId, ContinuationRecord, ContinuationRecordStorageBinding, IdentifierBinding, PaymentProviderFacts, PendingAction, PendingActionStorageBinding, StatusReading, StatusTransportBinding, StorageFailurePolicy, StorefrontAnchor, SubmitFailureClass, SubmitFailureClassifier, SubmitOutcomeClass, SubmitOutcomeClassifier, SubmitTransportBinding } from "@openlup/platform/storefront";
declare const continuationId: ContinuationId;
declare const commandKey: CommandKey;
// @ts-expect-error 01 a plain string is not a continuation identity
const plainContinuation: ContinuationId = "continuation";
// @ts-expect-error 02 a plain string is not a command key
const plainCommand: CommandKey = "command";
// @ts-expect-error 03 a plain number is not an attempt number
const plainAttempt: AttemptNumber = 1;
// @ts-expect-error 04 a continuation identity is not a command key
const crossedCommand: CommandKey = continuationId;
// @ts-expect-error 05 a command key is not a continuation identity
const crossedContinuation: ContinuationId = commandKey;
// @ts-expect-error 06 a record names its purchase by continuation identity, not by command key
const crossedRecord: ContinuationRecord = { continuationId: commandKey, fingerprint: "f" };
// @ts-expect-error 07 an attempt number is branded from a number only
const textAttempt = toAttemptNumber("1");
// @ts-expect-error 08 a transport's command key is branded, never a plain string
const plainKeyTransport: SubmitTransportBinding = { commandKey: (): string => "plain", replay: async () => undefined };
// Positive controls: object literals, using the constructors for branded members.
const record: ContinuationRecord = { continuationId: toContinuationId("c"), fingerprint: "f", attempt: toAttemptNumber(0) };
const firstRecord: ContinuationRecord = { continuationId: toContinuationId("c"), fingerprint: "f" };
let stored: ContinuationRecord | null = null;
const recordStorage: ContinuationRecordStorageBinding = { read: () => stored, write: (next) => { stored = next; }, clear: () => { stored = null; } };
const identifiers: IdentifierBinding = { next: () => "generated", accepts: (value) => value.length > 0 };
type Request = { key: CommandKey | null };
const transport: SubmitTransportBinding<Request, { signal?: AbortSignal }, { ok: true }> = { commandKey: (request) => request.key, replay: async () => ({ ok: true }) };
const brandedKeyTransport: SubmitTransportBinding = { commandKey: () => toCommandKey("k"), replay: async () => undefined };
const nullKeyTransport: SubmitTransportBinding = { commandKey: () => null, replay: async () => undefined };
const undefinedKeyTransport: SubmitTransportBinding = { commandKey: () => undefined, replay: async () => undefined };
const failureClasses: SubmitFailureClass[] = ["attempt_in_flight", "timeout", "transport_uncertain", "other"];
const classifyFailure: SubmitFailureClassifier = (error) => error instanceof TypeError ? "transport_uncertain" : "other";
const pending: PendingAction = { actionKind: "embedded", phase: "action_issued", expiresAt: 4_102_444_800 };
const redirectPending: PendingAction = { actionKind: "redirect", phase: "confirm_dispatched" };
const quietPending: PendingAction = { actionKind: "none" };
let pendingStored: PendingAction | null = null;
const pendingStorage: PendingActionStorageBinding = { read: () => pendingStored, write: (next) => { pendingStored = next; }, clear: () => { pendingStored = null; } };
const terminal: StatusReading = { kind: "terminal" };
const checking: StatusReading = { kind: "checking" };
const active: StatusReading = { kind: "active", payment: { provider: "provider", attemptStatus: "failed" }, action: { kind: "redirect", url: "https://example.invalid/" } };
const embedded: StatusReading = { kind: "active", payment: null, action: { kind: "embedded", provider: "provider", actionToken: "token" } };
const other: StatusReading = { kind: "active", action: { kind: "other" } };
const statusTransport: StatusTransportBinding = { read: async () => terminal };
const changedPolicies: ChangedPayloadPolicy[] = ["update_in_place", "refuse_changed"];
const storagePolicies: StorageFailurePolicy[] = ["refuse", "continue_unpersisted"];
const outcomes: SubmitOutcomeClass[] = ["settled", "needs_client_action", "awaiting_authority", "refused", "unknown"];
const classifyOutcome: SubmitOutcomeClassifier<{ status: string }> = (result) => result.status === "paid" ? "settled" : "unknown";
const facts: PaymentProviderFacts = { providers: ["provider"], reopenableEmbeddedProviders: ["provider"], retryableAttemptStatuses: ["failed", "expired"] };
const report: ClientEventReporter = (event) => { void event; };
const anchor: StorefrontAnchor = storefrontAnchor;
const attribute: "data-openlup-action" = storefrontAnchor.attribute.action;
const proceed: "proceed_to_checkout" = anchor.action.proceed_to_checkout;
export { record, firstRecord, recordStorage, identifiers, transport, brandedKeyTransport, nullKeyTransport, undefinedKeyTransport, failureClasses, classifyFailure, pending, redirectPending, quietPending, pendingStorage, checking, active, embedded, other, statusTransport, changedPolicies, storagePolicies, outcomes, classifyOutcome, facts, report, attribute, proceed };
`;

it("keeps the identity roles apart and accepts every binding shape", () => {
  const filename = fileURLToPath(new URL("./storefront-types-virtual.mts", import.meta.url));
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, noUnusedLocals: false, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], skipLibCheck: false,
  };
  function compile(text: string) {
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
    host.readFile = path => path === filename ? text : read(path);
    host.fileExists = path => path === filename || exists(path);
    return ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  }
  expect(compile(probes).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  const expected = probes.split("\n").flatMap((line, index) => line.includes("@ts-expect-error") ? [index + 2] : []);
  expect(expected).toHaveLength(8);
  const rejected = compile(probes.replace(/@ts-expect-error/g, "probe-without-suppression"));
  const lines = [...new Set(rejected.map(d => d.file?.fileName === filename && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : -1))].sort((a, b) => a - b);
  expect(lines).toEqual(expected);
}, 45_000);
