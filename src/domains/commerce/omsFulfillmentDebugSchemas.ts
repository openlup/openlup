import { defaultOmsFulfillmentDebug as neutralDefault } from "@openlup/platform/commerce";
export { omsFulfillmentDebugSchema, omsFulfillmentDebugStepSchema } from "@openlup/platform/commerce";
export type { OmsFulfillmentDebug } from "@openlup/platform/commerce/contracts";

export const defaultOmsFulfillmentDebug = { ...neutralDefault, summary: "Brak danych fulfillmentu." };
