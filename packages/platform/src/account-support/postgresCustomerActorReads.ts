import { z } from "zod";
import type { NativeCustomerSubscriptionSnapshot, NativeCustomerNewsletterPreferences } from "./contracts/account.js";
z.config({ jitless: true });

/** Must already be bound to the verified actor through DataGatewayPort.asActor. */
export interface NativeAccountRpcExecutor {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}
const instant = z.string().datetime({ offset: true });
const money = z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().trim().length(3) }).strict();
const snapshotSchema = z.object({
  contractVersion: z.literal("customer.subscription_control.v1"),
  subscriptions: z.array(z.object({
    subscriptionId: z.guid(), status: z.enum(["pending_activation", "active", "paused", "cancelled", "activation_failed", "completed"]),
    cadenceDays: z.number().int().positive().max(90), nextCycleAt: instant.nullable(), editCutoffAt: instant.nullable(),
    templateVersion: z.number().int().positive(), recurringTotal: money.nullable(),
    lines: z.array(z.object({ variantId: z.guid(), quantity: z.number().int().positive().max(99),
      isAddon: z.boolean(), sortOrder: z.number().int().nonnegative() }).strict()).max(18),
  }).strict()),
}).strict();
const preferenceSchema = z.object({
  contractVersion: z.literal("customer.communication_preferences.v1"),
  contact: z.object({ contactId: z.string().min(1), email: z.email() }).nullable(),
  marketingNewsletter: z.object({ purpose: z.literal("marketing_newsletter"),
    state: z.enum(["unknown", "granted", "denied", "suppressed"]), granted: z.boolean(),
    source: z.string().nullable(), reason: z.string().nullable(), capturedAt: instant.nullable(), updatedAt: instant.nullable() }),
});

/** Read-only A129 access. Existing root action/preview constructors are untouched. */
export function createPostgresCustomerSubscriptionSnapshotPort(gateway: NativeAccountRpcExecutor) {
  return { async getSnapshot(): Promise<NativeCustomerSubscriptionSnapshot | null> {
    const { data, error } = await gateway.rpc("customer_subscription_control_snapshot_as_actor");
    if (error) throw error;
    return data === null ? null : snapshotSchema.parse(data);
  } };
}
/** Current SQL can read newsletter choices and withdraw. It cannot establish a grant. */
export function createPostgresCustomerNewsletterPreferencesPort(gateway: NativeAccountRpcExecutor) {
  return {
    async getPreferences(): Promise<NativeCustomerNewsletterPreferences | null> {
      const { data, error } = await gateway.rpc("customer_communication_preferences_as_actor");
      if (error) throw error;
      return data === null ? null : readPreferences(data);
    },
    async withdrawNewsletter(): Promise<NativeCustomerNewsletterPreferences | null> {
      const { data, error } = await gateway.rpc("customer_communication_preferences_set_as_actor", { p_marketing_newsletter_consent: false });
      if (error) throw error;
      return data === null ? null : readPreferences(data);
    },
  };
}

function readPreferences(data: unknown): NativeCustomerNewsletterPreferences {
  const preferences = preferenceSchema.parse(data);
  // The current actor reader projects a saved true flag as granted, without
  // evaluator evidence. Do not expose that flag as an effective consent grant.
  if (preferences.marketingNewsletter.granted || preferences.marketingNewsletter.state === "granted") {
    throw Object.assign(new Error("host_binding_required"), { code: "host_binding_required", section: "newsletterConsent" });
  }
  return preferences;
}
