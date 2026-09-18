import type { ChannelBundleReadPort } from "../../../src/domains/channels/bundleLineExpansion.js";
import { createManagedBundleCatalogStore } from "./bundleCatalogStore.js";

/**
 * The bundle catalogue, narrowed to the two facts a channel order needs.
 *
 * It lives in the ADAPTER layer rather than in the channels domain, and that placement is enforced
 * rather than chosen: `server/domains/bundle` is not a public cross-domain segment, so a channels
 * module that imported its read port would be refused by the architecture guard — correctly, since
 * that is exactly the coupling the guard exists to stop. Composition is allowed to know both sides;
 * a domain is not.
 *
 * It reads the ACTIVE feed rather than looking a code up. `getBundle` would answer for a draft or an
 * archived bundle, and a marketplace order for something this shop has stopped selling must be
 * operator work rather than a silently accepted order. Reading only what the catalogue can sell
 * today makes "unknown code" and "no longer sellable" the same refusal, which is right for both.
 */
export function createChannelBundleRead(
  port: ReturnType<typeof createManagedBundleCatalogStore>,
): ChannelBundleReadPort {
  return {
    async readActiveBundleCompositions(input) {
      const compositions = await port.listActiveBundleCompositions({ currency: input.currency });
      return compositions.map((composition) => ({
        bundleCode: composition.code,
        components: composition.components.map((component) => ({
          skuCode: component.sku,
          quantity: component.quantity,
          referenceUnitPriceMinor: component.referenceUnitPriceMinor,
        })),
      }));
    },
  };
}
