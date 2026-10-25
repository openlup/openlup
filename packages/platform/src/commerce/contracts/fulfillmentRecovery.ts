// Commerce fulfillment recovery evidence shared by OMS reads and host projections.
export type TimedFulfillmentSignal = {
    id?: undefined | null | string;
    token: undefined | null | string;
    occurredAt: undefined | null | string;
};
export type ReleasedProviderExceptionHold = {
    orderId: undefined | null | string;
    status: undefined | null | string;
    reason: undefined | null | string;
    createdBy: undefined | null | string;
    releasedBy: undefined | null | string;
    metadata: unknown;
};
export type ProviderStatusEvidence = {
    fulfillmentOrderId: undefined | null | string;
    providerStatus: undefined | null | string;
    localStatus: undefined | null | string;
    id?: undefined | null | string;
    token: undefined | null | string;
    occurredAt: undefined | null | string;
};
export type ResolvedProviderExceptionRecovery = {
    clearedExceptionEvidenceIds: ReadonlySet<string>;
    recoveryEvidenceIds: ReadonlySet<string>;
};
