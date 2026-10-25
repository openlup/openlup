import * as managed from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export function readOrderPaidOutboxEvents(client: CommerceOmsClient, ...args: Parameters<typeof managed.readOrderPaidOutboxEvents> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readOrderPaidOutboxEvents(omsManagedStore(client), ...args); }
