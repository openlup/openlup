import type { FulfillmentCapabilityDescriptor } from "./capabilities.js";
import type { FulfillmentDispatchPort, FulfillmentDispatchRequest } from "./dispatch.js";
import type { FulfillmentLabelPort } from "./label.js";
import type { FulfillmentObservationPort } from "./observation.js";
import type { FulfillmentReadbackPort } from "./readback.js";
import type { FulfillmentStockSyncProvider, FulfillmentProductSyncProvider } from "./sync.js";
import type { FulfillmentStorePort } from "./store.js";

type Fixture<Method extends (...args: never[]) => unknown> = {
  input: Parameters<Method>; expected: Awaited<ReturnType<Method>>;
};
type SyncFixture<Port> = { [K in keyof Port]: Port[K] extends (...args: never[]) => unknown
  ? { operation: K; input: Parameters<Port[K]>; expected: Awaited<ReturnType<Port[K]>> | { kind: "refused"; refusal: { reason: "unsupported"; phase: "sync"; retryable: false } } } : never }[keyof Port];

/** Offline adapter-owned inputs and exact expected outputs; never real customer data. */
export interface FulfillmentAdapterConformanceSubject {
  subjectId: string;
  adapter: {
    capabilities: FulfillmentCapabilityDescriptor; dispatch: FulfillmentDispatchPort;
    label?: FulfillmentLabelPort; observation?: FulfillmentObservationPort; readback?: FulfillmentReadbackPort;
    stockSync?: FulfillmentStockSyncProvider; productSync?: FulfillmentProductSyncProvider;
  };
  /** Count external submission I/O, including attempted calls. Preparation/refusals must not increase it. */
  readIoCount(): number;
  sensitiveValues: readonly string[];
  fixtures: {
    dispatch: readonly {
      input: FulfillmentDispatchRequest;
      expectedPrepare: Awaited<ReturnType<FulfillmentDispatchPort["prepare"]>>;
      expectedDispatch?: Awaited<ReturnType<FulfillmentDispatchPort["dispatch"]>>;
      /** Repeating this operation must not increase external submission I/O. */
      replay?: boolean;
    }[];
    label?: { create?: readonly Fixture<FulfillmentLabelPort["create"]>[]; read?: readonly Fixture<FulfillmentLabelPort["read"]>[]; void?: readonly Fixture<FulfillmentLabelPort["void"]>[] };
    observation?: readonly Fixture<FulfillmentObservationPort["verifyAndNormalize"]>[];
    readback?: readonly (Fixture<FulfillmentReadbackPort["read"]> & { localMissing?: boolean })[];
    stockSync?: readonly SyncFixture<FulfillmentStockSyncProvider>[];
    productSync?: readonly SyncFixture<FulfillmentProductSyncProvider>[];
  };
  /** A fresh isolated host store per call; no database implementation is supplied by the runner. */
  store?: {
    create(): Promise<FulfillmentStorePort & {
      /** Offline fixture inspection, not a new production store operation. */
      readMappedAttempts(): Promise<readonly {
        attemptKey: string; fulfillmentRef: string;
        preparedEvidence: Parameters<FulfillmentStorePort["recordProviderAttempt"]>[2];
        mode: Parameters<FulfillmentStorePort["recordProviderAttempt"]>[3]; status: "recorded";
      }[]>;
    }>;
    claim: Parameters<FulfillmentStorePort["claim"]>[0];
    remappedClaim: Parameters<FulfillmentStorePort["claim"]>[0];
    mappedAttemptKey: string; remappedAttemptKey: string;
    request: FulfillmentDispatchRequest; remappedRequest: FulfillmentDispatchRequest;
  };
}

/** Sanitized proof only: no fixture inputs, raw responses, transient URLs or credentials. */
export interface FulfillmentAdapterConformanceEvidence {
  subjects: readonly { subjectId: string; providerRef: string }[];
  cases: readonly { subjectId: string; operation: string; passed: true }[];
}
