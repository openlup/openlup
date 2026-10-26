import { mintCheckoutRefusalContinuation as mint } from "@openlup/platform/commerce/server";
const executionRails = ["stripe", "tpay"] as const;
export function mintCheckoutRefusalContinuation(input: Parameters<typeof mint<(typeof executionRails)[number]>>[0]) { mint(input, executionRails); }
