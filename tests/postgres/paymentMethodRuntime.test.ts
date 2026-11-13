import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresPaymentMethodSetup, createPostgresPaymentWebhookControlPort, createPostgresPaymentWebhookMethodRefPort,
  createVerifiedPaymentIngress, consumePostgresPaymentMethodDelivery, createPostgresRecordedSubscriptionMethodReader,
  createPostgresPaymentMethodStore, paymentSchemaDescriptor } from "@openlup/platform/payments";
import type { VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { storeJourneyResources, assertJourneyRuntime } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { call } from "./subscriptionNativeFixture.js";

const AT = "2026-11-13T12:00:00.000Z";

const runtimeResources = storeJourneyResources();
afterAll(async () => { await runtimeResources.close(); }, postgresTeardownTimeoutMs);
it("accepts method setup, account support and verified method ingress on the installed qualified-v2 runtime roles", async () => {
  const { runtime } = await runtimeResources.installation("method-runtime");
  await assertJourneyRuntime(runtime);
  expect(paymentSchemaDescriptor.methodSetup).toBe("supported");
  const principal = randomUUID(), subscription = randomUUID();
  await runtime.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
  const client = (await runtime.query("INSERT INTO public.clients(email,principal_id,acquisition_source,lifecycle_stage) VALUES($1,$2,'synthetic','customer') RETURNING id", [`${principal}@example.invalid`, principal])).rows[0].id;
  await runtime.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, AT]);
  const trace: string[] = [];
  const lane = createPostgresPaymentMethodSetup(runtime, { enabled: () => true, ensureCustomer: async input => { trace.push(input.idempotencyKey); return "runtime-customer"; },
    methodPort: { async setupMethod(input) { trace.push(input.idempotencyKey); return { kind: "ready", setupRef: "runtime-setup", handoff: { kind: "client-confirmed", payload: "transient" as never }, replayed: false }; } } });
  expect(await lane.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign" })).toMatchObject({ kind: "forbidden" });
  expect(trace).toEqual([]);
  const unavailable = { supported: false, refusalCode: "host_binding_required" } as const;
  const facade = createSelfServiceCommandFacade({ context: { principalId: principal, clientId: client, graph: "native" },
    capabilities: { graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
      paymentMethodSetup: { supported: true }, commerceRecovery: unavailable, configuredPurchase: unavailable,
      operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
      subscriptions: { ...NATIVE_SUBSCRIPTION_CAPABILITIES, genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" }, commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" } },
      communicationGifts: { supported: false, refusalCode: "unsupported_preference" } }, paymentMethod: lane });
  expect(facade.capabilities.paymentMethodSetup).toEqual({ supported: true });
  expect(await facade.paymentMethod.execute(principal, { subscriptionId: subscription, idempotencyKey: "runtime" })).toMatchObject({ kind: "ready" });
  expect(trace).toEqual([`account-card-customer:${subscription}:runtime`, `account-card-setup:${subscription}:runtime`]);
  await expect(facade.paymentMethod.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign" })).rejects.toThrow("customer_principal_mismatch");
  const evidence: VerifiedMethodEvidence = { provider: "card_rail", providerEventId: randomUUID(), fingerprint: "b".repeat(64), providerOccurredAt: AT,
    kind: "method", outcome: "registered", methodRef: "runtime-method", setupRef: "runtime-setup", intentRef: null,
    reusableMethod: { providerCustomerRef: "runtime-customer", providerMethodRef: "runtime-method", methodKind: "card", status: "active", consentSnapshot: { source: "setup" } } };
  const webhook = createPostgresPaymentWebhookControlPort(runtime, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const closed: boolean[] = [];
  const ingress = createVerifiedPaymentIngress({ provider: "card_rail", verifyPort: { async verifyAndNormalize() { return evidence; } },
    paymentControlPort: { ...webhook, async markSetupEventProcessed(input) {
      const result = await webhook.markSetupEventProcessed!(input); closed.push(result.updated); return result;
    } },
    resolveMethodOwner: async () => ({ clientId: client, subscriptionId: subscription }), methodRefPort: createPostgresPaymentWebhookMethodRefPort(runtime),
    afterProcessed: async ({ event }) => consumePostgresPaymentMethodDelivery(runtime, event) });
  for (let n = 0; n < 2; n++) expect((await ingress.receive({ rawBody: new Uint8Array(), headers: {}, receivedAt: AT })).status).toBe(200);
  expect(await createPostgresRecordedSubscriptionMethodReader(runtime).read(subscription)).toMatchObject({ kind: "recorded", methodRef: "runtime-method", customerRef: "runtime-customer" });
  const recorded = await createPostgresPaymentMethodStore(runtime).read("card_rail", "runtime-method");
  expect(recorded).toMatchObject({ client_id: client, subscription_id: subscription });
  expect(closed).toEqual([true, false]);
  for (const table of ["payment_method_refs", "payment_method_ref_receipts", "payment_method_recovery_authorities"]) {
    await expect(runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
  }
  await expect(call(runtime, "payment_method_recovery_authority_record", [randomUUID(), randomUUID()])).rejects.toThrow("payment_method_recovery_authority_context_mismatch");
  await expect(call(runtime, "payment_method_recovery_authority_bind", [randomUUID(), randomUUID(), "outside-purpose", "evidence", AT])).rejects.toThrow("subscription_retry_recovery_not_authorized");
  await expect(call(runtime, "payment_method_recovery_authority_freeze", [randomUUID(), randomUUID(), "outside-purpose", "method", AT])).rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
  await assertJourneyRuntime(runtime);
});
