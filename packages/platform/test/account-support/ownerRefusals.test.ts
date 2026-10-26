import ts from "typescript";
import { fileURLToPath } from "node:url";
import type { AccountSupportCapabilities } from "@openlup/platform/account-support/contracts";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { expect, it } from "vitest";
import type { PaymentMethodHandoff, PaymentRepairMethodPort } from "@openlup/platform/payments/contracts";
import type { NativeSubscriptionCommand as OwnerNativeCommand, createPostgresSubscriptionCommandStore, createPostgresSubscriptionCommands } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand as OwnerCommand, SubscriptionCommandReceipt as OwnerReceipt, SubscriptionCommandRefusal as OwnerRefusal, SubscriptionUnsupported as OwnerUnsupported } from "@openlup/platform/subscriptions/contracts";
import { createSelfServiceCommandFacade, type NativeSubscriptionCommand, type RawSubscriptionCommands, type MethodSetupInput, type MethodSetupResult, type MethodSetupPort, type SubscriptionCommand, type SubscriptionCommandReceipt, type SubscriptionCommandRefusal, type SubscriptionUnsupported, type SelfServiceCommandFacade } from "../../src/account-support/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
type Both<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
/** Strict equality and mutual fit use packaged owners only. Other new types are composition,
 * not owner transcriptions; NativeSubscriptionPreview is a checked subset of the raw record. */
export type OwnerFit = [
  Assert<Equal<NativeSubscriptionCommand, OwnerNativeCommand>>, Assert<Both<NativeSubscriptionCommand, OwnerNativeCommand>>,
  Assert<Equal<RawSubscriptionCommands, ReturnType<typeof createPostgresSubscriptionCommandStore>>>,
  Assert<Both<RawSubscriptionCommands, ReturnType<typeof createPostgresSubscriptionCommandStore>>>,
  Assert<Equal<MethodSetupInput, Parameters<PaymentRepairMethodPort["setupMethod"]>[0]>>,
  Assert<Both<MethodSetupInput, Parameters<PaymentRepairMethodPort["setupMethod"]>[0]>>,
  Assert<Equal<MethodSetupResult<PaymentMethodHandoff>, Awaited<ReturnType<PaymentRepairMethodPort["setupMethod"]>>>>,
  Assert<Both<MethodSetupResult<PaymentMethodHandoff>, Awaited<ReturnType<PaymentRepairMethodPort["setupMethod"]>>>>,
  Assert<Equal<MethodSetupPort<PaymentMethodHandoff>, PaymentRepairMethodPort>>, Assert<Both<MethodSetupPort<PaymentMethodHandoff>, PaymentRepairMethodPort>>,
  Assert<Equal<SubscriptionCommand, OwnerCommand>>, Assert<Both<SubscriptionCommand, OwnerCommand>>,
  Assert<Equal<SubscriptionCommandReceipt, OwnerReceipt>>, Assert<Both<SubscriptionCommandReceipt, OwnerReceipt>>,
  Assert<Equal<SubscriptionCommandRefusal, OwnerRefusal>>, Assert<Both<SubscriptionCommandRefusal, OwnerRefusal>>,
  Assert<Equal<SubscriptionUnsupported, OwnerUnsupported>>, Assert<Both<SubscriptionUnsupported, OwnerUnsupported>>,
  Assert<ReturnType<typeof createPostgresSubscriptionCommands> extends NonNullable<SelfServiceCommandFacade<unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown>["nativeSubscription"]> ? true : false>
];

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
const unconfigured: AccountSupportCapabilities = { ...capabilities, subscriptions: {
  ...capabilities.subscriptions,
  genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" },
  commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" },
} };
const command: SubscriptionCommand = { actor: { kind: "customer", actorId: "actor", clientId: "client" }, subscriptionId: "subscription", idempotencyKey: "key", now: "at", action: "pause", pausePreset: "indefinite", reason: null, survey: null, saveOffer: null };
const rawCommand: NativeSubscriptionCommand = { actorId: "actor", clientId: "client", subscriptionId: "subscription", idempotencyKey: "raw-key", now: "at", action: "update_cadence", payload: { cadenceDays: 21 } };
const edit: Extract<SubscriptionCommand, { action: "edit_future_terms" }> = { actor: command.actor, subscriptionId: "subscription", idempotencyKey: "edit", now: "at", action: "edit_future_terms", shippingAddressId: "address", planDays: 7, cadenceDays: 21, expectedTemplateVersion: 1, acceptedQuoteHash: "", confirmedChargeTiming: false, coreLines: [], addonLines: [], compositionConstraint: "units" };
const typed: SubscriptionCommandRefusal = { outcome: "refused", reason: "subscription_command_pause_forbidden" };
const raw = { status: "refused", reason: "subscription_command_unsupported_action", diagnostic: "owner" };
function selected() {
  let calls = 0;
  const fail = async () => { throw new Error("fallback-called"); };
  const facade = createSelfServiceCommandFacade({ context, capabilities,
    nativeLegacySubscription: { explicitPause: { applyAction: fail }, control: { applyAction: fail, previewAction: fail, hasSubscription: fail, getSnapshot: fail }, ownershipRefusal: fail },
    nativeSubscription: { apply: async () => { calls++; return typed; }, preview: async () => { calls++; return typed; } },
    nativeRawSubscription: { apply: async () => { calls++; return raw; }, preview: async () => { calls++; return raw; } },
  });
  return { facade, calls: () => calls };
}

