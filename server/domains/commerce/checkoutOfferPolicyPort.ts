import type { CheckoutOfferPolicyPort as OfferPolicyPort } from "@openlup/platform/commerce/contracts";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
export type { CheckoutOfferResolution } from "@openlup/platform/commerce/contracts";
/** Port type only: binding execution belongs to a later checkout composition. */
export type CheckoutOfferPolicyPort = OfferPolicyPort<ConfiguratorIntent, CreateQuoteResponse["quote"]>;
