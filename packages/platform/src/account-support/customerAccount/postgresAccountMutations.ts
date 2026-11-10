import { z } from "zod";
import type { OperatorQueryExecutor } from "../postgresOperatorAuthority.js";
import type { NativeAccountReadScope } from "../postgresAccountReadScope.js";
import type { CustomerAccountMutationPort, CustomerAccountMutationRefusalCode } from "../contracts/mutations.js";
import type { CustomerAccountMutationSchemas } from "./accountMutationSchemas.js";
export class CustomerAccountMutationRefused extends Error {
  constructor(readonly code: CustomerAccountMutationRefusalCode) { super(code); }
}
const events = z.array(z.object({ eventId: z.guid(), eventType: z.string(), entityType: z.string(), entityId: z.guid().nullable(), occurredAt: z.string().datetime({ offset: true }) }).strict());
/** Query calls are separate commits: do not wrap profile update plus append in a host transaction. */
export function createPostgresCustomerAccountMutationPort(executor: OperatorQueryExecutor, scope: NativeAccountReadScope,
  schemas: CustomerAccountMutationSchemas, now: () => string): CustomerAccountMutationPort {
  const { principalId, clientId } = scope;
  if (![principalId, clientId].every(id => z.guid().safeParse(id).success)) throw new Error("native_account_scope_invalid");
  function verify(userId: string) {
    if (userId.toLowerCase() !== principalId.toLowerCase()) throw new CustomerAccountMutationRefused("customer_principal_mismatch");
  }
  async function call(sql: string, values: unknown[]) { return (await executor.query(sql, values)).rows[0]?.result ?? null; }
  const identity = [principalId, clientId];
  return {
    async updateProfile(userId, input) {
      verify(userId);
      const parsed = schemas.profileRequest.safeParse(input);
      if (!parsed.success) throw new CustomerAccountMutationRefused("customer_account_invalid_input");
      const at = now(), value = await call("SELECT public.customer_account_profile_update($1,$2,$3::jsonb,$4::timestamptz) AS result", [...identity, JSON.stringify(parsed.data), at]);
      if (value === null) return null;
      const { replayed, ...response } = value as Record<string, unknown>;
      if (typeof replayed !== "boolean") throw new Error("customer_account_response_invalid");
      const result = schemas.profileResponse.parse(response);
      if (!replayed) {
        const event = await call("SELECT public.customer_account_event_append($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) AS result",
          [...identity, "customer.profile_updated", "client", result.profile.clientId, JSON.stringify(parsed.data), at]);
        if (event === null) throw new Error("customer_account_event_append_failed");
      }
      return result;
    },
    async requestInvoiceCorrection(userId, input) {
      verify(userId);
      const parsed = schemas.correctionRequest.safeParse(input);
      if (!parsed.success) throw new CustomerAccountMutationRefused("customer_account_invalid_input");
      const { invoiceId, ...request } = parsed.data;
      const result = await call("SELECT public.customer_invoice_correction_request($1,$2,$3,$4::jsonb,$5::timestamptz) AS result", [...identity, invoiceId, JSON.stringify(request), now()]);
      return result === null ? null : schemas.correctionResponse.parse(result);
    },
    async readEvents(userId) {
      verify(userId);
      const result = await call("SELECT public.customer_account_event_history($1,$2) AS result", identity);
      return result === null ? null : events.parse(result);
    },
  };
}
