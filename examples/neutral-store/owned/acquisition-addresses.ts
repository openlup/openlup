import type { AcquisitionAddressReference } from '@openlup/platform/marketing/contracts';
import type { Localized } from '../shared/config.ts';

/** Adopter-owned fictional registry, loaded by the marked install connection only.
 * Contract: acquisition_case_foundation migration header, owner-loaded registry.
 * These opaque values represent no real address and carry no delivery promise.
 */
export const acquisitionAddresses: readonly {
  id: string; label: Localized; addressReference: AcquisitionAddressReference;
}[] = [{
  id: 'demo-location',
  label: { en: 'Fictional demonstration location', pl: 'Fikcyjna lokalizacja demonstracyjna' },
  addressReference: { source: 'neutral_demo', reference: 'demo-address:location-01',
    revision: 'v1', provenance: 'owned_demo_seed' },
}];
