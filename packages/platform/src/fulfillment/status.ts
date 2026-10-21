type FulfillmentDisplayStatus = "shipped" | "in_transit" | "delivered";
const SHIPMENT_SORT_ORDER: Record<FulfillmentDisplayStatus, number> = {
  shipped: 0,
  in_transit: 1,
  delivered: 2,
};

export function fulfillmentDisplayStatus(status: string): FulfillmentDisplayStatus {
  if (status === "shipped" || status === "in_transit") return status;
  return "delivered";
}

export function shipmentDate(input: {
  status: string;
  statusUpdatedAt: string | null;
  deliveredAt: string | null;
}): string | null {
  if (fulfillmentDisplayStatus(input.status) === "delivered") {
    return input.deliveredAt ?? input.statusUpdatedAt ?? null;
  }
  return input.statusUpdatedAt ?? null;
}

export function shipmentSortKey(input: {
  status: string;
  statusUpdatedAt: string | null;
  deliveredAt: string | null;
}): number {
  const displayStatus = fulfillmentDisplayStatus(input.status);
  const group = SHIPMENT_SORT_ORDER[displayStatus];
  const date = shipmentDate(input);
  const time = date ? new Date(date).getTime() : 0;

  return group === 2 ? group * 1e15 - time : group * 1e15 + (1e15 - time);
}
