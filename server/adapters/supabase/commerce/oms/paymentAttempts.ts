import * as managed from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export function readActivePaymentAttempts(client: CommerceOmsClient, ...args: Parameters<typeof managed.readActivePaymentAttempts> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readActivePaymentAttempts(omsManagedStore(client), ...args); }
