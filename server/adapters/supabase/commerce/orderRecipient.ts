import type { OrderRecipient, OrderRecipientPort } from "../../../domains/commerce/outboxOrderDraftEmailPorts.js";

export interface OrderRecipientSupabaseClient {
  from(table: string): OrderRecipientQueryBuilder;
}

interface OrderRecipientQueryBuilder {
  select(columns: string): OrderRecipientQueryBuilder;
  eq(column: string, value: unknown): OrderRecipientQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function petNameFromMetadata(value: unknown): string | null {
  const metadata = record(value);
  const runtimeFinalize = record(metadata.runtimeFinalize);
  const petSnapshot = record(metadata.petSnapshot);
  return nonEmptyString(metadata.petName)
    ?? nonEmptyString(runtimeFinalize.petName)
    ?? nonEmptyString(petSnapshot.name);
}

export function createSupabaseOrderRecipientPort(
  client: OrderRecipientSupabaseClient,
): OrderRecipientPort {
  return {
    // The signal is accepted per the port contract but not wired into the
    // queries: the repo's supabase usage never passes abortSignal, and the
    // worker-side timeout race is the backstop for a hung query.
    async resolve(orderUuid: string, _signal: AbortSignal): Promise<OrderRecipient | null> {
      const orderResult = await client
        .from("commerce_orders")
        .select("client_id, pet_id, metadata")
        .eq("id", orderUuid)
        .maybeSingle();
      if (orderResult.error) {
        throw new Error(
          `outbox_recipient_order_read_failed: ${orderResult.error.message ?? orderResult.error.code ?? "unknown"}`,
        );
      }
      const order = orderResult.data as {
        client_id?: string | null;
        pet_id?: string | null;
        metadata?: unknown;
      } | null;
      if (!order || typeof order.client_id !== "string" || order.client_id === "") return null;

      const clientResult = await client
        .from("clients")
        .select("email, first_name, country")
        .eq("id", order.client_id)
        .maybeSingle();
      if (clientResult.error) {
        throw new Error(
          `outbox_recipient_client_read_failed: ${clientResult.error.message ?? clientResult.error.code ?? "unknown"}`,
        );
      }
      const recipient = clientResult.data as {
        email?: string | null;
        first_name?: string | null;
        country?: string | null;
      } | null;
      if (!recipient || typeof recipient.email !== "string" || recipient.email === "") return null;

      let petName = petNameFromMetadata(order.metadata);
      const petId = nonEmptyString(order.pet_id);
      if (petName === null && petId !== null) {
        try {
          const petResult = await client
            .from("pets")
            .select("name")
            .eq("id", petId)
            .eq("client_id", order.client_id)
            .maybeSingle();
          // Pet-name personalization is cosmetic. Missing rows and transient pet
          // read failures degrade to generic copy instead of blocking delivery.
          if (!petResult.error) {
            petName = nonEmptyString((petResult.data as { name?: unknown } | null)?.name);
          }
        } catch {
          petName = null;
        }
      }

      return {
        email: recipient.email,
        firstName: typeof recipient.first_name === "string" && recipient.first_name !== ""
          ? recipient.first_name
          : null,
        country: typeof recipient.country === "string" && recipient.country !== ""
          ? recipient.country
          : null,
        petName,
      };
    },
  };
}
