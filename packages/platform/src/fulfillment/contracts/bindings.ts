import type { FulfillmentCapabilityDescriptor } from './capabilities.js';
import type { FulfillmentDispatchPort, FulfillmentDispatchRequest, FulfillmentRefusal, FulfillmentSelection } from './dispatch.js';
import type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
import type { DispatchRecord, FulfillmentStorePort } from './store.js';

/** In-memory ports and host closures only; never serialize options or recipient inputs. */
export interface FulfillmentServicesOptions {
  enabled?: boolean;
  selection: FulfillmentSelection | null;
  capability: FulfillmentCapabilityDescriptor | null;
  store: FulfillmentStorePort | null;
  provider: FulfillmentDispatchPort | null;
  readiness(): Promise<{ ready: true } | { ready: false; refusal: FulfillmentRefusal | FulfillmentNativeUnsupported }>;
  listCandidates(limit: number): Promise<readonly FulfillmentDispatchRequest[]>;
  keys: {
    request(candidate: FulfillmentDispatchRequest): string;
    mappedAttempt(requestKey: string, mappedAttemptIndex: number): string;
    acceptance(fulfillmentRef: string): { providerAttemptKey: string; labelKey: string };
  };
  config: { mode: DispatchRecord['mode']; batchLimit: number };
  now?: () => Date;
}
/** Import and construction are inert. Every invocation checks activation before any worker. */
export interface FulfillmentServices {
  readiness(): ReturnType<FulfillmentServicesOptions['readiness']>;
  runDispatch(): Promise<FulfillmentNativeUnsupported | { kind: 'refused'; refusal: FulfillmentRefusal } | {
    ok: boolean; skipped: boolean; checked: number; updated: number; failures: number;
    mode: DispatchRecord['mode']; replayed: number; providerCalls: number; readBacks: number; reason: string | undefined;
  }>;
}
