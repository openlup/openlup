export interface CommerceSalesChannelEnvelope {
  sourceKind: string | null;
  sourceChannelSlug: string | null;
  sourceOrderRef: string | null;
}

export interface CommerceSalesChannelRow {
  source_kind?: string | null;
  source_order_ref?: string | null;
  sales_channels?: { slug: string | null } | null;
}

export function projectCommerceSalesChannelEnvelope(row: CommerceSalesChannelRow): CommerceSalesChannelEnvelope {
  return { sourceKind: row.source_kind ?? null, sourceChannelSlug: row.sales_channels?.slug ?? null,
    sourceOrderRef: row.source_order_ref ?? null };
}

/** Host-bound read only; the inventory owner supplies exposure semantics. */
export type CommerceChannelExposureReadPort = (skuId: string, signal: AbortSignal) => Promise<number>;

export interface OrderBuyerCommsPolicy {
  sourceKind: string;
  buyerCommsOwner: string;
}

export function platformOwnsBuyerEmail(policy: OrderBuyerCommsPolicy | null): boolean {
  return policy === null || policy.buyerCommsOwner !== "channel";
}
