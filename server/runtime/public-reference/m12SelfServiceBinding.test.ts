import ts from "typescript";
import { fileURLToPath } from "node:url";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import type { AccountSupportCapabilities, SelfServiceCommandFacade, NativeLegacySubscriptionParts, LegacySubscriptionPort, AccountSupportLaneUnavailable } from "@openlup/platform/account-support/contracts";
import type { CustomerSubscriptionActionPort, CustomerSubscriptionPreviewPort, CustomerSubscriptionControlPort } from "../../domains/customers/ports.js";
import type { createPostgresCustomerSubscriptionPausePort } from "../../adapters/postgres/customerSubscriptionPause.js";
import type { PostgresCustomerSubscriptionControlPort } from "../../adapters/postgres/customerSubscriptionControl.js";
import { expect, it } from "vitest";
import { createM12SelfServiceReferenceBinding } from "./m12SelfServiceBinding.js";

const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: false, refusalCode: "host_binding_required" },
  customer360Read: { supported: false, refusalCode: "host_binding_required" }, invoiceAccess: { supported: false, refusalCode: "host_binding_required" },
  paymentMethodSetup: { supported: false, refusalCode: "unsupported" }, commerceRecovery: { supported: false, refusalCode: "host_binding_required" },
  configuredPurchase: { supported: false, refusalCode: "host_binding_required" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

const context = { principalId: "actor", clientId: "client", graph: "native" as const };
const request = { subscriptionId: "SUBSCRIPTION", action: "update_bundle", payload: { acceptedQuoteHash: "invalid" } };
const pauseRequest = { ...request, action: "pause" }, unsupportedRequest = { ...request, action: "unknown" };
const unsupported = new Error("node_postgres_subscription_edit_action_unsupported");
const missing = new Error("customer_subscription_owner_refused"), quoteError = new Error("quote-invalid");
function fixture(owned = false) {
  const transcript: string[] = [];
  const control = {
    async hasSubscription(principalId: string, id: string) { expect(principalId).toBe("actor"); expect(id).toBe("subscription"); transcript.push("ownership"); return owned; },
    async applyAction(principalId: string, input: typeof request) { expect(principalId).toBe("actor"); if (input.action === "unknown") expect(input).toBe(unsupportedRequest); transcript.push(input.action); if (input.action !== "pause" && input.action !== "update_bundle") throw unsupported; if (input.action === "update_bundle") { expect(input.subscriptionId).toBe("subscription"); throw quoteError; } return null; },
    async previewAction(principalId: string, input: typeof request) { expect(principalId).toBe("actor"); expect(input).toBe(request); transcript.push("preview"); return null; },
    async getSnapshot(principalId: string) { expect(principalId).toBe("actor"); transcript.push("snapshot"); return null; },
  };
  const select = async () => { transcript.push("select"); return { context, capabilities, nativeLegacySubscription: { control, explicitPause: { async applyAction(principalId: string, input: typeof request) { expect(principalId).toBe("actor"); expect(input).toBe(pauseRequest); transcript.push("pause"); return null; } }, ownershipRefusal: () => missing } }; };
  return { transcript, select, control };
}
it.each([undefined, false])("C5 enabled=%s selects no work", enabled => {
  const { select, transcript } = fixture();
  expect(createM12SelfServiceReferenceBinding({ ...(enabled === undefined ? {} : { enabled }), select })).toEqual({ enabled: false });
  expect(transcript).toEqual([]);
});
it("C5 refuses enabled binding without selection", () => {
  expect(() => createM12SelfServiceReferenceBinding({ enabled: true })).toThrow("customer_self_service_lane_configuration_required");
});
it("C5 refuses an incomplete selected native lane", async () => {
  const { select, control } = fixture();
  const broken = createM12SelfServiceReferenceBinding({ enabled: true, select: async () => ({ ...await select(), nativeLegacySubscription: { control, explicitPause: undefined!, ownershipRefusal: () => missing } }) });
  if (!broken.enabled) throw new Error("binding-disabled");
  await expect(broken.select(context)).rejects.toThrow("customer_self_service_lane_configuration_required");
});
it.each(["apply", "preview", "snapshot"] as const)("C5 guards native %s before owner calls", async method => {
  const { select, transcript } = fixture();
  const binding = createM12SelfServiceReferenceBinding({ enabled: true, select });
  if (!binding.enabled) throw new Error("binding-disabled");
  const facade = await binding.select(context); transcript.length = 0;
  const result = method === "apply" ? facade.nativeLegacySubscription.applyAction("foreign", request)
    : method === "preview" ? facade.nativeLegacySubscription.previewAction("foreign", request) : facade.subscriptionControl.getSnapshot("foreign");
  await expect(result).rejects.toThrow("customer_principal_mismatch");
  expect(transcript).toEqual([]);
});
it.each([
  { name: "unowned bundle", owned: false, method: "apply", input: request, error: missing, transcript: ["ownership"] },
  { name: "owned bundle before quote", owned: true, method: "apply", input: request, error: quoteError, transcript: ["ownership", "update_bundle"] },
  { name: "explicit pause", owned: false, method: "apply", input: pauseRequest, error: null, transcript: ["pause"] },
  { name: "other action refusal", owned: false, method: "apply", input: unsupportedRequest, error: unsupported, transcript: ["unknown"] },
  { name: "preview", owned: false, method: "preview", input: request, error: null, transcript: ["preview"] },
  { name: "snapshot", owned: false, method: "snapshot", input: request, error: null, transcript: ["snapshot"] },
])("C5 native routing: $name", async row => {
  const { select, transcript } = fixture(row.owned);
  const binding = createM12SelfServiceReferenceBinding({ enabled: true, select });
  if (!binding.enabled) throw new Error("binding-disabled");
  const facade = await binding.select(context); transcript.length = 0;
  const result = row.method === "apply" ? facade.nativeLegacySubscription.applyAction("actor", row.input)
    : row.method === "preview" ? facade.nativeLegacySubscription.previewAction("actor", row.input) : facade.subscriptionControl.getSnapshot("actor");
  if (row.error) await expect(result).rejects.toBe(row.error); else expect(await result).toBeNull();
  expect(transcript).toEqual(row.transcript);
});
it("C5 compiles reference owner transcriptions and driver fit", () => {
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  const source = program.getSourceFile(file)!;
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);

// Reference source fit is executed by C5 above, using R1's compiler pattern.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type Request = Parameters<CustomerSubscriptionActionPort["applyAction"]>[1];
type PreviewRequest = Parameters<CustomerSubscriptionPreviewPort["previewAction"]>[1];
type Preview = Exclude<Awaited<ReturnType<CustomerSubscriptionPreviewPort["previewAction"]>>, null>;
type Receipt = Exclude<Awaited<ReturnType<CustomerSubscriptionActionPort["applyAction"]>>, null>;
type ControlSnapshot = Awaited<ReturnType<CustomerSubscriptionControlPort["getSnapshot"]>>;
type Parts = NativeLegacySubscriptionParts<Request, PreviewRequest, Preview, Receipt, ControlSnapshot>;
type Facade = SelfServiceCommandFacade<Request, PreviewRequest, Preview, Receipt, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, ControlSnapshot>;
export type ReferenceOwnerFit = [
  Assert<Equal<LegacySubscriptionPort<Request, PreviewRequest, Preview, Receipt>["applyAction"], CustomerSubscriptionActionPort["applyAction"]>>,
  Assert<Equal<LegacySubscriptionPort<Request, PreviewRequest, Preview, Receipt>["previewAction"], CustomerSubscriptionPreviewPort["previewAction"]>>,
  Assert<Fits<CustomerSubscriptionActionPort & CustomerSubscriptionPreviewPort, Facade["nativeLegacySubscription"]>>,
  Assert<Fits<CustomerSubscriptionControlPort, Facade["subscriptionControl"]>>,
  Assert<Equal<Awaited<ReturnType<Facade["subscriptionControl"]["getSnapshot"]>>, ControlSnapshot | AccountSupportLaneUnavailable<"host_binding_required">>>,
  Assert<Equal<Parts["control"]["getSnapshot"], CustomerSubscriptionControlPort["getSnapshot"]>>,
  Assert<Fits<ReturnType<typeof createPostgresCustomerSubscriptionPausePort>, Parts["explicitPause"]>>,
  // Ownership lookup is an injected host seam; the reference control owns these three methods.
  Assert<Fits<PostgresCustomerSubscriptionControlPort, Omit<Parts["control"], "hasSubscription">>>
];
