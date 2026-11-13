/** Private native destination authority; the host authenticates actors and owns connection lifetime. */
export interface DestinationAddress {
  recipientName: string; line1: string; line2?: string | null; city: string; postalCode: string; country: string;
  contactPhone?: string | null; label?: string | null; companyName?: string | null; taxId?: string | null;
  deliveryNotes?: string | null; courierInstructions?: string | null;
}
export type NewDestinationAddress = Pick<DestinationAddress, "recipientName" | "line1" | "city" | "postalCode" | "country"> & { line2?: string; contactPhone?: string };
export interface DestinationDocument { destinationId: string; revision: 1; clientId: string; address: Required<DestinationAddress> }
/** A saved row can be incomplete for a carrier; its immutable snapshot retains that fact. */
export interface SavedDestinationDocument {
  destinationId: string; revision: 1; clientId: string;
  address: Omit<Required<DestinationAddress>, "recipientName"> & { savedAddressId: string; recipientName: string | null };
}
export type DestinationReadDocument = DestinationDocument | SavedDestinationDocument;
export interface SavedShippingAddressSelectionResult {
  status: "applied" | "replayed"; subscriptionId: string; shippingAddressId: string | null;
  subscriptionStatus: string; nextCycleAt: string | null; templateVersion: number; eventId: string;
}
export type DestinationChangeResult = {
  outcome: "applied" | "applied_from_next_parcel"; appliesFrom: "current_parcel" | "next_parcel";
  futureDestinationId: string; replayed: boolean;
  currentParcel: { outcome: "updated" | "skipped"; reason: string | null; orderId: string | null;
    shipmentId: string | null; destinationId: string | null };
} | { outcome: "refused" | "conflict"; refusalCode: string; replayed: boolean };
export interface DestinationQueryExecutor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
/** The shipment reader pins its first destination under the native dispatch lock. Use the same
 * connection as authoritative preparation. Subscription reads lock their parent; retain the
 * transaction through renewal claim. Saved selections snapshot the current address for a new
 * claim; a retained operation keeps its prior immutable destination. No automatic route exists. */
export function createPostgresDestinationPort(db: DestinationQueryExecutor) {
  const invoke = async <T>(name: string, args: unknown[]): Promise<T> => {
    const { rows } = await db.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS result`, args);
    if (rows.length !== 1 || !rows[0]?.result || typeof rows[0].result !== "object") throw new Error("commerce_destination_response_invalid");
    return rows[0].result as T;
  };
  return {
    registerOrder(input: { idempotencyKey: string; orderId: string; address: DestinationAddress; now: string }) {
      return invoke<DestinationDocument>("commerce_register_order_destination", [input.idempotencyKey, input.orderId, JSON.stringify(input.address), input.now]);
    },
    async read(scope: "order" | "subscription" | "shipment", id: string): Promise<DestinationDocument> {
      const document = await invoke<DestinationDocument>("commerce_read_destination", [scope, id]);
      if (document.address?.recipientName === null) throw new Error("commerce_destination_response_invalid");
      return document;
    },
    /** Saved snapshots may retain a null recipient; use this reader when selecting saved addresses. */
    readWithSaved(scope: "order" | "subscription" | "shipment", id: string): Promise<DestinationReadDocument> {
      return invoke<DestinationReadDocument>("commerce_read_destination", [scope, id]);
    },
    /** Replays an existing subscription-event key before parsing/validating the saved ID. */
    selectSavedShippingAddress(input: { actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
      savedAddressId: string; reason?: string; now: string }) {
      return invoke<SavedShippingAddressSelectionResult>("subscription_select_saved_shipping_address", [input.actorId, input.clientId,
        input.idempotencyKey, input.subscriptionId, JSON.stringify({ shippingAddressId: input.savedAddressId,
          ...(input.reason === undefined ? {} : { reason: input.reason }) }), input.now]);
    },
    changeShippingAddress(input: { actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
      newAddress: NewDestinationAddress; expectedVersion: number; reason?: string; now: string }) {
      return invoke<DestinationChangeResult>("subscription_change_shipping_destination", [input.actorId, input.clientId, input.idempotencyKey,
        input.subscriptionId, JSON.stringify({ newAddress: input.newAddress, ...(input.reason === undefined ? {} : { reason: input.reason }) }), input.expectedVersion, input.now]);
    },
  };
}
