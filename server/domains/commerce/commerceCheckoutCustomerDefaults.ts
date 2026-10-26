import { bffResponder } from "../../_lib/bff/response.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { readCheckoutCustomerDefaults as read, readCheckoutCustomerDefaultsOrRespond as readOrRespond } from "@openlup/platform/commerce/server";
import { commerceCustomerDefaultsSnapshotSchema } from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { CommerceCustomerDefaultsReadPort } from "../../../src/domains/commerce/ports.js";
import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
export function readCheckoutCustomerDefaults(input: { port: CommerceCustomerDefaultsReadPort | undefined; clientId: string; checkoutKind: CheckoutKind; recordStage: <T>(operation: () => Promise<T>) => Promise<T> }) { return read(input, commerceCustomerDefaultsSnapshotSchema); }

export function readCheckoutCustomerDefaultsOrRespond(input: Parameters<typeof readCheckoutCustomerDefaults>[0] & { res: VercelResponse }) { return readOrRespond(input, commerceCustomerDefaultsSnapshotSchema, bffResponder); }
