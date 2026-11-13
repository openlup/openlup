import { z } from "zod";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";
import type { PaymentRepairMethodPort } from "./contracts/repair.js";

const ownerSchema = z.object({ clientId: z.uuid(), subscriptionId: z.uuid(), providerCustomerRef: z.string().nullable() });
/** Ownership is resolved before any provider I/O; collection handoff stays transient. */
export function createPostgresPaymentMethodSetup(db: PaymentProviderExecutor, input: {
  enabled: () => boolean;
  methodPort: PaymentRepairMethodPort;
  ensureCustomer(input: { clientId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<string>;
}) {
  return { async execute(principalId: string, request: { subscriptionId: string; idempotencyKey: string }) {
    if (!input.enabled()) return { kind: "disabled" } as const;
    if (!z.object({ subscriptionId: z.uuid(), idempotencyKey: z.string().min(1) }).safeParse(request).success) return { kind: "invalid" } as const;
    if (!z.uuid().safeParse(principalId).success) return { kind: "forbidden", reason: "subscription_not_owned_or_missing" } as const;
    const value = (await db.query("SELECT public.payment_method_setup_resolve_owner($1::uuid,$2::uuid) AS response", [principalId, request.subscriptionId])).rows[0]?.response;
    if (value == null) return { kind: "forbidden", reason: "subscription_not_owned_or_missing" } as const;
    const owner = ownerSchema.parse(value);
    const metadata = { clientId: owner.clientId, subscriptionId: owner.subscriptionId, source: "account.card-update" };
    const customer = owner.providerCustomerRef ?? await input.ensureCustomer({ clientId: owner.clientId, metadata,
      idempotencyKey: `account-card-customer:${owner.subscriptionId}:${request.idempotencyKey}` });
    return input.methodPort.setupMethod({ customer, metadata, idempotencyKey: `account-card-setup:${owner.subscriptionId}:${request.idempotencyKey}` });
  } };
}