it.each(["typed apply", "typed preview", "raw apply", "raw preview"] as const)("C4 preserves the %s owner refusal", async lane => {
  const { facade, calls } = selected();
  const result = lane === "typed apply" ? await facade.nativeSubscription.apply(command)
    : lane === "typed preview" ? await facade.nativeSubscription.preview(edit)
    : lane === "raw apply" ? await facade.nativeRawSubscription.apply(rawCommand) : await facade.nativeRawSubscription.preview(rawCommand);
  expect(result).toBe(lane.startsWith("typed") ? typed : raw);
  expect(calls()).toBe(1);
});

it.each(["typed apply", "typed preview", "raw apply", "raw preview"].flatMap(lane =>
  ["foreign actor", "foreign client", "omitted client"].map(identity => ({ lane, identity }))))("C4 guards $lane with $identity", async ({ lane, identity }) => {
  const { facade, calls } = selected();
  const actor = { ...command.actor };
  if (identity === "foreign actor") actor.actorId = "foreign";
  if (identity === "foreign client") actor.clientId = "foreign";
  if (identity === "omitted client") delete (actor as Partial<typeof actor>).clientId;
  const native = { ...rawCommand, actorId: actor.actorId, clientId: actor.clientId };
  if (identity === "omitted client") delete (native as Partial<typeof native>).clientId;
  const result = lane === "typed apply" ? facade.nativeSubscription.apply({ ...command, actor })
    : lane === "typed preview" ? facade.nativeSubscription.preview({ ...edit, actor })
    : lane === "raw apply" ? facade.nativeRawSubscription.apply(native) : facade.nativeRawSubscription.preview(native);
  await expect(result).rejects.toThrow("customer_principal_mismatch");
  expect(calls()).toBe(0);
});

it.each(["subscription", "account", "payment method", "commerce"] as const)("C4 unconfigured %s family returns named refusals before any owner call", async family => {
  let calls = 0;
  const owner = async () => { calls++; return null; };
  // A selected unrelated owner detects any accidental cross-lane fallback.
  const facade = createSelfServiceCommandFacade({ context, capabilities: unconfigured,
    ...(family === "account" ? { nativeRawSubscription: { apply: async () => { calls++; return raw; }, preview: async () => { calls++; return raw; } } }
      : { profile: { updateProfile: owner } }),
  });
  const methods = family === "subscription" ? [
    (id: string) => facade.managedSubscription.applyAction(id, { subscriptionId: "s", action: "cancel" }),
    (id: string) => facade.managedSubscription.previewAction(id, {}),
    (id: string) => facade.nativeLegacySubscription.applyAction(id, { subscriptionId: "s", action: "cancel" }),
    (id: string) => facade.nativeLegacySubscription.previewAction(id, {}),
    (id: string) => facade.subscriptionControl.getSnapshot(id),
    (id: string) => facade.nativeRawSubscription.apply({ ...rawCommand, actorId: id }),
    (id: string) => facade.nativeRawSubscription.preview({ ...rawCommand, actorId: id }),
    (id: string) => facade.nativeSubscription.apply({ ...command, actor: { ...command.actor, actorId: id } }),
    (id: string) => facade.nativeSubscription.preview({ ...edit, actor: { ...edit.actor, actorId: id } }),
  ] : family === "account" ? [
    (id: string) => facade.profile.updateProfile(id, {}), (id: string) => facade.recovery.startPaymentRecovery(id, {}),
  ] : family === "payment method" ? [(id: string) => facade.paymentMethod.execute(id, {})] : [(id: string) => facade.commerce.execute(id, {})];
  let first: unknown;
  for (const run of methods) {
    await expect(run("foreign")).rejects.toThrow("customer_principal_mismatch");
    const result = await run("actor");
    expect(result).toEqual({ supported: false, refusalCode: family === "payment method" ? "unsupported" : "host_binding_required" });
    if (family === "payment method") expect(result).toBe(unconfigured.paymentMethodSetup);
    else if (family === "commerce") expect(result).toBe(unconfigured.commerceRecovery);
    else { expect(Object.isFrozen(result)).toBe(true); if (first) expect(result).toBe(first); first = result; }
  }
  expect(facade.capabilities).toBe(unconfigured);
  expect(facade.capabilities.paymentMethodSetup).toBe(unconfigured.paymentMethodSetup);
  expect(facade.capabilities.commerceRecovery).toBe(unconfigured.commerceRecovery);
  expect(facade.capabilities.configuredPurchase).toBe(unconfigured.configuredPurchase);
  expect(calls).toBe(0);
});

it.each(["paymentMethodSetup", "commerceRecovery", "configuredPurchase", "genericBundleCommands", "commandBoundReceipts"] as const)("C4 refuses supported %s without its lane", capability => {
  const claimed: AccountSupportCapabilities = capability === "genericBundleCommands" || capability === "commandBoundReceipts"
    ? { ...unconfigured, subscriptions: { ...unconfigured.subscriptions, [capability]: { supported: true } } }
    : { ...unconfigured, [capability]: { supported: true } };
  expect(() => createSelfServiceCommandFacade({ context, capabilities: claimed })).toThrow("customer_self_service_lane_configuration_required");
});

it("C4 refuses a graph mismatch", () => {
  expect(() => createSelfServiceCommandFacade({ context, capabilities: { ...unconfigured, graph: "managed" } })).toThrow("customer_graph_mismatch");
});

it("C4 compiles packaged owner equality and facade fit", () => {
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
