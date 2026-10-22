import type { FulfillmentServices, FulfillmentServicesOptions } from './contracts/index.js';
import { FULFILLMENT_NATIVE_UNSUPPORTED } from './nativeUnsupported.js';
import { readFulfillmentCapabilities } from './providerCapabilities.js';
import { runFulfillmentDispatchWorker } from './providerDispatchWorker.js';

/** Explicit selection; no environment readers, implicit provider or automatic dispatch. */
export function createFulfillmentServices(options: FulfillmentServicesOptions): FulfillmentServices {
  const { enabled, selection, capability, store, provider, readiness: observe, listCandidates, now } = options;
  const config = { ...options.config }, keys = { ...options.keys };
  const readiness: FulfillmentServices['readiness'] = async () => {
    if (enabled !== true) return { ready: false, refusal: { reason: 'disabled', phase: 'selection', retryable: false } };
    const selected = readFulfillmentCapabilities(capability ? [capability] : [], selection);
    if (selected.kind === 'refused') return { ready: false, refusal: selected.refusal };
    if (!selected.descriptor.operations.dispatch.supported) return { ready: false, refusal: { reason: 'unsupported', phase: 'selection', retryable: false } };
    if (!store || !provider) return { ready: false, refusal: FULFILLMENT_NATIVE_UNSUPPORTED };
    return observe();
  };
  return {
    readiness,
    async runDispatch() {
      const state = await readiness();
      if (!state.ready) return 'kind' in state.refusal ? state.refusal : { kind: 'refused', refusal: state.refusal };
      return runFulfillmentDispatchWorker({ store: store!, provider, listCandidates, keys, config, now });
    },
  };
}
