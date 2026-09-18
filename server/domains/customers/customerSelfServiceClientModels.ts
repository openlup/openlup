import type {
  CustomerAccountResponse,
  CustomerSubscriptionActionRequest,
} from "../../../src/domains/customers/selfServiceContracts.js";

export function mapProfile(row: Record<string, unknown>): CustomerAccountResponse["profile"] {
  return {
    clientId: text(row.id),
    email: text(row.email),
    firstName: nullableText(row.first_name),
    lastName: nullableText(row.last_name),
    phone: nullableText(row.phone),
    lifecycleStage: text(row.lifecycle_stage) as CustomerAccountResponse["profile"]["lifecycleStage"],
  };
}

export function subscriptionActionPayload(
  input: CustomerSubscriptionActionRequest & { protocolSourceAction?: string },
): Record<string, unknown> {
  const {
    idempotencyKey: _idempotencyKey,
    subscriptionId: _subscriptionId,
    action: _action,
    protocolSourceAction: _protocolSourceAction,
    ...payload
  } = input;
  return payload;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
